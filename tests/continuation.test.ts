import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "../src/config/load.js";
import { quotaInterruption, continuationReady, continuationSuffix } from "../src/domain/continuation.js";
import type { QuotaSnapshot } from "../src/domain/quota.js";
import type { TaskExecutor } from "../src/domain/ports.js";
import { ManualExecutionService } from "../src/executor/manual-service.js";
import { SqliteStore } from "../src/storage/sqlite-store.js";
import { ContinuationRepository } from "../src/storage/continuation-repository.js";
import { SqliteSchedulerRepository } from "../src/storage/scheduler-repository.js";
import { SqliteMonitorRepository } from "../src/storage/monitor-repository.js";
import { quotaStreamKey } from "../src/monitor/context.js";
import { codexConnectionKey } from "../src/adapters/codex/connection-key.js";
import { catalogScope } from "../src/adapters/codex/catalog.js";

const epoch = Date.parse("2026-10-27T00:00:00Z"), reset = epoch + 10000;
const account = { type: "chatgpt" as const, email: "user@example.test", workspaceId: null, planType: "plus" };
const policy = { limitId: "codex", quotaMaxAgeMs: 10000, reservePercent: 10 };
function quota(time = epoch, short = 100, weekly = 10, boundary = reset): QuotaSnapshot {
  return { source: "codex", account, fetchedAt: new Date(time).toISOString(), buckets: [{ id: "codex", name: null, planType: "plus", reachedType: null, windows: [
    { slot: "primary", durationMinutes: 300, usedPercent: short, remainingPercent: 100 - short, resetsAt: new Date(boundary).toISOString() },
    { slot: "secondary", durationMinutes: 10080, usedPercent: weekly, remainingPercent: 100 - weekly, resetsAt: new Date(reset + 86400000).toISOString() },
  ] }] };
}

test("U05: evidence requires a fresh real depleted window with authoritative reset; recovery needs every blocking window to advance", () => {
  const context = { threadId: "thread", turnId: "turn", connectionKey: "a".repeat(64), accountScope: "b".repeat(64) };
  const evidence = quotaInterruption(quota(), policy, new Date(epoch), context)!; assert.ok(evidence);
  for (const input of [{ ...quota(), source: "mock" }, quota(epoch, 99), quota(epoch - 10001), quota(epoch + 1)]) assert.equal(quotaInterruption(input as QuotaSnapshot, policy, new Date(epoch), context), null);
  const missing = quota(); missing.buckets[0]!.windows[0]!.resetsAt = null;
  assert.equal(quotaInterruption(missing, policy, new Date(epoch), context), null);
  assert.equal(continuationReady(evidence, quota(epoch + 1000, 10), policy, new Date(epoch + 1000)), false); // Percent recovery alone.
  assert.equal(continuationReady(evidence, quota(reset + 1000, 10, 100, reset + 100000), policy, new Date(reset + 1000)), false);
  assert.equal(continuationReady(evidence, quota(reset + 1000, 10, 10, reset + 100000), policy, new Date(reset + 1000)), true);
  assert.equal(continuationReady(evidence, quota(reset + 1000, 10, 10, reset + 100000), { ...policy, quotaReserves: { fiveHour: 100 } }, new Date(reset + 1000)), false);
  const both = quotaInterruption(quota(epoch, 100, 100), policy, new Date(epoch), context)!;
  assert.equal(continuationReady(both, quota(reset + 1000, 10, 10, reset + 100000), policy, new Date(reset + 1000)), false);
});

async function setup(enabled = true, maxAttempts = 3) {
  const dir = await mkdtemp(join(tmpdir(), "continuation-fixture-")), scenarioPath = join(dir, "scenario"), resetPath = join(dir, "reset"), trace = join(dir, "trace.jsonl");
  await writeFile(scenarioPath, "quota-terminal"); await writeFile(resetPath, "2000000000");
  let time = epoch;
  const clock = { now: () => new Date(time) }, config = await loadConfig("config/codex.example.json");
  config.storage.databasePath = join(dir, "state.sqlite");
  config.codex = { ...config.codex, executable: process.execPath, args: [resolve("tests/fixtures/fake-execution.mjs"), "--scenario-file", scenarioPath, "--quota-reset-file", resetPath, "--trace", trace, "--project", dir], requestTimeoutMs: 3000, shutdownTimeoutMs: 200 };
  const store = new SqliteStore(config.storage.databasePath, clock), scheduler = new SqliteSchedulerRepository(store.database, quotaStreamKey(config), "available", config, clock);
  const monitor = new SqliteMonitorRepository(store.database, quotaStreamKey(config), config, clock);
  await store.tasks.create({ id: "one", name: "One", enabled: true, priority: 10, projectDir: dir, promptFile: join(dir, "unused.md"), session: { mode: "new" },
    execution: { sandbox: "read-only", timeoutMs: 5000 }, quotaContinuation: { enabled, maxAttempts } }, "ORIGINAL SNAPSHOT");
  const origin = { connectionKey: codexConnectionKey(config.codex), account, cliVersion: "0.160.0-fixture" };
  let turn = 0;
  const fail: TaskExecutor = { async execute(_run, _signal, sink) {
    const turnId = `turn-${++turn}`;
    sink.origin(origin); sink.thread("thread-1"); sink.event("thread_ready", { model: "fixture-model" }); sink.submitted(); sink.turn(turnId);
    return { status: "failed", output: "partial", error: "CODEX_QUOTA_INTERRUPTED", quotaInterruption: quotaInterruption(quota(time, 100, 10, time + 10000), config, clock.now(), {
      threadId: "thread-1", turnId, connectionKey: origin.connectionKey, accountScope: catalogScope(config.codex, account) })! };
  } };
  return { dir, scenarioPath, resetPath, trace, config, store, scheduler, monitor, clock, fail,
    setTime(value: number) { time = value; },
    service(executor?: TaskExecutor) { return new ManualExecutionService(config, store, clock, executor); },
    async cleanup() { store.close(); await rm(dir, { recursive: true, force: true }); } };
}

test("U05: immutable root snapshot, unique child plan, exact suffix, explicit opt-in, max limit and stop-chain", async () => {
  const env = await setup(true, 2);
  try {
    const parent = await env.service(env.fail).runTask("one", new AbortController().signal);
    const child = (await env.store.runs.listByTask("one"))[1]!;
    assert.equal(parent.status, "failed"); assert.equal(child.status, "waiting_quota"); assert.equal(child.continuation?.parentTurnId, "turn-1");
    assert.equal(child.promptSnapshot, "ORIGINAL SNAPSHOT" + continuationSuffix); assert.equal(child.taskSnapshot.session.mode, "resume");
    assert.equal(env.scheduler.status().paused, true); assert.equal(env.scheduler.status().worker, null); // Manual failure never starts a worker.
    env.store.database.transaction(() => assert.equal(new ContinuationRepository(env.store.database, env.clock).planInside(parent, child.continuation!.evidence)?.id, child.id));
    assert.equal((await env.store.runs.listByTask("one")).length, 2);
    await assert.rejects(env.service(env.fail).start(child.id, new AbortController().signal), { code: "CONTINUATION_SCHEDULER_ONLY" });
    const task = (await env.store.tasks.get("one"))!; await env.store.tasks.update({ ...task, priority: 99, quotaContinuation: { enabled: false, maxAttempts: 0 } }, "EDITED LATER", 1);
    env.setTime(reset + 1000); env.scheduler.resume(); const token = env.scheduler.acquire();
    const update = env.monitor.record({ snapshot: quota(reset + 1000, 10, 10, reset + 100000) });
    const claim = env.scheduler.claimNext(token, update); assert.equal(claim.action, "run"); if (claim.action !== "run") throw new Error("Expected claim");
    await env.service(env.fail).executeClaimed(child.id, new AbortController().signal); env.scheduler.complete(token, child.id);
    const grandchild = (await env.store.runs.listByTask("one"))[2]!;
    assert.equal(grandchild.continuation?.attempt, 2); assert.equal(grandchild.promptSnapshot, "ORIGINAL SNAPSHOT" + continuationSuffix);
    assert.equal(grandchild.taskSnapshot.priority, 10); assert.equal(env.scheduler.status().paused, false);
    env.setTime(reset + 12000);
    const next = env.scheduler.claimNext(token, env.monitor.record({ snapshot: quota(reset + 12000, 10, 10, reset + 200000) }));
    assert.equal(next.action, "run"); await env.service(env.fail).executeClaimed(grandchild.id, new AbortController().signal); env.scheduler.complete(token, grandchild.id);
    assert.equal((await env.store.runs.listByTask("one")).length, 3); assert.equal(env.scheduler.status().paused, true);
    env.scheduler.release(token); await env.store.check();
    new ContinuationRepository(env.store.database, env.clock).stop(parent.id);
    assert.equal(env.store.database.connection.prepare("SELECT stopped FROM continuation_chains WHERE root_run_id=?").get(parent.id)?.stopped, 1);
  } finally { await env.cleanup(); }
});

test("U05: wait for confirmed reset, apply FIFO and shared mutex; changed account, stop and restart remain safe", async () => {
  const env = await setup();
  try {
    const parent = await env.service(env.fail).runTask("one", new AbortController().signal), child = (await env.store.runs.listByTask("one"))[1]!;
    env.scheduler.resume(); const token = env.scheduler.acquire();
    env.setTime(epoch + 1000);
    assert.equal(env.scheduler.claimNext(token, env.monitor.record({ snapshot: quota(epoch + 1000, 10) })).action, "wait");
    env.setTime(reset + 1000); const update = env.monitor.record({ snapshot: quota(reset + 1000, 10, 10, reset + 100000) });
    const task = (await env.store.tasks.get("one"))!; await env.store.tasks.create({ ...task, id: "manual" }, "manual");
    const manual = env.store.execution.claimNew("manual"); assert.deepEqual(env.scheduler.claimNext(token, update), { action: "wait", reason: "busy" });
    env.store.execution.release(manual.id); await env.store.runs.update(manual.id, { status: "cancelled" }, "running");
    const other = structuredClone(update.state.snapshot!); other.account!.email = "another@example.test";
    assert.equal(env.scheduler.claimNext(token, env.monitor.record({ snapshot: other })).action, "wait"); assert.equal(env.scheduler.status().paused, true);
    assert.equal((await env.store.runs.get(child.id))?.status, "waiting_quota");
    new ContinuationRepository(env.store.database, env.clock).stop(parent.id); assert.equal((await env.store.runs.get(child.id))?.status, "cancelled");
    env.scheduler.release(token);
    const reopened = new SqliteStore(env.config.storage.databasePath, env.clock);
    try { const restarted = new SqliteSchedulerRepository(reopened.database, quotaStreamKey(env.config), "available", env.config, env.clock); assert.equal(restarted.status().paused, true); assert.equal(restarted.status().queue.length, 1); await reopened.check(); }
    finally { reopened.close(); }
  } finally { await env.cleanup(); }
});

for (const [scenario, expected] of [["quota-terminal", true], ["quota-terminal-rate", false], ["quota-terminal-no-evidence", false], ["quota-intermediate-success", false], ["lost-submission", false]] as const) {
  test(`U05 protocol fixture: ${scenario} only exact terminal usage failure plus real depletion creates a plan`, async () => {
    const env = await setup();
    try {
      await writeFile(env.scenarioPath, scenario); const run = await env.service().runTask("one", new AbortController().signal);
      const records = await env.store.runs.listByTask("one"); assert.equal(records.length, expected ? 2 : 1);
      assert.ok(!JSON.stringify(records).includes("PRIVATE_QUOTA_BODY"));
      if (expected) { assert.equal(run.status, "failed"); assert.equal(records[1]?.continuation?.parentTurnId, "turn-1"); }
      if (scenario === "quota-intermediate-success") assert.equal(run.status, "succeeded");
      if (scenario === "lost-submission") assert.equal(run.status, "needs_attention");
    } finally { await env.cleanup(); }
  });
}

for (const [scenario, expected] of [["continuation-success", "succeeded"], ["continuation-conflict", "failed"], ["continuation-busy", "failed"]] as const) {
  test(`U05 exact thread/parent check before sending: ${scenario}`, async () => {
    const env = await setup();
    try {
      await env.service().runTask("one", new AbortController().signal); const child = (await env.store.runs.listByTask("one"))[1]!;
      env.setTime(2000000000000 + 1000); await writeFile(env.resetPath, "2000003600"); await writeFile(env.scenarioPath, scenario);
      const available = quota(env.clock.now().getTime(), 10, 10, 2000003600000); available.buckets[0]!.windows[1]!.resetsAt = new Date(2000003600000).toISOString();
      env.scheduler.resume(); const token = env.scheduler.acquire(); const decision = env.scheduler.claimNext(token, env.monitor.record({ snapshot: available })); assert.equal(decision.action, "run");
      const result = await env.service().executeClaimed(child.id, new AbortController().signal); assert.equal(result.status, expected);
      const requests = (await readFile(env.trace, "utf8")).trim().split("\n").map(line => JSON.parse(line) as { method: string; params: Record<string, unknown> });
      assert.equal(requests.filter(item => item.method === "turn/start").length, scenario === "continuation-success" ? 2 : 1);
      assert.equal(requests.filter(item => item.method === "thread/resume").length, scenario === "continuation-success" ? 1 : 0);
      if (scenario === "continuation-success") assert.deepEqual(requests.filter(item => item.method === "turn/start")[1]?.params.input, [{ type: "text", text: "ORIGINAL SNAPSHOT" + continuationSuffix }]);
      env.scheduler.complete(token, child.id); env.scheduler.release(token);
    } finally { await env.cleanup(); }
  });
}

test("U05: failed atomic plan write retains execution lock and unfinalized status; no partial child survives", async () => {
  const env = await setup();
  try {
    env.store.database.connection.exec("CREATE TRIGGER fail_plan BEFORE INSERT ON continuation_plans BEGIN SELECT RAISE(ABORT,'fixture-write-failure'); END;");
    await assert.rejects(env.service(env.fail).runTask("one", new AbortController().signal));
    const runs = await env.store.runs.listByTask("one"); assert.equal(runs.length, 1); assert.equal(runs[0]?.status, "running");
    assert.equal(env.store.execution.active()?.runId, runs[0]?.id); assert.equal(env.scheduler.status().queue.length, 0);
  } finally { await env.cleanup(); }
});

for (const [enabled, maximum] of [[false, 3], [true, 0]] as const) {
  test(`U05: opt-in=${enabled}, maximum=${maximum} never creates an unauthorized child`, async () => {
    const env = await setup(enabled, maximum);
    try { await env.service(env.fail).runTask("one", new AbortController().signal); assert.equal((await env.store.runs.listByTask("one")).length, 1); }
    finally { await env.cleanup(); }
  });
}

test("U05: continuation and explicit queue share priority/FIFO; unknown submission pauses without creating another child", async () => {
  const env = await setup();
  try {
    const task = (await env.store.tasks.get("one"))!;
    await env.store.tasks.create({ ...task, id: "earlier" }, "earlier"); const earlier = env.scheduler.enqueue("earlier");
    await env.service(env.fail).runTask("one", new AbortController().signal); const child = (await env.store.runs.listByTask("one"))[1]!;
    await env.store.tasks.create({ ...task, id: "later" }, "later"); env.scheduler.enqueue("later");
    env.setTime(reset + 1000); env.scheduler.resume(); const token = env.scheduler.acquire(); const update = env.monitor.record({ snapshot: quota(reset + 1000, 10, 10, reset + 100000) });
    assert.equal((env.scheduler.claimNext(token, update) as { run?: { id: string } }).run?.id, earlier.id);
    await env.service({ async execute() { return { status: "succeeded", output: "done", error: null }; } }).executeClaimed(earlier.id, new AbortController().signal); env.scheduler.complete(token, earlier.id);
    assert.equal((env.scheduler.claimNext(token, update) as { run?: { id: string } }).run?.id, child.id);
    await env.service({ async execute(_run, _signal, sink) { sink.submitted(); return { status: "needs_attention", output: "partial", error: "SUBMISSION_UNKNOWN" }; } }).executeClaimed(child.id, new AbortController().signal);
    env.scheduler.complete(token, child.id); assert.equal(env.scheduler.status().paused, true);
    assert.equal((await env.store.runs.listByTask("one")).length, 2); assert.equal(env.scheduler.claimNext(token, update).action, "wait"); env.scheduler.release(token);
  } finally { await env.cleanup(); }
});
