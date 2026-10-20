import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { normalizeQuota } from "../src/adapters/codex/normalize-quota.js";
import { loadConfig, parseConfig } from "../src/config/load.js";
import type { TaskExecutor } from "../src/domain/ports.js";
import type { QuotaSnapshot } from "../src/domain/quota.js";
import type { SchedulerEvent, SchedulerTrigger } from "../src/domain/scheduler.js";
import type { TaskDefinition } from "../src/domain/task.js";
import { ManualExecutionService } from "../src/executor/manual-service.js";
import { ContinuousQuotaMonitor } from "../src/monitor/continuous-monitor.js";
import { SchedulerService } from "../src/scheduler/service.js";
import { SqliteMonitorRepository } from "../src/storage/monitor-repository.js";
import { SqliteSchedulerRepository } from "../src/storage/scheduler-repository.js";
import { SqliteStore } from "../src/storage/sqlite-store.js";

const epoch = Date.parse("2026-10-20T00:00:00Z");
async function setup(trigger: SchedulerTrigger = "available", scenario = "success") {
  const dir = await mkdtemp(join(tmpdir(), "auto-scheduler 中文 &-"));
  const config = await loadConfig("config/codex.example.json");
  config.storage.databasePath = join(dir, "state.sqlite"); config.pollIntervalMs = 1000; config.scheduler = { trigger };
  const trace = join(dir, "trace.jsonl");
  config.codex = { ...config.codex, executable: process.execPath,
    args: [resolve("tests/fixtures/fake-execution.mjs"), "--scenario", scenario, "--trace", trace, "--project", dir], requestTimeoutMs: 3000, shutdownTimeoutMs: 200 };
  let time = epoch;
  const clock = { now: () => new Date(time) };
  const store = new SqliteStore(config.storage.databasePath, clock);
  const monitorRepo = new SqliteMonitorRepository(store.database, "test-stream", config, clock);
  const repo = new SqliteSchedulerRepository(store.database, "test-stream", trigger, config, clock);
  function quota(used = 10, weekly = 10, reset = epoch + 3600000): QuotaSnapshot {
    return { ...normalizeQuota({ rateLimitsByLimitId: { codex: {
      primary: { usedPercent: used, windowDurationMins: 300, resetsAt: reset / 1000 },
      secondary: { usedPercent: weekly, windowDurationMins: 10080, resetsAt: (epoch + 86400000) / 1000 },
    } } }, clock.now(), "codex"), account: { type: "chatgpt", email: "user@example.test", planType: "plus", workspaceId: null } };
  }
  async function add(id: string, priority = 1) {
    const task: TaskDefinition = { id, name: id, enabled: true, projectDir: dir, promptFile: join(dir, "unused.md"), priority,
      session: { mode: "new" }, execution: { sandbox: "read-only", timeoutMs: 5000 } };
    return store.tasks.create(task, `snapshot for ${id}`);
  }
  function service(executor?: TaskExecutor, provider = { read: async () => quota() }) {
    const monitor = new ContinuousQuotaMonitor(provider, monitorRepo, clock, { async sleep(ms) { time += ms; } });
    return new SchedulerService(repo, monitor, new ManualExecutionService(config, store, clock, executor), { provider: config.provider, persistent: true });
  }
  return { dir, config, trace, clock, store, repo, monitorRepo, quota, add, service,
    advance(ms: number) { time += ms; }, async cleanup() { store.close(); await rm(dir, { recursive: true, force: true }); } };
}

const success: TaskExecutor = { async execute(run, _signal, sink) { sink.submitted(); return { status: "succeeded", output: run.promptSnapshot, error: null }; } };

test("旧配置兼容 available，错误触发模式不能静默放行", async () => {
  const config = await loadConfig("config/codex.example.json");
  assert.equal(config.scheduler?.trigger, "available");
  assert.equal(parseConfig({ ...config, scheduler: { trigger: "refresh" } }, "config/local.json").scheduler?.trigger, "refresh");
  for (const trigger of [null, false, "invalid", 1]) assert.throws(() => parseConfig({ ...config, scheduler: { trigger } }, "config/local.json"), { code: "INVALID_CONFIG" });
});

test("显式入队、版本去重及快照不变，手动 prepared 记录不会自动入队", async () => {
  const env = await setup();
  try {
    await env.add("one"); await env.add("manual");
    await env.store.runs.create("manual");
    const run = env.repo.enqueue("one");
    assert.equal(env.repo.enqueue("one").id, run.id);
    const task = (await env.store.tasks.get("one"))!;
    await env.store.tasks.update({ ...task, priority: 20 }, "edited prompt", 1);
    assert.equal((await env.store.runs.get(run.id))?.promptSnapshot, "snapshot for one");
    const second = env.repo.enqueue("one");
    assert.notEqual(second.id, run.id); assert.equal(second.taskRevision, 2);
    assert.equal(env.repo.status().queue.length, 2);
    await env.store.check();
  } finally { await env.cleanup(); }
});

test("默认暂停；恢复后按快照优先级和同优先级 FIFO 串行执行", async () => {
  const env = await setup();
  try {
    for (const id of ["low", "high-first", "high-second"]) { await env.add(id, id === "low" ? 1 : 10); env.repo.enqueue(id); }
    const events: SchedulerEvent[] = [];
    await env.service(success).run(new AbortController().signal, (event) => { events.push(event); }, 1);
    assert.deepEqual(events, [{ event: "scheduler_wait", reason: "paused" }]);
    env.repo.resume();
    const order: string[] = []; let active = 0; let maximum = 0;
    const executor: TaskExecutor = { async execute(run, _signal, sink) {
      active++; maximum = Math.max(maximum, active); order.push(run.taskId); sink.submitted(); await delay(5); active--;
      return { status: "succeeded", output: "done", error: null };
    } };
    await env.service(executor).run(new AbortController().signal, () => {}, 4);
    assert.deepEqual(order, ["high-first", "high-second", "low"]); assert.equal(maximum, 1);
    assert.ok(env.repo.status().queue.every((entry) => entry.status === "succeeded"));
    assert.equal(env.repo.status().worker, null);
  } finally { await env.cleanup(); }
});

test("周额度、保留阈值、未知窗口和模拟来源不能放行自动执行", async () => {
  const env = await setup();
  try {
    await env.add("one"); env.repo.enqueue("one"); env.repo.resume();
    const token = env.repo.acquire();
    for (const snapshot of [env.quota(0, 100), env.quota(95), { ...env.quota(), source: "mock" as const }, { ...env.quota(), buckets: [] }]) {
      const update = env.monitorRepo.record({ snapshot });
      assert.equal(env.repo.claimNext(token, update).action, "wait");
    }
    assert.equal(env.repo.status().queue[0]?.status, "queued"); env.repo.release(token);
    assert.equal(await readFile(env.trace, "utf8").catch(() => ""), "");
  } finally { await env.cleanup(); }
});

test("缺失已知周窗口、陈旧快照和其他进程更新的快照均不能调度", async () => {
  const env = await setup();
  try {
    await env.add("one"); env.repo.enqueue("one"); env.repo.resume(); const token = env.repo.acquire();
    const original = env.monitorRepo.record({ snapshot: env.quota() });
    env.advance(1000); const missing = env.quota(); missing.buckets[0]!.windows.pop();
    const update = env.monitorRepo.record({ snapshot: missing });
    assert.deepEqual(env.repo.claimNext(token, original), { action: "wait", reason: "snapshot_changed" });
    assert.deepEqual(env.repo.claimNext(token, update), { action: "wait", reason: "missing_window" });
    const fresh = env.monitorRepo.record({ snapshot: env.quota() }); env.advance(120001);
    assert.deepEqual(env.repo.claimNext(token, fresh), { action: "wait", reason: "stale_quota" });
    env.repo.release(token);
  } finally { await env.cleanup(); }
});

test("停用、归档和显式移除的任务被跳过，移除记录不会再次入队", async () => {
  const env = await setup();
  try {
    for (const id of ["disabled", "archived", "removed"]) { await env.add(id); env.repo.enqueue(id); }
    const disabled = (await env.store.tasks.get("disabled"))!;
    await env.store.tasks.update({ ...disabled, enabled: false }, disabled.promptSnapshot, 1);
    await env.store.tasks.remove("archived", 1);
    const id = env.repo.status().queue.find((entry) => entry.taskId === "removed")!.runId;
    assert.equal(env.repo.remove(id).status, "cancelled"); assert.equal(env.repo.enqueue("removed").id, id);
    env.repo.resume(); const events: SchedulerEvent[] = [];
    await env.service(success).run(new AbortController().signal, (event) => { events.push(event); }, 1);
    assert.equal(events[0]?.reason, "empty_queue");
  } finally { await env.cleanup(); }
});

test("刷新模式不消费启动前的旧刷新，周额度阻塞时保留新触发", async () => {
  const env = await setup("refresh");
  try {
    await env.add("one"); await env.add("two"); env.repo.enqueue("one"); env.repo.enqueue("two"); env.repo.resume();
    env.monitorRepo.record({ snapshot: env.quota(100, 10, epoch + 1000) });
    env.advance(2000); env.monitorRepo.record({ snapshot: env.quota(0, 10, epoch + 3000) }); // historical reset
    const token = env.repo.acquire();
    let update = env.monitorRepo.record({ snapshot: env.quota(0, 10, epoch + 3000) });
    assert.deepEqual(env.repo.claimNext(token, update), { action: "wait", reason: "awaiting_refresh" });
    env.advance(2000); update = env.monitorRepo.record({ snapshot: env.quota(0, 100, epoch + 3600000) });
    assert.deepEqual(env.repo.claimNext(token, update), { action: "wait", reason: "quota_exhausted" });
    env.advance(1000); update = env.monitorRepo.record({ snapshot: env.quota(0, 10, epoch + 3600000) });
    const decision = env.repo.claimNext(token, update); assert.equal(decision.action, "run");
    if (decision.action !== "run") throw new Error("Expected run");
    await new ManualExecutionService(env.config, env.store, env.clock, success).executeClaimed(decision.run.id, new AbortController().signal);
    env.repo.complete(token, decision.run.id);
    assert.deepEqual(env.repo.claimNext(token, update), { action: "wait", reason: "refresh_consumed" });
    env.repo.release(token);
    const other = new SqliteStore(env.config.storage.databasePath, env.clock);
    try {
      const restarted = new SqliteSchedulerRepository(other.database, "test-stream", "refresh", env.config, env.clock);
      const secondToken = restarted.acquire();
      assert.deepEqual(restarted.claimNext(secondToken, update), { action: "wait", reason: "refresh_consumed" }); restarted.release(secondToken);
    } finally { other.close(); }
  } finally { await env.cleanup(); }
});

test("同一观察里的多个窗口刷新只提供一次触发", async () => {
  const env = await setup("refresh");
  try {
    await env.add("one"); await env.add("two"); env.repo.enqueue("one"); env.repo.enqueue("two"); env.repo.resume(); const token = env.repo.acquire();
    const initial = env.quota(100, 100, epoch + 1000); initial.buckets[0]!.windows[1]!.resetsAt = new Date(epoch + 1000).toISOString();
    env.repo.claimNext(token, env.monitorRepo.record({ snapshot: initial }));
    env.advance(2000); const update = env.monitorRepo.record({ snapshot: env.quota() });
    assert.equal(update.events.filter((event) => event.type === "quota_reset").length, 2);
    const decision = env.repo.claimNext(token, update); assert.equal(decision.action, "run");
    if (decision.action !== "run") throw new Error("Expected run");
    await new ManualExecutionService(env.config, env.store, env.clock, success).executeClaimed(decision.run.id, new AbortController().signal);
    env.repo.complete(token, decision.run.id);
    assert.equal(env.repo.claimNext(token, update).action, "wait"); env.repo.release(token);
  } finally { await env.cleanup(); }
});

test("预检查等待额度可重试同一记录，未发送指令不丢失刷新触发", async () => {
  const env = await setup("refresh");
  try {
    await env.add("one"); const run = env.repo.enqueue("one"); env.repo.resume(); const token = env.repo.acquire();
    env.repo.claimNext(token, env.monitorRepo.record({ snapshot: env.quota(100, 10, epoch + 1000) }));
    env.advance(2000); let update = env.monitorRepo.record({ snapshot: env.quota() });
    assert.equal(env.repo.claimNext(token, update).action, "run");
    const wait: TaskExecutor = { async execute() { return { status: "waiting_quota", output: "", error: "QUOTA_WAIT" }; } };
    await new ManualExecutionService(env.config, env.store, env.clock, wait).executeClaimed(run.id, new AbortController().signal);
    env.repo.complete(token, run.id); env.advance(1000); update = env.monitorRepo.record({ snapshot: env.quota() });
    const again = env.repo.claimNext(token, update); assert.equal(again.action, "run");
    if (again.action !== "run") throw new Error("Expected retry"); assert.equal(again.run.id, run.id);
    await new ManualExecutionService(env.config, env.store, env.clock, success).executeClaimed(run.id, new AbortController().signal);
    env.repo.complete(token, run.id); env.repo.release(token);
    assert.equal((await env.store.runs.listByTask("one")).length, 1);
  } finally { await env.cleanup(); }
});

test("账户或时钟变化撤销未使用的刷新触发", async () => {
  const env = await setup("refresh");
  try {
    await env.add("one"); env.repo.enqueue("one"); env.repo.resume(); const token = env.repo.acquire();
    env.repo.claimNext(token, env.monitorRepo.record({ snapshot: env.quota(100, 10, epoch + 1000) }));
    env.advance(2000); env.repo.claimNext(token, env.monitorRepo.record({ snapshot: env.quota(0, 100) }));
    env.advance(1000); const other = env.quota(); other.account!.email = "other@example.test";
    assert.deepEqual(env.repo.claimNext(token, env.monitorRepo.record({ snapshot: other })), { action: "wait", reason: "awaiting_refresh" });
    env.repo.release(token);
  } finally { await env.cleanup(); }
});

test("调度进程互斥且与手动执行共享执行权；同一执行权只能使用一次", async () => {
  const env = await setup();
  try {
    await env.add("one"); await env.add("manual"); env.repo.enqueue("one"); env.repo.resume(); const token = env.repo.acquire();
    const second = new SqliteStore(env.config.storage.databasePath, env.clock);
    try {
      const other = new SqliteSchedulerRepository(second.database, "test-stream", "available", env.config, env.clock);
      assert.throws(() => other.acquire(), { code: "SCHEDULER_BUSY" });
      const manual = env.store.execution.claimNew("manual");
      const update = env.monitorRepo.record({ snapshot: env.quota() });
      assert.deepEqual(env.repo.claimNext(token, update), { action: "wait", reason: "busy" });
      await new ManualExecutionService(env.config, env.store, env.clock, success).executeClaimed(manual.id, new AbortController().signal);
      const selected = env.repo.claimNext(token, update); assert.equal(selected.action, "run");
      if (selected.action !== "run") throw new Error("Expected run");
      const once = new ManualExecutionService(env.config, env.store, env.clock, success);
      await once.executeClaimed(selected.run.id, new AbortController().signal);
      await assert.rejects(once.executeClaimed(selected.run.id, new AbortController().signal), { code: "RUN_ALREADY_STARTED" });
    } finally { second.close(); env.repo.release(token); }
  } finally { await env.cleanup(); }
});

for (const scenario of ["success", "approval", "lost-submission", "quota-wait", "failure"]) test(`真实协议路径 ${scenario}：保存结果并按需暂停`, async () => {
  const env = await setup("available", scenario);
  try {
    await env.add("one"); const queued = env.repo.enqueue("one"); env.repo.resume();
    const events: SchedulerEvent[] = [];
    await env.service().run(new AbortController().signal, (event) => { events.push(event); }, 2);
    const run = (await env.store.runs.get(queued.id))!;
    const expected = scenario === "success" ? "succeeded" : scenario === "quota-wait" ? "waiting_quota" : scenario === "failure" ? "failed" : "needs_attention";
    assert.equal(run.status, expected);
    assert.equal(env.repo.status().paused, ["failed", "needs_attention"].includes(expected));
    const trace = (await readFile(env.trace, "utf8")).trim().split("\n").map((line: string) => JSON.parse(line) as { method?: string });
    assert.equal(trace.filter((request) => request.method === "turn/start").length, scenario === "quota-wait" ? 0 : 1);
    if (expected === "needs_attention") {
      assert.throws(() => env.repo.resume(), { code: "SCHEDULER_NEEDS_ATTENTION" });
      env.repo.acknowledge(run.id); env.repo.resume();
      await env.service().run(new AbortController().signal, () => {}, 1);
      assert.equal((await env.store.runs.get(run.id))?.status, "needs_attention");
    }
  } finally { await env.cleanup(); }
});

test("执行前账户与监控不同则未提交即失败并暂停", async () => {
  const env = await setup();
  try {
    await env.add("one"); const run = env.repo.enqueue("one"); env.repo.resume();
    await env.service(undefined, { async read() { const quota = env.quota(); quota.account!.email = "another@example.test"; return quota; } }).run(new AbortController().signal, () => {}, 1);
    assert.equal((await env.store.runs.get(run.id))?.status, "failed");
    assert.match((await env.store.runs.get(run.id))!.error!, /ACCOUNT_CHANGED/);
    assert.ok(!(await readFile(env.trace, "utf8")).includes('"method":"turn/start"'));
    assert.equal(env.repo.status().paused, true);
  } finally { await env.cleanup(); }
});

test("模拟配置和内存存储在取得执行权前被拒绝", async () => {
  const env = await setup();
  try {
    const monitor = { async run() { throw new Error("must not sample"); } };
    const execution = new ManualExecutionService(env.config, env.store, env.clock, success);
    await assert.rejects(new SchedulerService(env.repo, monitor, execution, { provider: "mock", persistent: true }).run(new AbortController().signal, () => {}, 1), { code: "SCHEDULER_REQUIRES_CODEX" });
    await assert.rejects(new SchedulerService(env.repo, monitor, execution, { provider: "codex", persistent: false }).run(new AbortController().signal, () => {}, 1), { code: "SCHEDULER_REQUIRES_STORAGE" });
    assert.equal(env.repo.status().worker, null);
  } finally { await env.cleanup(); }
});

test("停止恰逢回调写入失败时仍报错并暂停，不能伪装为正常取消", async () => {
  const env = await setup();
  const controller = new AbortController();
  try {
    const failure = new Error("simulated output failure");
    const monitor = { async run(_signal: AbortSignal, callback: Parameters<ContinuousQuotaMonitor["run"]>[1]) {
      try { await callback(env.monitorRepo.record({ snapshot: env.quota() })); } catch { /* simulate cancellation swallowing */ }
    } };
    const service = new SchedulerService(env.repo, monitor, new ManualExecutionService(env.config, env.store, env.clock, success), { provider: "codex", persistent: true });
    await assert.rejects(service.run(controller.signal, () => { controller.abort(); throw failure; }, 1), /simulated output failure/);
    assert.equal(env.repo.status().paused, true); assert.equal(env.repo.status().reason, "scheduler_error");
    assert.equal(env.repo.status().worker, null);
  } finally { await env.cleanup(); }
});

test("另一连接暂停后不领取下一项，停止调度会中断当前任务并释放进程权", async () => {
  const env = await setup("available", "hang");
  const other = new SqliteStore(env.config.storage.databasePath, env.clock);
  const controller = new AbortController();
  try {
    await env.add("one"); await env.add("two"); const first = env.repo.enqueue("one"); env.repo.enqueue("two"); env.repo.resume();
    const pending = env.service().run(controller.signal, () => {});
    let submitted = false;
    for (let attempt = 0; attempt < 200; attempt++) {
      if ((await readFile(env.trace, "utf8").catch(() => "")).includes('"method":"turn/start"')) { submitted = true; break; }
      await delay(25);
    }
    assert.equal(submitted, true);
    const second = new SqliteSchedulerRepository(other.database, "test-stream", "available", env.config, env.clock);
    second.pause(); controller.abort(); await pending;
    assert.equal((await env.store.runs.get(first.id))?.status, "cancelled");
    assert.equal(env.repo.status().queue.find((entry) => entry.taskId === "two")?.status, "queued");
    assert.equal(env.repo.status().worker, null); assert.equal(env.repo.status().paused, true);
    assert.equal(env.store.database.connection.prepare("SELECT count(*) AS n FROM execution_lock").get()?.n, 0);
  } finally { controller.abort(); other.close(); await env.cleanup(); }
});

test("刷新领取落盘失败不消费触发；重试只领取同一任务一次", async () => {
  const env = await setup("refresh");
  try {
    await env.add("one"); env.repo.enqueue("one"); env.repo.resume(); const token = env.repo.acquire();
    env.repo.claimNext(token, env.monitorRepo.record({ snapshot: env.quota(100, 10, epoch + 1000) }));
    env.advance(2000); const update = env.monitorRepo.record({ snapshot: env.quota() });
    env.store.database.connection.exec("CREATE TRIGGER fail_refresh BEFORE INSERT ON execution_events WHEN NEW.type='scheduler_claimed' BEGIN SELECT RAISE(ABORT,'simulated I/O failure'); END");
    assert.throws(() => env.repo.claimNext(token, update));
    assert.equal(env.repo.status().queue[0]?.status, "queued");
    env.store.database.connection.exec("DROP TRIGGER fail_refresh");
    const selected = env.repo.claimNext(token, update); assert.equal(selected.action, "run");
    assert.deepEqual(env.repo.claimNext(token, update), { action: "wait", reason: "busy" });
    if (selected.action !== "run") throw new Error("Expected run");
    await new ManualExecutionService(env.config, env.store, env.clock, success).executeClaimed(selected.run.id, new AbortController().signal);
    env.repo.complete(token, selected.run.id); env.repo.release(token);
  } finally { await env.cleanup(); }
});

test("崩溃恢复不清除任务执行权或重新提交已领取任务", async () => {
  const env = await setup();
  try {
    await env.add("one"); const queued = env.repo.enqueue("one"); env.repo.resume(); const token = env.repo.acquire();
    assert.equal(env.repo.claimNext(token, env.monitorRepo.record({ snapshot: env.quota() })).action, "run");
    assert.throws(() => env.repo.recover(), { code: "SCHEDULER_BUSY" });
    env.store.database.connection.exec("UPDATE scheduler_worker SET owner_pid=2147483647; UPDATE execution_lock SET owner_pid=2147483647");
    env.repo.recover(); assert.equal(env.repo.status().paused, true);
    env.store.execution.recover(queued.id);
    assert.throws(() => env.repo.resume(), { code: "SCHEDULER_NEEDS_ATTENTION" });
    env.repo.acknowledge(queued.id); env.repo.resume();
    await env.service(success).run(new AbortController().signal, () => {}, 1);
    assert.equal((await env.store.runs.get(queued.id))?.status, "needs_attention");
    assert.equal((await env.store.runs.listByTask("one")).length, 1);
  } finally { await env.cleanup(); }
});

test("提交证据与 queued 状态冲突时转人工核对，领取事务失败会整体回滚", async () => {
  const env = await setup();
  try {
    await env.add("one"); const run = env.repo.enqueue("one"); env.repo.resume(); const token = env.repo.acquire();
    const update = env.monitorRepo.record({ snapshot: env.quota() });
    env.store.database.connection.exec("CREATE TRIGGER fail_claim BEFORE INSERT ON execution_events WHEN NEW.type='scheduler_claimed' BEGIN SELECT RAISE(ABORT,'simulated write failure'); END");
    assert.throws(() => env.repo.claimNext(token, update));
    assert.equal((await env.store.runs.get(run.id))?.status, "queued");
    assert.equal(env.store.database.connection.prepare("SELECT count(*) AS n FROM execution_lock").get()?.n, 0);
    env.store.database.connection.exec("DROP TRIGGER fail_claim");
    env.store.execution.event(run.id, "submission_started", {});
    assert.deepEqual(env.repo.claimNext(token, update), { action: "wait", reason: "needs_attention" });
    assert.equal((await env.store.runs.get(run.id))?.status, "needs_attention"); env.repo.release(token);
  } finally { await env.cleanup(); }
});

test("CLI 跨进程入队、运行、暂停及恢复保留同一任务快照", async () => {
  const env = await setup();
  let child: ReturnType<typeof spawn> | undefined;
  try {
    await env.add("one");
    const configPath = join(env.dir, "config.json"); await writeFile(configPath, JSON.stringify({ ...env.config, tasksFile: join(env.dir, "missing.json") }));
    const args = ["--experimental-sqlite", resolve("dist/src/cli.js")];
    const cli = (...command: string[]) => {
      const result = spawnSync(process.execPath, [...args, ...command, "--config", configPath], { encoding: "utf8", timeout: 15000 });
      assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout);
    };
    // The CLI must not try to seed task files once this database is marked initialized.
    env.store.import([], true);
    const queued = cli("scheduler", "enqueue", "one") as { id: string };
    assert.equal(cli("scheduler", "enqueue", "one").id, queued.id);
    cli("scheduler", "resume");
    child = spawn(process.execPath, [...args, "scheduler", "start", "--samples", "2", "--config", configPath], { windowsHide: true });
    let text = ""; child.stdout!.on("data", (chunk: Buffer) => { text += chunk.toString(); }); child.stderr!.resume();
    const done = new Promise<number | null>((resolveDone, reject) => { child!.once("error", reject); child!.once("close", resolveDone); });
    assert.equal(await done, 0);
    assert.equal(cli("runs", "show", queued.id).status, "succeeded");
    assert.ok(text.includes("scheduler_finished"));
    assert.equal(cli("scheduler", "pause").paused, true);
    assert.equal(cli("scheduler", "status").queue.length, 1);
    assert.equal(cli("scheduler", "resume").paused, false);
    await env.store.check();
  } finally { child?.kill(); await env.cleanup(); }
});
