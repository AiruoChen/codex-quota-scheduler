import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { codexConnectionKey } from "../src/adapters/codex/connection-key.js";
import { CodexRecoveryReader } from "../src/adapters/codex/recovery-reader.js";
import { loadConfig } from "../src/config/load.js";
import type { ProcessInspector, RemoteRecoveryResult } from "../src/domain/recovery.js";
import type { TaskRun } from "../src/domain/task.js";
import { ManualExecutionService } from "../src/executor/manual-service.js";
import { RecoveryService } from "../src/recovery/service.js";
import { SqliteRecoveryRepository } from "../src/storage/recovery-repository.js";
import { SqliteSchedulerRepository } from "../src/storage/scheduler-repository.js";
import { SqliteStore } from "../src/storage/sqlite-store.js";

const clock = { now: () => new Date("2026-10-21T00:00:00Z") };
async function setup(scenario = "completed") {
  const dir = await mkdtemp(join(tmpdir(), "recovery 中文 &-"));
  const trace = join(dir, "trace.jsonl");
  const config = await loadConfig("config/codex.example.json"); config.storage.databasePath = join(dir, "state.sqlite");
  config.codex = { ...config.codex, executable: process.execPath, args: [resolve("tests/fixtures/fake-recovery.mjs"), "--scenario", scenario, "--trace", trace, "--project", dir], requestTimeoutMs: scenario === "timeout" ? 500 : 3000, shutdownTimeoutMs: 200 };
  const store = new SqliteStore(config.storage.databasePath, clock);
  await store.tasks.create({ id: "one", name: "One", enabled: true, projectDir: dir, promptFile: join(dir, "unused.md"), priority: 1, session: { mode: "new" } }, "immutable instruction");
  const run = store.execution.claimNew("one");
  store.execution.origin(run.id, { connectionKey: codexConnectionKey(config.codex), account: { type: "chatgpt", email: "user@example.test", planType: "plus", workspaceId: null }, cliVersion: "fixture" });
  store.execution.progress(run.id, { threadId: "thread-target", turnId: "turn-target", output: "old partial" });
  store.execution.event(run.id, "submission_started", {});
  await store.runs.update(run.id, { status: "needs_attention", error: "CONFIRMATION_LOST" }, "running"); store.execution.release(run.id);
  const repo = new SqliteRecoveryRepository(store.database, clock);
  const reader = new CodexRecoveryReader(config.codex);
  const service = new RecoveryService(repo, reader, { provider: "codex", persistent: true });
  return { dir, trace, config, store, run, repo, reader, service, async cleanup() { store.close(); await rm(dir, { recursive: true, force: true }); } };
}
const terminal: RemoteRecoveryResult = { kind: "terminal", code: "TURN_CONFIRMED", turnStatus: "completed", output: "verified", completedAt: null };

for (const scenario of ["completed", "paging", "items-paging", "legacy", "failed", "interrupted"]) test(`${scenario}：只读匹配原回合，恢复终态和输出并保持暂停`, async () => {
  const env = await setup(scenario);
  try {
    const recovered = await env.service.reconcile(env.run.id);
    assert.equal(recovered.result.kind, "terminal");
    assert.equal(recovered.run.status, scenario === "failed" ? "failed" : scenario === "interrupted" ? "cancelled" : "succeeded");
    assert.equal(recovered.run.promptSnapshot, "immutable instruction");
    assert.equal(recovered.run.threadId, "thread-target"); assert.equal(recovered.run.turnId, "turn-target");
    assert.ok(recovered.run.output.includes("recovered reply"));
    assert.ok(!recovered.run.output.includes("private-token-value")); assert.ok(!recovered.run.output.includes("sk-123"));
    assert.ok(!recovered.run.output.includes("reasoning")); assert.ok(!recovered.run.output.includes("progress"));
    assert.equal(env.store.database.connection.prepare("SELECT paused FROM scheduler_control").get()?.paused, 1);
    const events = (await readFile(env.trace, "utf8")).trim().split("\n").map((line: string) => JSON.parse(line) as { method?: string; pid?: number });
    assert.ok(events.every((event) => !event.method || ["initialize", "initialized", "account/read", "thread/read", "thread/turns/list", "thread/items/list"].includes(event.method)));
    assert.throws(() => process.kill(events[0]!.pid!, 0));
    assert.equal(env.repo.events(env.run.id).at(-1)?.data.code, "TURN_CONFIRMED");
    await env.store.check();
  } finally { await env.cleanup(); }
});

for (const [scenario, code] of [["active-thread", "THREAD_ACTIVE"], ["active-turn", "TURN_ACTIVE"], ["not-found", "TURN_NOT_FOUND"],
  ["summary", "TURN_ITEMS_INCOMPLETE"], ["status-unknown", "TURN_STATUS_UNKNOWN"], ["account-mismatch", "ACCOUNT_MISMATCH"],
  ["account-change", "ACCOUNT_CHANGED"], ["thread-mismatch", "THREAD_MISMATCH"], ["project-mismatch", "PROJECT_MISMATCH"],
  ["cursor-loop", "HISTORY_CURSOR_ERROR"], ["page-limit", "HISTORY_PAGE_LIMIT"], ["private-error", "CODEX_RPC_ERROR"], ["timeout", "CODEX_TIMEOUT"], ["items-scope", "HISTORY_SCOPE_MISMATCH"]] as const) {
  test(`${scenario}：证据不足保留 needs_attention 和部分输出`, async () => {
    const env = await setup(scenario);
    try {
      const result = await env.service.reconcile(env.run.id);
      assert.equal(result.result.code, code); assert.equal(result.run.status, "needs_attention"); assert.equal(result.run.output, "old partial");
      assert.ok(!JSON.stringify(result).includes("private-debug-secret"));
    } finally { await env.cleanup(); }
  });
}

test("失去启动确认时没有回合 ID，不猜测最新回合；旧记录缺少来源同样保留待核对", async () => {
  const env = await setup();
  try {
    const saved = (await env.store.runs.get(env.run.id))!;
    env.store.database.connection.prepare("UPDATE runs SET data_json=? WHERE id=?").run(JSON.stringify({ ...saved, turnId: null }), saved.id);
    assert.equal((await env.service.reconcile(saved.id)).result.code, "TURN_ID_UNKNOWN");
    env.store.database.connection.prepare("DELETE FROM execution_origins WHERE run_id=?").run(saved.id);
    assert.equal((await env.service.reconcile(saved.id)).result.code, "ORIGIN_UNKNOWN");
    assert.equal(await readFile(env.trace, "utf8").catch(() => ""), "");
  } finally { await env.cleanup(); }
});

test("连接位置不匹配、模拟或内存配置不能确认真实结果", async () => {
  const env = await setup();
  try {
    const wrong = new RecoveryService(env.repo, new CodexRecoveryReader({ ...env.config.codex, home: join(env.dir, "other-home") }), { provider: "codex", persistent: true });
    assert.equal((await wrong.reconcile(env.run.id)).result.code, "CONNECTION_MISMATCH");
    for (const options of [{ provider: "mock" as const, persistent: true }, { provider: "codex" as const, persistent: false }]) {
      await assert.rejects(new RecoveryService(env.repo, env.reader, options).reconcile(env.run.id), { code: "RECOVERY_REQUIRES_CODEX" });
    }
  } finally { await env.cleanup(); }
});

test("inspect 不修改本地记录或写恢复日志；重复 reconcile 不覆写已确认终态", async () => {
  const env = await setup();
  try {
    assert.equal((await env.service.inspect(env.run.id)).result.kind, "terminal");
    assert.equal((await env.store.runs.get(env.run.id))?.status, "needs_attention"); assert.equal(env.repo.events().length, 0);
    await env.service.reconcile(env.run.id);
    await assert.rejects(env.service.reconcile(env.run.id), { code: "RECOVERY_NOT_ATTENTION" });
  } finally { await env.cleanup(); }
});

test("恢复超时中断保留 timeout 语义，部分输出不改变任务快照", async () => {
  const env = await setup("interrupted");
  try {
    env.store.execution.event(env.run.id, "interrupt_requested", { reason: "timeout" });
    const { run } = await env.service.reconcile(env.run.id);
    assert.equal(run.status, "failed"); assert.match(run.error!, /EXECUTION_TIMEOUT/);
  } finally { await env.cleanup(); }
});

test("确认终态但历史无消息时保留已有部分输出；新的未知结果撤销旧核对确认", async () => {
  const env = await setup();
  try {
    const scheduler = new SqliteSchedulerRepository(env.store.database, "stream", "available", env.config, clock);
    scheduler.acknowledge(env.run.id);
    env.repo.apply(env.repo.target(env.run.id), { kind: "pending", code: "TURN_ACTIVE" });
    assert.ok(scheduler.status().attention.includes(env.run.id));
    const run = env.repo.apply(env.repo.target(env.run.id), { ...terminal, output: "" });
    assert.equal(run.status, "succeeded"); assert.equal(run.output, "old partial");
    assert.equal(env.store.execution.events(run.id).at(-1)?.data.outputSource, "existing_partial");
  } finally { await env.cleanup(); }
});

test("开始核对前暂停队列并撤销过时确认，不在网络查询期间继续自动派发", async () => {
  const env = await setup();
  try {
    const scheduler = new SqliteSchedulerRepository(env.store.database, "stream", "available", env.config, clock);
    scheduler.acknowledge(env.run.id); scheduler.resume();
    const service = new RecoveryService(env.repo, { async read() {
      assert.equal(scheduler.status().paused, true);
      assert.ok(scheduler.status().attention.includes(env.run.id));
      assert.throws(() => scheduler.resume(), { code: "SCHEDULER_NEEDS_ATTENTION" });
      return { kind: "pending", code: "TURN_ACTIVE" };
    } }, { provider: "codex", persistent: true });
    assert.equal((await service.reconcile(env.run.id)).run.status, "needs_attention");
  } finally { await env.cleanup(); }
});

test("核对期间本地状态变化、执行权重新出现或事务失败均不覆盖旧数据", async () => {
  const env = await setup();
  try {
    const target = env.repo.target(env.run.id);
    await env.store.runs.update(env.run.id, { status: "needs_attention", output: "newer partial" }, "needs_attention");
    assert.throws(() => env.repo.apply(target, terminal), { code: "RECOVERY_CONFLICT" });
    const current = env.repo.target(env.run.id);
    env.store.database.connection.prepare("INSERT INTO execution_lock(singleton,run_id,owner_pid) VALUES (1,?,?)").run(env.run.id, process.pid);
    assert.throws(() => env.repo.apply(current, terminal), { code: "EXECUTION_BUSY" });
    env.store.database.connection.exec("DELETE FROM execution_lock; CREATE TRIGGER fail_recovery BEFORE INSERT ON execution_events WHEN NEW.type='recovery_confirmed' BEGIN SELECT RAISE(ABORT,'simulated failure'); END");
    assert.throws(() => env.repo.apply(current, terminal));
    assert.equal((await env.store.runs.get(env.run.id))?.output, "newer partial"); assert.equal(env.repo.events().length, 0);
  } finally { await env.cleanup(); }
});

test("取消远端读取不应用结果，也不转成成功的空恢复", async () => {
  const env = await setup("timeout");
  try {
    const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 50);
    try { await assert.rejects(env.service.reconcile(env.run.id, controller.signal), { code: "RECOVERY_STOPPED" }); }
    finally { clearTimeout(timeout); }
    assert.equal(env.repo.events().length, 0); assert.equal((await env.store.runs.get(env.run.id))?.status, "needs_attention");
  } finally { await env.cleanup(); }
});

test("启动检测和显式 repair 处理死进程、无锁 running、提交证据冲突；不自动重排", async () => {
  const env = await setup();
  try {
    const scheduler = new SqliteSchedulerRepository(env.store.database, "stream", "available", env.config, clock);
    scheduler.acknowledge(env.run.id); scheduler.resume();
    const claimed = env.store.execution.claimNew("one");
    const token = scheduler.acquire();
    env.store.database.connection.exec("UPDATE scheduler_worker SET owner_pid=2147483647; UPDATE execution_lock SET owner_pid=2147483647");
    assert.throws(() => scheduler.acquire(), { code: "RECOVERY_REQUIRED" });
    const repair = env.repo.repair(); assert.ok(repair.actions.some((action) => action.code === "scheduler_released"));
    assert.equal((await env.store.runs.get(claimed.id))?.status, "needs_attention");
    assert.equal(scheduler.status().paused, true); assert.equal(scheduler.status().worker, null);
    assert.equal(env.repo.repair().actions.length, 0);
    const orphan = await env.store.runs.create("one"); await env.store.runs.update(orphan.id, { status: "running" }, "queued");
    const submitted = await env.store.runs.create("one"); env.store.execution.event(submitted.id, "submission_started", {});
    assert.throws(() => env.store.execution.claimNew("one"), { code: "RECOVERY_REQUIRED" });
    const fixed = env.repo.repair(); assert.ok(fixed.actions.some((action) => action.code === "orphan_running"));
    assert.equal((await env.store.runs.get(submitted.id))?.status, "needs_attention");
    assert.ok(env.repo.report().issues.every((issue) => issue.code === "needs_attention"));
    assert.ok(env.repo.events().length > 0); scheduler.release(token);
  } finally { await env.cleanup(); }
});

test("存活、PID 复用或无权判断时保留执行权，不按时间抢占", async () => {
  const env = await setup();
  try {
    env.store.execution.claimNew("one");
    for (const state of ["alive", "unknown"] as const) {
      const processes: ProcessInspector = { inspect: () => state };
      const repo = new SqliteRecoveryRepository(env.store.database, clock, processes);
      assert.equal(repo.repair().actions.length, 0);
      assert.equal(env.store.database.connection.prepare("SELECT count(*) AS n FROM execution_lock").get()?.n, 1);
    }
  } finally { await env.cleanup(); }
});

test("终态遗留锁只清理死进程锁，不回退终态；坏来源数据不被重建", async () => {
  const env = await setup();
  try {
    env.repo.apply(env.repo.target(env.run.id), terminal);
    env.store.database.connection.prepare("INSERT INTO execution_lock(singleton,run_id,owner_pid) VALUES (1,?,2147483647)").run(env.run.id);
    env.repo.repair(); assert.equal((await env.store.runs.get(env.run.id))?.status, "succeeded");
    env.store.database.connection.exec("UPDATE execution_origins SET data_json='{}'");
    await assert.rejects(env.store.check(), { code: "STORAGE_INVALID" });
    assert.throws(() => env.repo.target(env.run.id), { code: "STORAGE_INVALID" });
  } finally { await env.cleanup(); }
});

test("repair 保存失败整体回滚；不一致的运行 ID 阻止恢复而不覆盖数据", async () => {
  const env = await setup();
  try {
    const run = env.store.execution.claimNew("one");
    env.store.database.connection.exec("UPDATE execution_lock SET owner_pid=2147483647; CREATE TRIGGER fail_repair BEFORE INSERT ON recovery_events WHEN NEW.type='execution_released' BEGIN SELECT RAISE(ABORT,'simulated failure'); END");
    assert.throws(() => env.repo.repair());
    assert.equal((await env.store.runs.get(run.id))?.status, "running");
    assert.equal(env.store.database.connection.prepare("SELECT owner_pid FROM execution_lock").get()?.owner_pid, 2147483647);
    assert.equal(env.repo.events().length, 0);
    env.store.database.connection.exec("DROP TRIGGER fail_repair"); env.repo.repair();
    const current = (await env.store.runs.get(run.id))!;
    env.store.database.connection.prepare("UPDATE runs SET data_json=? WHERE id=?").run(JSON.stringify({ ...current, id: "wrong-id" }), run.id);
    assert.throws(() => env.repo.report(), { code: "STORAGE_INVALID" });
    assert.throws(() => env.repo.target(run.id), { code: "STORAGE_INVALID" });
    await assert.rejects(env.store.check(), { code: "STORAGE_INVALID" });
  } finally { await env.cleanup(); }
});

test("真实执行入口保存来源；跨进程 CLI 可只读核对并恢复，不启动新回合", async () => {
  const env = await setup();
  try {
    const configPath = join(env.dir, "config.json"); await writeFile(configPath, JSON.stringify(env.config));
    const cli = (...args: string[]) => {
      const child = spawnSync(process.execPath, ["--experimental-sqlite", resolve("dist/src/cli.js"), "recovery", ...args, "--config", configPath], { encoding: "utf8", timeout: 15000 });
      assert.equal(child.status, 0, child.stderr); return JSON.parse(child.stdout);
    };
    assert.ok(cli("status").issues.some((issue: { code: string }) => issue.code === "needs_attention"));
    assert.equal(cli("inspect", env.run.id).result.kind, "terminal");
    assert.equal(cli("reconcile", env.run.id).run.status, "succeeded");
    assert.ok(cli("events", env.run.id).length > 0);
    env.config.codex.args = [resolve("tests/fixtures/fake-execution.mjs"), "--project", env.dir];
    const service = new ManualExecutionService(env.config, env.store, clock);
    const run: TaskRun = await service.runTask("one", new AbortController().signal);
    assert.equal(run.status, "succeeded"); assert.ok(env.repo.target(run.id).origin?.connectionKey);
  } finally { await env.cleanup(); }
});
