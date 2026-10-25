import assert from "node:assert/strict";
import { request } from "node:http";
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
    assert.equal((await fetch(env.server.url + "/app.js")).status, 200);
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
