import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config/load.js";
import type { QuotaSnapshot } from "../src/domain/quota.js";
import { ManualExecutionService } from "../src/executor/manual-service.js";
import { quotaStreamKey } from "../src/monitor/context.js";
import { SchedulerService } from "../src/scheduler/service.js";
import { SqliteMonitorRepository } from "../src/storage/monitor-repository.js";
import { SqliteSchedulerRepository } from "../src/storage/scheduler-repository.js";
import { SqliteStore } from "../src/storage/sqlite-store.js";

async function setup(scenario = "success", initial = Date.parse("2026-10-26T00:00:00Z"), maxAge = 1000) {
  const dir = await mkdtemp(join(tmpdir(), "execution-preflight-"));
  assert.equal(resolve(dirname(dir)), resolve(tmpdir()));
  const trace = join(dir, "trace.jsonl"), config = await loadConfig("config/codex.example.json");
  config.storage.databasePath = join(dir, "state.sqlite"); config.quotaMaxAgeMs = maxAge;
  config.codex = { ...config.codex, executable: process.execPath,
    args: [resolve("tests/fixtures/fake-execution.mjs"), "--scenario", scenario, "--trace", trace, "--project", dir],
    requestTimeoutMs: 3000, shutdownTimeoutMs: 200 };
  let time = initial, observer = (_type: string) => {};
  const clock = { now: () => new Date(time) }, store = new SqliteStore(config.storage.databasePath, clock);
  const event = store.execution.event.bind(store.execution);
  store.execution.event = (id, type, data) => { event(id, type, data); observer(type); };
  await store.tasks.create({ id: "one", name: "Synthetic preflight test", enabled: true, priority: 1,
    projectDir: dir, promptFile: join(dir, "unused.md"), session: { mode: "new" }, execution: { sandbox: "read-only", timeoutMs: 10000 } },
  "Synthetic protocol fixture only.");
  const monitor = new SqliteMonitorRepository(store.database, quotaStreamKey(config), config, clock);
  const service = new ManualExecutionService(config, store, clock);
  function snapshot(weekly = 10): QuotaSnapshot {
    return { source: "codex", fetchedAt: clock.now().toISOString(),
      account: { type: "chatgpt", email: "user@example.test", workspaceId: null, planType: "plus" },
      buckets: [{ id: "codex", name: null, planType: null, reachedType: null,
        windows: [{ slot: "primary", durationMinutes: 300, usedPercent: 10, remainingPercent: 90, resetsAt: new Date(time + 3600000).toISOString() },
          { slot: "secondary", durationMinutes: 10080, usedPercent: weekly, remainingPercent: 100 - weekly, resetsAt: new Date(time + 86400000).toISOString() }] }] };
  }
  return { config, clock, store, monitor, service, snapshot,
    advance(ms: number) { time += ms; }, observe(callback: (type: string) => void) { observer = callback; },
    async methods() { return (await readFile(trace, "utf8")).trim().split("\n").map((line) => (JSON.parse(line) as { method?: string }).method); },
    async cleanup() { store.close(); await rm(dir, { recursive: true, force: true }); } };
}

test("手动执行继承持久化的已知窗口，缺失周窗口时不创建回合", async () => {
  const e = await setup("missing-weekly");
  try {
    e.monitor.record({ snapshot: e.snapshot(100) });
    const missing = e.snapshot(); missing.buckets[0]!.windows.pop(); e.monitor.record({ snapshot: missing });
    assert.equal(e.monitor.status()!.availability.reason, "missing_window");
    const run = await e.service.runTask("one", new AbortController().signal);
    assert.equal(run.status, "waiting_quota"); assert.match(run.error!, /missing_window/);
    assert.equal((await e.methods()).includes("turn/start"), false);
    assert.equal((await e.methods()).includes("thread/start"), false);
    assert.equal(e.store.execution.active(), null);
  } finally { await e.cleanup(); }
});

for (const scenario of ["missing-weekly", "unknown-account"]) {
  test(`自动领取后的实际协议预检 ${scenario} 仍然阻止提交`, async () => {
    const e = await setup(scenario);
    try {
      const repository = new SqliteSchedulerRepository(e.store.database, quotaStreamKey(e.config), "available", e.config, e.clock);
      const queued = repository.enqueue("one"); repository.resume();
      const scheduler = new SchedulerService(repository,
        { async run(_signal, update) { await update(e.monitor.record({ snapshot: e.snapshot() })); } },
        e.service, { provider: "codex", persistent: true });
      await scheduler.run(new AbortController().signal, () => {});
      const run = await e.store.runs.get(queued.id);
      assert.equal(run!.status, scenario === "missing-weekly" ? "waiting_quota" : "failed");
      assert.equal((await e.methods()).includes("turn/start"), false);
      assert.equal(e.store.execution.events(queued.id).some((entry) => entry.type === "submission_started"), false);
      assert.equal(e.store.execution.active(), null);
    } finally { await e.cleanup(); }
  });
}

test("账户对象没有邮箱或工作区标识时，手动执行失败且不改写已有窗口证据", async () => {
  const e = await setup("unknown-account");
  try {
    e.monitor.record({ snapshot: e.snapshot() });
    const run = await e.service.runTask("one", new AbortController().signal);
    assert.equal(run.status, "failed"); assert.match(run.error!, /ACCOUNT_UNKNOWN/);
    assert.equal((await e.methods()).includes("turn/start"), false);
    assert.equal(e.monitor.status()!.windows.length, 2);
  } finally { await e.cleanup(); }
});

test("没有邮箱但具有工作区标识的真实协议账户可以通过身份校验", async () => {
  const e = await setup("workspace-account");
  try { assert.equal((await e.service.runTask("one", new AbortController().signal)).status, "succeeded"); }
  finally { await e.cleanup(); }
});

for (const scenario of ["success", "quota-wait-after-refresh", "boundary-refresh"]) {
  test(`会话准备跨过${scenario === "boundary-refresh" ? "窗口边界" : "最大年龄"}后，${scenario} 只重查一次`, async () => {
    const e = await setup(scenario, scenario === "boundary-refresh" ? 1999999999000 : undefined, scenario === "boundary-refresh" ? 10000 : 1000);
    try {
      e.observe((type) => {
        if (type === "thread_ready") e.advance(2000);
        if (type === "submission_started") assert.ok(e.clock.now().getTime() - Date.parse(e.monitor.status()!.snapshot!.fetchedAt) <= e.config.quotaMaxAgeMs);
      });
      const run = await e.service.runTask("one", new AbortController().signal), methods = await e.methods();
      assert.equal(methods.filter((method) => method === "account/rateLimits/read").length, 2);
      assert.equal(run.status, scenario === "quota-wait-after-refresh" ? "waiting_quota" : "succeeded");
      assert.equal(methods.filter((method) => method === "turn/start").length, scenario === "quota-wait-after-refresh" ? 0 : 1);
    } finally { await e.cleanup(); }
  });
}

test("重查后的快照在最终发送边界再次过期时，不标记提交也不继续重查", async () => {
  const e = await setup();
  try {
    e.observe((type) => { if (["thread_ready", "preflight_refreshed"].includes(type)) e.advance(2000); });
    const run = await e.service.runTask("one", new AbortController().signal);
    assert.equal(run.status, "waiting_quota"); assert.match(run.error!, /stale_quota/);
    assert.equal((await e.methods()).filter((method) => method === "account/rateLimits/read").length, 2);
    assert.equal((await e.methods()).includes("turn/start"), false);
    assert.equal(e.store.execution.events(run.id).some((entry) => entry.type === "submission_started"), false);
  } finally { await e.cleanup(); }
});

test("会话准备期间时钟回退时保持等待，不以新时间戳掩盖过期证据", async () => {
  const e = await setup();
  try {
    e.observe((type) => { if (type === "thread_ready") e.advance(-1); });
    const run = await e.service.runTask("one", new AbortController().signal);
    assert.equal(run.status, "waiting_quota");
    assert.equal((await e.methods()).filter((method) => method === "account/rateLimits/read").length, 1);
    assert.equal((await e.methods()).includes("turn/start"), false);
  } finally { await e.cleanup(); }
});
