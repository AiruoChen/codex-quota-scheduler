import assert from "node:assert/strict";
import { request } from "node:http";
import { connect } from "node:net";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { loadConfig } from "../src/config/load.js";
import type { TaskRun } from "../src/domain/task.js";
import type { Clock } from "../src/domain/ports.js";
import type { QuotaSnapshot } from "../src/domain/quota.js";
import { ManagementService } from "../src/management/service.js";
import { serveManagement } from "../src/adapters/http/management-server.js";
import { RuntimeLogger } from "../src/runtime/log.js";
import { SqliteStore } from "../src/storage/sqlite-store.js";
import { createRpcError } from "../src/adapters/codex/rpc-errors.js";
import { randomUUID } from "node:crypto";

async function setup(provider: "mock" | "codex" = "mock", scenario = "success", clock?: Clock) {
  const dir = await mkdtemp(join(tmpdir(), "management 中文 &-"));
  const configPath = join(dir, "config/local.json");
  await mkdir(join(dir, "config"));
  await writeFile(join(dir, "tasks.json"), "[]");
  const trace = join(dir, "trace.jsonl");
  await writeFile(configPath, JSON.stringify({ schemaVersion: 1, provider, pollIntervalMs: 1000, quotaMaxAgeMs: 10000, reservePercent: 10,
    limitId: "codex", tasksFile: "../tasks.json", storage: { databasePath: "../state.sqlite" },
    codex: { executable: process.execPath, args: [resolve("tests/fixtures/fake-execution.mjs"), "--scenario", scenario, "--trace", trace, "--project", dir], requestTimeoutMs: 2000, shutdownTimeoutMs: 200 } }));
  const config = await loadConfig(configPath);
  const logger = new RuntimeLogger(join(dir, "runtime.log"));
  const service = new ManagementService(config, configPath, logger.write, clock);
  await service.initialize();
  const server = await serveManagement(service, { port: 0, instance: "01234567-abcd-1234-abcd-0123456789ab", controlToken: "test-secret", logger, onStop() {} });
  const root = await fetch(server.url);
  const cookie = root.headers.get("set-cookie")!.split(";")[0]!;
  const csrf = (await (await fetch(server.url + "/api/bootstrap", { headers: { cookie } })).json() as { csrf: string }).csrf;
  async function get(path: string) { return await (await fetch(server.url + path, { headers: { cookie } })).json() as Record<string, unknown>; }
  async function action(action: string, data: Record<string, unknown> = {}) {
    return fetch(server.url + "/api/action", { method: "POST", headers: { cookie, "Content-Type": "application/json", "X-CSRF-Token": csrf }, body: JSON.stringify({ action, ...data }) });
  }
  async function task(prompt = "immutable <script>alert(1)</script>", revision?: number) {
    const response = await action("task-save", { definition: { id: "one", name: "One", enabled: true, projectDir: dir, priority: 1, session: { mode: "new" } }, prompt, ...(revision ? { revision } : {}) });
    assert.equal(response.status, 200); return response.json();
  }
  return { dir, configPath, trace, config, service, server, cookie, csrf, get, action, task,
    async cleanup() { await server.close(); await rm(dir, { recursive: true, force: true }); } };
}

async function until(predicate: () => Promise<boolean>) {
  for (let index = 0; index < 120; index++) { if (await predicate()) return; await delay(50); }
  throw new Error("Timed out waiting for management operation");
}

test("U02/U07: GUI API creates a backend UUID idempotently and saves reserve pairs with concurrency validation", async () => {
  const env = await setup();
  try {
    const data = { requestId: randomUUID(), definition: { name: "Generated fixture", enabled: true, projectDir: env.dir, priority: 1, session: { mode: "new" } }, prompt: "synthetic" };
    const response = await env.action("task-save", data); assert.equal(response.status, 200);
    const task = await response.json() as { id: string }; assert.match(task.id, /^[a-f0-9-]{36}$/);
    assert.equal((await (await env.action("task-save", data)).json() as { id: string }).id, task.id);
    const config = await env.get("/api/config"); assert.equal(typeof config.revision, "string");
    assert.equal((await env.action("quota-reserves-save", { fiveHour: 12.5, weekly: 25, revision: config.revision })).status, 200);
    const changed = await env.get("/api/config"); assert.deepEqual((changed.saved as { quotaReserves: unknown }).quotaReserves, { fiveHour: 12.5, weekly: 25 });
    assert.equal((changed.active as { quotaReserves?: unknown }).quotaReserves, undefined);
    assert.equal((await env.action("quota-reserves-save", { fiveHour: 20, weekly: 20, revision: config.revision })).status, 409);
  } finally { await env.cleanup(); }
});

test("管理状态保留缺失窗口、回退边界及未知账户的保守判断", async () => {
  const now = new Date("2026-10-22T00:00:00Z");
  const env = await setup("mock", "success", { now: () => now });
  try {
    await env.service.loopAction("monitor-stop");
    const repository = (await env.service.app.monitoring()).repository;
    const baseline: QuotaSnapshot = { source: "mock", fetchedAt: now.toISOString(), buckets: [{
      id: "codex", name: null, planType: null, reachedType: null, windows: [
        { slot: "primary", durationMinutes: 300, usedPercent: 10, remainingPercent: 90, resetsAt: "2026-10-22T05:00:00Z" },
        { slot: "secondary", durationMinutes: 10080, usedPercent: 20, remainingPercent: 80, resetsAt: "2026-10-29T00:00:00Z" },
      ],
    }] };
    for (const reason of ["missing_window", "unknown_quota", "identity_unknown"] as const) {
      repository.record({ snapshot: baseline });
      const snapshot = structuredClone(baseline);
      if (reason === "missing_window") snapshot.buckets[0]!.windows.pop();
      if (reason === "unknown_quota") snapshot.buckets[0]!.windows[0]!.resetsAt = "2026-10-22T04:00:00Z";
      if (reason === "identity_unknown") snapshot.source = "codex";
      repository.record({ snapshot });
      assert.deepEqual(repository.status()?.availability, { status: "unknown", reason });
      assert.deepEqual((await env.service.state()).monitor?.availability, { status: "unknown", reason });
    }
  } finally { await env.cleanup(); }
});

test("GUI 仅提供白名单浏览器模块，不能读取服务端模块或源码映射", async () => {
  const env = await setup();
  try {
    const modules = (await import("../src/management/gui-assets.js")).browserModules;
    for (const name of modules) {
      const response = await fetch(env.server.url + `/gui/${name}.js`);
      assert.equal(response.status, 200); assert.match(response.headers.get("content-type") ?? "", /javascript/);
    }
    for (const path of ["/gui/service.js", "/gui/app.js.map", "/gui/../service.js", "/contracts.js", "/app.js"]) {
      assert.equal((await fetch(env.server.url + path, { headers: { cookie: env.cookie } })).status, 404);
    }
    assert.equal((await env.action("sample")).status, 200);
    assert.equal((await env.service.state()).loop, "monitor");
  } finally { await env.cleanup(); }
});

test("脱敏诊断只经管理会话导出白名单状态，不包含账户、配置路径或任务正文", async () => {
  const env = await setup("codex");
  try {
    const save = await env.action("task-save", { definition: { id: "private-id", name: "PRIVATE_TASK_NAME", enabled: true,
      projectDir: env.dir, priority: 1, session: { mode: "new" } }, prompt: "PRIVATE_PROMPT_CONTENT" });
    assert.equal(save.status, 200);
    const denied = await fetch(env.server.url + "/api/diagnostics");
    assert.equal(denied.status, 403);
    const report = await env.get("/api/diagnostics");
    assert.equal(report.format, 1);
    assert.deepEqual(Object.keys(report), ["format", "createdAt", "environment", "provider", "service", "quota", "scheduler", "recovery", "codexRpcDiagnostics"]);
    assert.equal(report.provider, "codex");
    assert.equal((report.scheduler as { paused: boolean }).paused, true);
    const exported = JSON.stringify(report);
    for (const secret of [env.dir, env.configPath, env.trace, "PRIVATE_TASK_NAME", "PRIVATE_PROMPT_CONTENT", "private-id",
      "test-secret", "fixture@example.test", "executable", "databasePath", "promptSnapshot", "runtime.log"]) {
      assert.equal(exported.includes(secret), false, `诊断泄露 ${secret}`);
    }
  } finally { await env.cleanup(); }
});

test("RPC 诊断导出重新投影白名单，拒绝未知类别并限制最近十条，不泄漏额外事件字段", async () => {
  const env = await setup("codex");
  try {
    await env.task();
    const store = await env.service.app.storage();
    const run = await store.runs.create("one");
    const diagnostic = createRpcError({ code: -32600, message: "unknown PRIVATE_ERROR_BODY" }, "thread/resume", "0.160.0-fixture").diagnostic;
    for (let index = 0; index < 12; index++) store.execution.event(run.id, "codex_rpc_error", { ...diagnostic, raw: "PRIVATE_EVENT_BODY", path: env.dir });
    store.execution.event(run.id, "codex_rpc_error", { ...diagnostic, reason: "PRIVATE_REASON_BODY" });
    const report = await env.get("/api/diagnostics");
    const items = report.codexRpcDiagnostics as Array<Record<string, unknown>>;
    assert.equal(items.length, 9);
    assert.ok(items.every(item => !Object.hasOwn(item, "raw") && !Object.hasOwn(item, "path")));
    const text = JSON.stringify(report);
    for (const secret of ["PRIVATE_ERROR_BODY", "PRIVATE_EVENT_BODY", "PRIVATE_REASON_BODY", env.dir, run.id]) assert.ok(!text.includes(secret));
  } finally { await env.cleanup(); }
});

test("同一时刻的两个手动请求只登记一个后台操作", async () => {
  const env = await setup("codex", "hang");
  try {
    await env.task();
    const results = await Promise.allSettled([
      env.service.action("run", { id: "one" }), env.service.action("run", { id: "one" }),
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    const rejected = results.find((result) => result.status === "rejected");
    assert.ok(rejected?.status === "rejected");
    assert.equal((rejected.reason as { code: string }).code, "MANAGEMENT_BUSY");
    assert.equal((await env.service.state()).jobs.filter((job) => job.kind === "run").length, 1);
  } finally { await env.cleanup(); }
});

test("停止服务期间拒绝已接收但尚未读完的写入请求", async () => {
  const env = await setup();
  let pending: ReturnType<typeof request> | undefined;
  try {
    const body = JSON.stringify({ action: "task-save", definition: { id: "late", name: "Late", enabled: true,
      projectDir: env.dir, priority: 1, session: { mode: "new" } }, prompt: "fixture-only" });
    const response = new Promise<number>((resolveStatus, reject) => {
      pending = request(env.server.url + "/api/action", { method: "POST", headers: {
        cookie: env.cookie, "Content-Type": "application/json", "X-CSRF-Token": env.csrf,
        "Content-Length": Buffer.byteLength(body),
      } }, (res) => { res.resume(); resolveStatus(res.statusCode!); });
      pending.once("error", reject);
      pending.write(body.slice(0, -1));
    });
    // A completed request on the same server confirms it is servicing connections.
    await env.get("/api/state");
    const closing = env.server.close();
    pending!.end(body.slice(-1));
    assert.equal(await response, 409);
    await closing;
    const store = new SqliteStore(env.config.storage.databasePath);
    try { assert.equal(await store.tasks.get("late"), null); } finally { store.close(); }
  } finally { pending?.destroy(); await env.cleanup(); }
});

test("HTTP 仅允许本机 Host、同源会话和 CSRF；静态资源不暴露本地文件", async () => {
  const env = await setup();
  try {
    const root = await fetch(env.server.url);
    assert.match(root.headers.get("content-security-policy")!, /frame-ancestors 'none'/);
    assert.match(root.headers.get("set-cookie")!, /HttpOnly; SameSite=Strict/);
    assert.match(await root.text(), /本地控制台/);
    assert.equal((await fetch(env.server.url + "/api/tasks")).status, 403);
    assert.equal((await fetch(env.server.url + "/api/tasks", { headers: { cookie: env.cookie, Origin: "https://evil.example" } })).status, 403);
    assert.equal((await fetch(env.server.url + "/api/action", { method: "POST", headers: { cookie: env.cookie, "Content-Type": "application/json" }, body: '{"action":"resume"}' })).status, 403);
    const hostStatus = await new Promise<number>((resolveStatus, reject) => {
      const req = request(env.server.url + "/", { headers: { Host: "evil.example" } }, (res) => { res.resume(); resolveStatus(res.statusCode!); });
      req.once("error", reject); req.end();
    });
    assert.equal(hostStatus, 403);
    assert.equal((await fetch(env.server.url + "/config/local.json", { headers: { cookie: env.cookie } })).status, 404);
    assert.equal((await fetch(env.server.url + "/api/runtime", { headers: { cookie: env.cookie } })).status, 403);
    const large = await env.action("task-save", { prompt: "a".repeat(520 * 1024) });
    assert.equal(large.status, 413);
    assert.equal((await fetch(env.server.url + "/gui/app.js")).status, 200);
  } finally { await env.cleanup(); }
});

test("页面任务编辑检查 revision，排队快照不可变；归档历史保留", async () => {
  const env = await setup();
  try {
    await env.task();
    const enqueued = await (await env.action("enqueue", { id: "one" })).json() as TaskRun;
    await env.task("edited instruction", 1);
    assert.equal((await env.action("task-save", { definition: { id: "one", name: "Conflict", enabled: true, projectDir: env.dir, priority: 1, session: { mode: "new" } }, prompt: "bad", revision: 1 })).status, 409);
    const detail = await env.get(`/api/run?id=${enqueued.id}`);
    assert.equal((detail.run as TaskRun).promptSnapshot, "immutable <script>alert(1)</script>");
    assert.equal((await env.get("/api/task?id=one")).promptSnapshot, "edited instruction");
    assert.ok(!JSON.stringify(await env.get("/api/tasks")).includes("edited instruction"));
    assert.equal((await env.action("task-delete", { id: "one", revision: 2 })).status, 200);
    assert.deepEqual(await env.get("/api/tasks"), []);
    assert.equal((await env.get(`/api/run?id=${enqueued.id}`)).run !== null, true);
    const store = await env.service.app.storage();
    assert.equal((await store.tasks.revisions("one")).length, 2);
    assert.equal((await store.runs.recent(1, 0))[0]?.id, enqueued.id);
    assert.deepEqual(await store.runs.recent(1, 1), []);
  } finally { await env.cleanup(); }
});

test("模拟页面可以入队，但不能执行、启动真实调度或远端核对", async () => {
  const env = await setup();
  try {
    await env.task();
    await env.action("enqueue", { id: "one" });
    for (const action of ["run", "run-start", "scheduler-start", "resume", "inspect", "reconcile"]) {
      const response = await env.action(action, { id: "one" });
      assert.equal(response.status, 400);
      assert.equal((await response.json() as { error: { code: string } }).error.code, "EXECUTION_REQUIRES_CODEX");
    }
    assert.equal((await env.service.state()).scheduler.paused, true);
    await assert.rejects(readFile(env.trace), { code: "ENOENT" });
  } finally { await env.cleanup(); }
});

test("界面配置通过原子管理器保存，活动配置维持到重启", async () => {
  const env = await setup();
  try {
    assert.equal((await env.action("config-set", { key: "reservePercent", value: 25 })).status, 200);
    const config = await env.get("/api/config") as { active: { reservePercent: number }; saved: { reservePercent: number } };
    assert.equal(config.active.reservePercent, 10); assert.equal(config.saved.reservePercent, 25);
    assert.equal((JSON.parse(await readFile(env.configPath + ".bak", "utf8")) as { reservePercent: number }).reservePercent, 10);
    assert.equal((await env.action("config-set", { key: "provider", value: "unknown" })).status, 400);
    assert.equal((await loadConfig(env.configPath)).provider, "mock");
  } finally { await env.cleanup(); }
});

test("真实协议替身：页面调度启动后保持暂停，显式恢复才执行一次；重启不重发", async () => {
  const env = await setup("codex");
  try {
    await env.task("fixture-only instruction");
    const queued = await (await env.action("enqueue", { id: "one" })).json() as TaskRun;
    assert.equal((await env.action("scheduler-start")).status, 202);
    await until(async () => !!(await env.service.state()).scheduler.worker);
    assert.equal((await env.service.state()).scheduler.paused, true);
    assert.equal((await env.service.app.storage()).execution.events(queued.id).filter((event) => event.type === "submission_started").length, 0);
    assert.equal((await env.action("config-set", { key: "reservePercent", value: 20 })).status, 409);
    assert.equal((await env.action("resume")).status, 200);
    await until(async () => (await (await env.service.app.storage()).runs.get(queued.id))?.status === "succeeded");
    await env.action("scheduler-stop");
    const restarted = new ManagementService(await loadConfig(env.configPath), env.configPath);
    try {
      await restarted.initialize();
      assert.equal((await restarted.state()).scheduler.paused, true);
      assert.equal((await (await restarted.app.storage()).runs.get(queued.id))?.output, "verified reply");
    } finally { await restarted.close(); }
    const requests = (await readFile(env.trace, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { method?: string });
    assert.equal(requests.filter((entry) => entry.method === "turn/start").length, 1);
  } finally { await env.cleanup(); }
});

test("浏览器断开不取消手动执行；取消请求等待远端终止后才显示 cancelled", async () => {
  const env = await setup("codex", "hang");
  try {
    await env.task();
    const response = await env.action("run", { id: "one" });
    assert.equal(response.status, 202);
    const job = await response.json() as { id: number };
    let runId = "";
    await until(async () => {
      runId = (await env.service.state()).jobs.find((item) => item.id === job.id)?.runId ?? "";
      return !!runId && !!(await (await env.service.app.storage()).runs.get(runId))?.turnId;
    });
    const current = (await env.service.state()).currentRun;
    assert.equal(current?.id, runId);
    assert.equal(current?.name, "One");
    assert.ok(current && !Object.hasOwn(current, "promptSnapshot") && !Object.hasOwn(current, "output"));
    const detail = await env.get(`/api/run?id=${runId}`) as { origin: { account: string; cliVersion: string } };
    assert.match(detail.origin.account, /\*\*\*@/); assert.equal(typeof detail.origin.cliVersion, "string");
    const cancelling = await (await env.action("cancel", { id: runId })).json() as { run: TaskRun; cancelRequested: boolean };
    assert.equal(cancelling.run.status, "running"); assert.equal(cancelling.cancelRequested, true);
    await until(async () => (await (await env.service.app.storage()).runs.get(runId))?.status === "cancelled");
    assert.ok((await env.service.app.storage()).execution.events(runId).some((item) => item.type === "turn/completed"));
  } finally { await env.cleanup(); }
});

test("运行日志轮转且拒绝记录任意消息或令牌", async () => {
  const dir = await mkdtemp(join(tmpdir(), "runtime-logs-"));
  try {
    const logger = new RuntimeLogger(join(dir, "runtime.log"), 170, 2);
    for (let index = 0; index < 12; index++) logger.write("job_started");
    logger.write("private prompt sk-this-is-a-private-token", "Bearer private-secret");
    for (const path of [logger.path, logger.path + ".1", logger.path + ".2"]) {
      const content = await readFile(path, "utf8");
      assert.ok(!/private|Bearer|sk-/.test(content));
      assert.ok(content.trim().split("\n").every((line) => !!JSON.parse(line)));
    }
    await assert.rejects(readFile(logger.path + ".3"), { code: "ENOENT" });
    assert.match(logger.tail(1), /runtime_event/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("停止监控后的过期额度显示未知，读取页面不生成刷新事件", async () => {
  let now = new Date("2026-10-22T00:00:00Z");
  const env = await setup("mock", "success", { now: () => now });
  try {
    await env.action("monitor-stop");
    await env.action("sample");
    assert.equal((await env.service.state()).monitor?.availability.status, "available");
    const count = (await env.service.state()).events.length;
    now = new Date(now.getTime() + 11000);
    assert.equal((await env.service.state()).monitor?.availability.status, "unknown");
    assert.equal((await env.service.state()).monitor?.availability.reason, "stale_quota");
    assert.equal((await env.service.state()).events.length, count);
  } finally { await env.cleanup(); }
});

test("服务停止等待已提交任务核对；没有终止确认时保留 needs_attention", async () => {
  const env = await setup("codex", "cancel-unconfirmed");
  try {
    await env.task();
    const job = await (await env.action("run", { id: "one" })).json() as { id: number };
    let runId = "";
    await until(async () => {
      runId = (await env.service.state()).jobs.find((item) => item.id === job.id)?.runId ?? "";
      return !!runId && !!(await (await env.service.app.storage()).runs.get(runId))?.turnId;
    });
    await env.server.close();
    const store = new SqliteStore(env.config.storage.databasePath);
    try {
      assert.equal((await store.runs.get(runId))?.status, "needs_attention");
      assert.equal(store.execution.events(runId).filter((event) => event.type === "submission_started").length, 1);
    } finally { store.close(); }
  } finally { await env.cleanup(); }
});

test("等待式退出拒绝新任务但保留当前执行，完成并落盘后才停止", async () => {
  const env = await setup("codex", "slow-success");
  try {
    await env.task();
    const job = await (await env.action("run", { id: "one" })).json() as { id: number };
    let runId = "";
    await until(async () => {
      runId = (await env.service.state()).jobs.find((item) => item.id === job.id)?.runId ?? "";
      return !!runId && !!(await (await env.service.app.storage()).runs.get(runId))?.turnId;
    });
    const stopping = env.server.close("wait");
    const status = await (await fetch(env.server.url + "/api/runtime", { headers: { Authorization: "Bearer test-secret",
      "X-Runtime-Instance": "01234567-abcd-1234-abcd-0123456789ab" } })).json() as { stopping: boolean; activeOperations: number; shutdownMode: string };
    assert.equal(status.stopping, true); assert.equal(status.shutdownMode, "wait"); assert.ok(status.activeOperations > 0);
    assert.equal((await env.action("run", { id: "one" })).status, 409);
    assert.equal((await (await env.service.app.storage()).runs.get(runId))?.status, "running");
    await stopping;
    const store = new SqliteStore(env.config.storage.databasePath);
    try { assert.equal((await store.runs.get(runId))?.status, "succeeded"); } finally { store.close(); }
    const trace = await readFile(env.trace, "utf8");
    assert.ok(!trace.includes('"method":"turn/interrupt"'));
    assert.equal(trace.split('"method":"turn/start"').length - 1, 1);
  } finally { await env.cleanup(); }
});

test("等待式停止期间控制接口可显式升级取消，并等待终止确认", async () => {
  const env = await setup("codex", "hang");
  try {
    await env.task();
    const job = await (await env.action("run", { id: "one" })).json() as { id: number };
    let runId = "";
    await until(async () => {
      runId = (await env.service.state()).jobs.find((item) => item.id === job.id)?.runId ?? "";
      return !!runId && !!(await (await env.service.app.storage()).runs.get(runId))?.turnId;
    });
    const stopping = env.server.close("wait");
    const response = await fetch(env.server.url + "/api/runtime/stop?mode=cancel", { method: "POST", headers: {
      Authorization: "Bearer test-secret", "X-Runtime-Instance": "01234567-abcd-1234-abcd-0123456789ab" } });
    assert.equal(response.status, 202);
    await stopping;
    const store = new SqliteStore(env.config.storage.databasePath);
    try {
      assert.equal((await store.runs.get(runId))?.status, "cancelled");
      assert.ok(store.execution.events(runId).some((event) => event.type === "turn/completed"));
    } finally { store.close(); }
  } finally { await env.cleanup(); }
});

test("调度等待式退出先暂停派发，当前任务完成后不领取下一项", async () => {
  const env = await setup("codex", "slow-success");
  try {
    await env.task("first snapshot");
    const first = await (await env.action("enqueue", { id: "one" })).json() as TaskRun;
    await env.task("second snapshot", 1);
    const second = await (await env.action("enqueue", { id: "one" })).json() as TaskRun;
    await env.action("scheduler-start");
    await until(async () => !!(await env.service.state()).scheduler.worker);
    await env.action("resume");
    await until(async () => !!(await (await env.service.app.storage()).runs.get(first.id))?.turnId);
    await env.server.close("wait");
    const store = new SqliteStore(env.config.storage.databasePath);
    try {
      assert.equal((await store.runs.get(first.id))?.status, "succeeded");
      assert.equal((await store.runs.get(second.id))?.status, "queued");
      assert.equal(store.execution.events(second.id).filter((event) => event.type === "submission_started").length, 0);
    } finally { store.close(); }
    assert.ok(!(await readFile(env.trace, "utf8")).includes('"method":"turn/interrupt"'));
  } finally { await env.cleanup(); }
});

test("浏览器只建立连接而不发请求时，服务仍可在排空后安全停止", async () => {
  const env = await setup();
  const socket = connect(Number(new URL(env.server.url).port), "127.0.0.1");
  try {
    await new Promise<void>((done, reject) => { socket.once("connect", done); socket.once("error", reject); });
    await Promise.race([env.server.close("wait"), delay(2000, undefined, { ref: false }).then(() => { throw new Error("Idle preconnect blocked shutdown"); })]);
  } finally { socket.destroy(); await env.cleanup(); }
});

test("任务启停与入队均检查 revision，页面分页不暴露指令", async () => {
  const env = await setup();
  try {
    await env.task("private page prompt");
    const page = await env.get("/api/tasks/page?search=One&enabled=enabled&limit=1");
    assert.equal(page.total, 1); assert.ok(!JSON.stringify(page).includes("private page prompt"));
    assert.equal((await env.action("task-enable", { id: "one", revision: 1, enabled: false })).status, 200);
    assert.equal((await env.action("task-enable", { id: "one", revision: 1, enabled: true })).status, 409);
    assert.equal((await env.action("enqueue", { id: "one", revision: 1 })).status, 409);
    assert.equal((await env.action("enqueue", { id: "one", revision: 2 })).status, 400);
    assert.equal((await env.action("task-enable", { id: "one", revision: 2, enabled: true })).status, 200);
    const queued = await (await env.action("enqueue", { id: "one", revision: 3 })).json() as TaskRun;
    assert.equal(queued.taskRevision, 3); assert.equal(queued.promptSnapshot, "private page prompt");
    assert.equal((await env.get("/api/tasks/page?enabled=disabled")).total, 0);
    assert.equal((await fetch(env.server.url + "/api/tasks/page?offset=-1", { headers: { cookie: env.cookie } })).status, 400);
  } finally { await env.cleanup(); }
});

test("运行分页按状态/项目筛选并保留历史版本，不返回正文和输出", async () => {
  const env = await setup();
  try {
    await env.task("private run prompt");
    const run = await (await env.action("enqueue", { id: "one", revision: 1 })).json() as TaskRun;
    const page = await env.get("/api/runs/page?search=One&status=queued&limit=1");
    assert.equal(page.total, 1); assert.ok(!JSON.stringify(page).includes("private run prompt"));
    await env.action("cancel", { id: run.id });
    assert.equal((await env.get("/api/runs/page?status=cancelled")).total, 1);
    assert.equal((await env.get("/api/runs/page?status=queued")).total, 0);
    assert.equal((await fetch(env.server.url + "/api/runs/page?status=not-a-status", { headers: { cookie: env.cookie } })).status, 400);
    assert.equal((await env.get(`/api/run?id=${run.id}`)).origin, null);
  } finally { await env.cleanup(); }
});

test("托盘后台接口校验控制密钥与实例；暂停不停止服务或当前操作，事件不暴露正文", async () => {
  const env = await setup();
  try {
    for (const path of ["/api/runtime/desktop", "/api/runtime/pause"]) assert.equal((await fetch(env.server.url + path, { method: path.endsWith("pause") ? "POST" : "GET", headers: { cookie: env.cookie, "X-CSRF-Token": env.csrf } })).status, 403);
    const headers = { Authorization: "Bearer test-secret", "X-Runtime-Instance": "01234567-abcd-1234-abcd-0123456789ab" };
    const response = await fetch(env.server.url + "/api/runtime/desktop", { headers }); assert.equal(response.status, 200);
    const text = await response.text(); assert.ok(!text.includes(env.dir)); assert.ok(!text.includes("test-secret"));
    assert.equal((await fetch(env.server.url + "/api/runtime/desktop?execution=-1", { headers })).status, 400);
    (await env.service.app.scheduling()).repository.resume(); assert.equal((await env.service.state()).scheduler.paused, false);
    assert.equal((await fetch(env.server.url + "/api/runtime/pause", { method: "POST", headers })).status, 200);
    assert.equal((await env.service.state()).scheduler.paused, true); assert.equal((await env.service.state()).loop, "monitor");
  } finally { await env.cleanup(); }
});
