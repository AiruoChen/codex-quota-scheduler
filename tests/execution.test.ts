import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFileSync, spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config/load.js";
import type { TaskDefinition } from "../src/domain/task.js";
import { ManualExecutionService } from "../src/executor/manual-service.js";
import { SqliteStore } from "../src/storage/sqlite-store.js";

async function setup(scenario = "success", taskPatch: Partial<TaskDefinition> = {}) {
  const dir = await mkdtemp(join(tmpdir(), "execution 中文 &-"));
  const path = join(dir, "state.sqlite");
  const trace = join(dir, "trace.jsonl");
  const config = await loadConfig("config/codex.example.json");
  config.storage.databasePath = path;
  config.codex = { ...config.codex, executable: process.execPath,
    args: [resolve("tests/fixtures/fake-execution.mjs"), "--scenario", scenario, "--trace", trace, "--project", dir], requestTimeoutMs: 2000, shutdownTimeoutMs: 200 };
  const store = new SqliteStore(path);
  const definition: TaskDefinition = { id: "one", name: "One", enabled: true, projectDir: dir,
    promptFile: join(dir, "not-needed.md"), priority: 1, session: { mode: "new" }, ...taskPatch };
  await store.tasks.create(definition, "persisted instruction");
  const service = new ManualExecutionService(config, store);
  return { dir, trace, config, store, service, async cleanup() { store.close(); await rm(dir, { recursive: true, force: true }); } };
}

for (const scenario of ["success", "early-complete"]) {
  test(`${scenario}: 执行已有指令快照并保存最终消息、会话和事件`, async () => {
    const env = await setup(scenario, { model: "fixture-model", execution: { sandbox: "workspace-write", timeoutMs: 5000, effort: "low" } });
    try {
      const run = await env.service.runTask("one", new AbortController().signal);
      assert.equal(run.status, "succeeded");
      assert.equal(run.output, "verified reply");
      assert.equal(run.threadId, "thread-1");
      assert.equal(run.turnId, "turn-1");
      assert.equal(run.promptSnapshot, "persisted instruction");
      const events = env.store.execution.events(run.id);
      assert.ok(events.some((event) => event.type === "submission_started"));
      assert.ok(events.some((event) => event.type === "turn/completed"));
      const requests = (await readFile(env.trace, "utf8")).trim().split("\n").map((line: string) => JSON.parse(line) as { method?: string; params?: Record<string, unknown> });
      const start = requests.find((request) => request.method === "turn/start")!;
      assert.deepEqual(start.params?.input, [{ type: "text", text: "persisted instruction" }]);
      assert.equal(start.params?.effort, "low");
      assert.equal(start.params?.model, "fixture-model");
      assert.deepEqual(start.params?.sandboxPolicy, { type: "workspaceWrite", writableRoots: [env.dir], networkAccess: false, excludeSlashTmp: true, excludeTmpdirEnvVar: true });
      await assert.rejects(env.service.start(run.id, new AbortController().signal), { code: "RUN_ALREADY_STARTED" });
    } finally { await env.cleanup(); }
  });
}

for (const [scenario, status] of [
  ["failure", "failed"], ["approval", "needs_attention"], ["input", "needs_attention"],
  ["disconnect", "needs_attention"], ["lost-submission", "needs_attention"], ["quota-wait", "waiting_quota"],
  ["account-change", "failed"],
  ["unknown-start-status", "needs_attention"], ["unknown-terminal-status", "needs_attention"],
  ["large-completed-output", "needs_attention"], ["hidden-delta-output", "needs_attention"],
] as const) {
  test(`${scenario}: 保存 ${status}，不误报成功或泄露原始错误`, async () => {
    const env = await setup(scenario);
    try {
      const run = await env.service.runTask("one", new AbortController().signal);
      assert.equal(run.status, status);
      assert.ok(!JSON.stringify(run).includes("private-debug-secret"));
      if (scenario.startsWith("unknown-")) {
        assert.match(run.error!, /CODEX_TURN_STATUS_UNKNOWN/);
        await assert.rejects(env.service.start(run.id, new AbortController().signal), { code: "RUN_ALREADY_STARTED" });
      }
      if (scenario.endsWith("-output")) {
        assert.match(run.error!, /EXECUTION_REVIEW_REQUIRED/);
        assert.ok(Buffer.byteLength(run.output) <= 1024 * 1024);
      }
      if (["quota-wait", "account-change"].includes(scenario)) {
        assert.ok(!env.store.execution.events(run.id).some((event) => event.type === "submission_started"));
      }
    } finally { await env.cleanup(); }
  });
}

test("超时经 interrupt 确认后为 failed，并保留部分输出", async () => {
  const env = await setup("hang", { execution: { sandbox: "read-only", timeoutMs: 1500 } });
  try {
    const run = await env.service.runTask("one", new AbortController().signal);
    assert.equal(run.status, "failed");
    assert.match(run.error!, /EXECUTION_TIMEOUT/);
    assert.equal(run.output, "work in progress");
  } finally { await env.cleanup(); }
});

test("另一连接请求取消；未完成的并发执行不会创建额外记录", async () => {
  const env = await setup("hang");
  const other = new SqliteStore(env.config.storage.databasePath);
  try {
    let id = "";
    const pending = env.service.runTask("one", new AbortController().signal, (runId) => { id = runId; });
    // The callback runs before the first awaited CLI operation.
    assert.ok(id);
    await assert.rejects(env.service.runTask("one", new AbortController().signal), { code: "EXECUTION_BUSY" });
    assert.equal((await env.store.runs.listByTask("one")).length, 1);
    assert.equal(other.execution.cancel(id).cancelRequested, true);
    const run = await pending;
    assert.equal(run.status, "cancelled");
  } finally { other.close(); await env.cleanup(); }
});

test("取消没有收到终止通知时保留为待核对", async () => {
  const env = await setup("cancel-unconfirmed", { execution: { sandbox: "read-only", timeoutMs: 2000 } });
  try {
    const run = await env.service.runTask("one", new AbortController().signal);
    assert.equal(run.status, "needs_attention");
    assert.match(run.error!, /STOP_UNCONFIRMED/);
  } finally { await env.cleanup(); }
});

test("mock 和内存数据库均不能放行真实执行", async () => {
  const env = await setup();
  try {
    await assert.rejects(new ManualExecutionService({ ...env.config, provider: "mock" }, env.store).runTask("one", new AbortController().signal), { code: "EXECUTION_REQUIRES_CODEX" });
    await assert.rejects(new ManualExecutionService({ ...env.config, storage: { databasePath: ":memory:" } }, env.store).runTask("one", new AbortController().signal), { code: "EXECUTION_REQUIRES_STORAGE" });
    assert.deepEqual(await env.store.runs.listByTask("one"), []);
  } finally { await env.cleanup(); }
});

for (const scenario of ["success", "wrong-project", "busy-thread"]) {
  test(`续接 ${scenario}: 检查既有会话项目与活动状态`, async () => {
    const env = await setup(scenario, { session: { mode: "resume", threadId: "thread-1" } });
    try {
      const run = await env.service.runTask("one", new AbortController().signal);
      assert.equal(run.status, scenario === "success" ? "succeeded" : "failed");
    } finally { await env.cleanup(); }
  });
}

test("停用任务不能启动；queued 取消不会调用执行器", async () => {
  const env = await setup();
  try {
    const queued = await env.store.runs.create("one");
    assert.equal(env.store.execution.cancel(queued.id).run.status, "cancelled");
    const definition = (await env.store.tasks.get("one"))!;
    await env.store.tasks.update({ ...definition, enabled: false }, definition.promptSnapshot, 1);
    await assert.rejects(env.service.runTask("one", new AbortController().signal), { code: "TASK_DISABLED" });
    assert.equal((await env.store.runs.listByTask("one")).length, 1);
  } finally { await env.cleanup(); }
});

test("遗留执行权只能在所属进程已退出后恢复为待核对，不重新提交", async () => {
  const env = await setup();
  try {
    const run = env.store.execution.claimNew("one");
    assert.throws(() => env.store.execution.recover(run.id), { code: "EXECUTION_BUSY" });
    env.store.database.connection.prepare("UPDATE execution_lock SET owner_pid=2147483647").run();
    assert.equal(env.store.execution.recover(run.id).status, "needs_attention");
    assert.equal(env.store.database.connection.prepare("SELECT count(*) AS count FROM execution_lock").get()?.count, 0);
    assert.equal((await env.store.runs.listByTask("one")).length, 1);
  } finally { await env.cleanup(); }
});

test("CLI 启动 prepared 记录后，可由另一 CLI 进程取消并查询事件", async () => {
  const env = await setup("hang");
  let child: ReturnType<typeof spawn> | undefined;
  try {
    const configPath = join(env.dir, "config.json");
    await writeFile(configPath, JSON.stringify({ ...env.config, tasksFile: join(env.dir, "unused.json") }));
    const run = await env.store.runs.create("one");
    const cli = resolve("dist/src/cli.js");
    const args = ["--experimental-sqlite", cli];
    child = spawn(process.execPath, [...args, "runs", "start", run.id, "--config", configPath], { windowsHide: true });
    const result = new Promise<{ code: number | null; text: string }>((resolveResult, reject) => {
      let text = "";
      child!.stdout!.on("data", (chunk: Buffer) => { text += chunk.toString(); });
      child!.stderr!.resume();
      child!.once("error", reject);
      child!.once("close", (code) => resolveResult({ code, text }));
    });
    let submitted = false;
    for (let attempt = 0; attempt < 160; attempt++) {
      const trace = await readFile(env.trace, "utf8").catch(() => "");
      if (trace.includes('"method":"turn/start"')) { submitted = true; break; }
      await delay(25);
    }
    assert.ok(submitted);
    execFileSync(process.execPath, [...args, "runs", "cancel", run.id, "--config", configPath], { stdio: "pipe" });
    const completed = await result;
    assert.equal(completed.code, 0);
    assert.equal((JSON.parse(completed.text) as { status: string }).status, "cancelled");
    const events = JSON.parse(execFileSync(process.execPath, [...args, "runs", "events", run.id, "--config", configPath], { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] })) as Array<{ type: string }>;
    assert.ok(events.some((event) => event.type === "interrupt_requested"));
  } finally { child?.kill(); await env.cleanup(); }
});
