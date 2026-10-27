import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config/load.js";
import type { TaskDefinition } from "../src/domain/task.js";
import { ManualExecutionService } from "../src/executor/manual-service.js";
import { SqliteStore } from "../src/storage/sqlite-store.js";
import { checkResumeCompatibility } from "../src/adapters/codex/resume-check.js";
import { codexConnectionKey } from "../src/adapters/codex/connection-key.js";

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

for (const [scenario, reason] of [["resume-reject-missing", "thread_history_missing"], ["resume-reject-capability", "capability_required"], ["resume-reject-unknown", "unknown"]] as const) {
  test(`${scenario}：落盘固定 RPC 诊断，不重试恢复、不提交且不扩大权限`, async () => {
    const env = await setup(scenario, { session: { mode: "resume", threadId: "thread-1" } });
    try {
      const run = await env.service.runTask("one", new AbortController().signal);
      assert.equal(run.status, "failed"); assert.equal(run.threadId, null); assert.equal(run.turnId ?? null, null);
      const events = env.store.execution.events(run.id);
      const diagnostic = events.find(event => event.type === "codex_rpc_error")?.data;
      assert.equal(diagnostic?.reason, reason); assert.equal(diagnostic?.method, "thread/resume");
      assert.equal(diagnostic?.cliVersion, "0.160.0-fixture");
      assert.ok(run.error!.includes(String(diagnostic?.diagnosticId)));
      const saved = JSON.stringify([run, events]);
      for (const secret of ["private-debug-secret", "PRIVATE_TOKEN", "PRIVATE_RPC_BODY", "private-fixture-path", "fixture.invalid"]) assert.ok(!saved.includes(secret));
      const trace = (await readFile(env.trace, "utf8")).trim().split("\n").map(line => JSON.parse(line));
      assert.equal(trace.filter(row => row.method === "thread/resume").length, 1);
      assert.equal(trace.some(row => row.method === "turn/start" || row.method === "turn/interrupt"), false);
      assert.equal(trace.find(row => row.method === "initialize").params.capabilities, undefined);
      assert.equal(trace.find(row => row.method === "thread/resume").params.sandbox, "read-only");
      await assert.rejects(env.service.start(run.id, new AbortController().signal), { code: "RUN_ALREADY_STARTED" });
    } finally { await env.cleanup(); }
  });
}

test("提交入口 RPC 被拒绝仍保留 needs_attention，诊断分类不能放松提交互斥或触发重发", async () => {
  const env = await setup("submit-reject");
  try {
    const run = await env.service.runTask("one", new AbortController().signal);
    assert.equal(run.status, "needs_attention");
    assert.equal(env.store.execution.events(run.id).find(event => event.type === "codex_rpc_error")?.data.stage, "submit_turn");
    assert.ok(!JSON.stringify([run, env.store.execution.events(run.id)]).includes("PRIVATE_SUBMISSION_BODY"));
    await assert.rejects(env.service.start(run.id, new AbortController().signal), { code: "RUN_ALREADY_STARTED" });
  } finally { await env.cleanup(); }
});

for (const scenario of ["success", "wrong-project", "account-change", "history-method-missing"]) test(`只读续接兼容检查 ${scenario}：不恢复、不选择最新回合、不写运行状态`, async () => {
  const env = await setup(scenario, { session: { mode: "resume", threadId: "thread-1" } });
  try {
    const run = await env.store.runs.create("one");
    const target = { run, origin: { connectionKey: codexConnectionKey(env.config.codex), account: { type: "chatgpt" as const, email: "user@example.test", planType: "plus", workspaceId: null }, cliVersion: "0.160.0-fixture" } };
    const report = await checkResumeCompatibility(env.config.codex, target);
    assert.equal(report.result, scenario === "success" ? "read_only_checks_passed" : "blocked");
    assert.equal(report.resumeVerified, false); assert.equal(report.permissionsVerified, false);
    assert.deepEqual(await env.store.runs.get(run.id), run);
    assert.deepEqual(env.store.execution.events(run.id), []);
    assert.equal(env.store.database.connection.prepare("SELECT count(*) AS count FROM execution_lock").get()?.count, 0);
    for (const privateValue of [env.dir, run.id, "thread-1", "user@example.test", "PRIVATE_HISTORY_BODY", "persisted instruction"]) assert.ok(!JSON.stringify(report).includes(privateValue));
    const trace = (await readFile(env.trace, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    assert.ok(trace.every(row => ["initialize", "initialized", "account/read", "thread/read", "thread/turns/list", "thread/items/list"].includes(row.method)));
    assert.equal(trace.find(row => row.method === "thread/turns/list")?.params.sortDirection, scenario === "wrong-project" ? undefined : "asc");
    assert.equal((await checkResumeCompatibility({ ...env.config.codex, home: join(env.dir, "other-home") }, target)).errorCode, "CONNECTION_MISMATCH");
  } finally { await env.cleanup(); }
});

test("只读诊断命令使用准确运行及已记录来源，不迁移或写入业务数据库，不接受任意 RPC 参数", async () => {
  const env = await setup("success", { session: { mode: "resume", threadId: "thread-1" } });
  try {
    const run = env.store.execution.claimNew("one");
    env.store.execution.origin(run.id, { connectionKey: codexConnectionKey(env.config.codex), account: { type: "chatgpt", email: "user@example.test", planType: "plus", workspaceId: null }, cliVersion: "0.160.0-fixture" });
    await env.store.runs.update(run.id, { status: "failed", error: "SYNTHETIC_FAILURE" }, "running");
    env.store.execution.release(run.id);
    const before = await env.store.runs.get(run.id);
    const configPath = join(env.dir, "diagnostic-config.json");
    await writeFile(configPath, JSON.stringify(env.config));
    const args = ["--experimental-sqlite", resolve("scripts/diagnose-resume.mjs"), "--config", configPath, "--run", run.id];
    const processResult = spawnSync(process.execPath, args, { encoding: "utf8", timeout: 10000, windowsHide: true });
    assert.equal(processResult.status, 0, processResult.stderr);
    const report = JSON.parse(processResult.stdout);
    assert.equal(report.result, "read_only_checks_passed"); assert.equal(report.resumeVerified, false);
    for (const secret of [env.dir, run.id, "thread-1", "user@example.test", "PRIVATE_HISTORY_BODY"]) assert.ok(!processResult.stdout.includes(secret));
    assert.deepEqual(await env.store.runs.get(run.id), before);
    assert.deepEqual(env.store.execution.events(run.id), []);
    const denied = spawnSync(process.execPath, [...args, "--rpc", "thread/resume"], { encoding: "utf8", timeout: 10000, windowsHide: true });
    assert.equal(denied.status, 1); assert.equal(JSON.parse(denied.stdout).errorCode, "RESUME_CHECK_INPUT_OR_STORAGE_INVALID");
    const trace = (await readFile(env.trace, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    assert.ok(trace.every(row => ["initialize", "initialized", "account/read", "thread/read", "thread/turns/list", "thread/items/list"].includes(row.method)));
  } finally { await env.cleanup(); }
});

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
