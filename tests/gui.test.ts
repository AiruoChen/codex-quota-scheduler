import assert from "node:assert/strict";
import test from "node:test";
import { quotaDisplay, maskAccount } from "../src/management/quota-display.js";
import { StateStore } from "../src/management/gui/state.js";
import { route } from "../src/management/gui/shell.js";
import type { ManagementState } from "../src/management/contracts.js";
import type { MonitorState } from "../src/domain/monitor.js";
import { SqliteStore } from "../src/storage/sqlite-store.js";
import { SqliteMonitorRepository } from "../src/storage/monitor-repository.js";
import { ContinuousQuotaMonitor } from "../src/monitor/continuous-monitor.js";
import { AppError } from "../src/shared/errors.js";

const epoch = Date.parse("2026-10-25T00:00:00Z");
const policy = { limitId: "flexible", quotaMaxAgeMs: 60000, reservePercent: 10, pollIntervalMs: 10000 };
function monitor(): MonitorState {
  return { revision: 1, observedAt: new Date(epoch).toISOString(), nextPollAt: new Date(epoch + 10000).toISOString(),
    identity: "fixture", failures: 0, errorCode: null, availability: { status: "available", reason: "quota_available" }, windows: [],
    snapshot: { source: "codex", fetchedAt: new Date(epoch).toISOString(), account: { type: "chatgpt", email: "fixture@example.invalid", planType: "fixture-plan", workspaceId: null },
      buckets: [{ id: "flexible", name: "Fixture", planType: null, reachedType: null, windows: [
        { slot: "primary", durationMinutes: 75, usedPercent: 25, remainingPercent: 75, resetsAt: new Date(epoch + 20000).toISOString() },
        { slot: "secondary", durationMinutes: 4321, usedPercent: 100, remainingPercent: 0, resetsAt: null },
      ] }] } };
}
function state(): ManagementState {
  const saved = monitor();
  return { provider: "codex", closing: false, now: new Date(epoch).toISOString(), monitor: saved, quota: quotaDisplay(saved, policy, new Date(epoch)), currentRun: null,
    events: [], jobs: [], loop: "monitor", scheduler: { paused: true, reason: null, worker: null, attention: [], queue: [] }, recovery: { checkedAt: new Date(epoch).toISOString(), issues: [], owners: [] } };
}

test("GUI 展示所有服务端窗口及任意时长，0% 保留为耗尽而非未知，账户默认脱敏", () => {
  const saved = monitor(); saved.availability = { status: "blocked", reason: "quota_exhausted" };
  const result = quotaDisplay(saved, policy, new Date(epoch));
  assert.deepEqual(result.windows.map((window) => [window.durationMinutes, window.remainingPercent]), [[75, 75], [4321, 0]]);
  assert.equal(result.validUntil, new Date(epoch + 20000).toISOString());
  assert.equal(result.account, "f***@example.invalid"); assert.ok(!JSON.stringify(result).includes("fixture@example.invalid"));
  assert.equal(maskAccount(null), "账户信息已隐藏");
});

test("GUI 过期、错误、缺失和身份未知时不显示可用额度；保留曾存在的缺失窗口", () => {
  const saved = monitor();
  saved.windows = [{ bucketId: "missing", slot: "primary", durationMinutes: 123, resetsAt: null }];
  for (const reason of ["read_failed", "identity_unknown", "missing_window", "stale_quota"] as const) {
    saved.availability = { status: "unknown", reason };
    const result = quotaDisplay(saved, policy, new Date(epoch));
    assert.ok(result.windows.every((window) => window.remainingPercent === null));
    assert.equal(result.windows.find((window) => window.bucketId === "missing")?.missing, true);
  }
  saved.availability = { status: "available", reason: "quota_available" };
  for (const now of [epoch - 1, epoch + 60001]) assert.ok(quotaDisplay(saved, policy, new Date(now)).windows.every((window) => window.remainingPercent === null));
  assert.deepEqual(quotaDisplay(null, policy, new Date(epoch)).windows, []);
});

test("GUI 共享状态合并并发查询，离线保留历史但标记未知，重连后才恢复", async () => {
  let resolve!: (value: ManagementState) => void; let calls = 0;
  let read = () => new Promise<ManagementState>((done) => { calls++; resolve = done; });
  const store = new StateStore(() => read(), () => {}, () => 0);
  const first = store.refresh(), second = store.refresh();
  assert.equal(first, second); assert.equal(calls, 1);
  resolve(state()); await first; assert.equal(store.value.connected, true);
  read = () => Promise.reject(new Error("offline")); await store.refresh();
  assert.equal(store.value.data?.scheduler.paused, true); assert.equal(store.value.connected, false); assert.equal(store.value.expired, true);
  read = () => Promise.resolve(state()); await store.refresh(); assert.equal(store.value.connected, true); assert.equal(store.value.expired, false);
});

test("GUI 计时以服务端时间为锚，边界到达只请求一次查询，不改变服务端可用判定", async () => {
  let elapsed = 0;
  const store = new StateStore(async () => state(), () => {}, () => elapsed);
  await store.refresh(); elapsed = 19999; assert.equal(store.tick(), false);
  elapsed = 20000; assert.equal(store.tick(), true); assert.equal(store.tick(), false);
  assert.equal(store.value.expired, true); assert.equal(store.value.data?.monitor?.availability.status, "available");
  await store.refresh(); assert.equal(store.tick(), false);
});

test("未知和原型属性 hash 回到概览，六个页面路由均有明确入口", () => {
  for (const id of ["overview", "tasks", "queue", "runs", "recovery", "settings"]) assert.equal(route("#" + id), id);
  for (const hash of ["", "#toString", "#__proto__", "#missing"]) assert.equal(route(hash), "overview");
});

test("GUI 查询复用监控循环，合并请求且不能绕过错误退避", async () => {
  for (const failing of [false, true]) {
    let time = epoch; const calls: number[] = [];
    const clock = { now: () => new Date(time) }, store = new SqliteStore(":memory:", clock);
    const repo = new SqliteMonitorRepository(store.database, "gui", policy, clock);
    let monitorLoop: ContinuousQuotaMonitor;
    monitorLoop = new ContinuousQuotaMonitor({ async read() {
      calls.push(time); if (failing) throw new AppError("CODEX_NETWORK_ERROR", "fixture");
      return { ...monitor().snapshot!, fetchedAt: new Date(time).toISOString() };
    } }, repo, clock, { async sleep(ms) { time += ms; monitorLoop.requestSample(); monitorLoop.requestSample(); } });
    try {
      await monitorLoop.run(new AbortController().signal, () => {}, 3);
      assert.deepEqual(calls.map((value) => value - epoch), failing ? [0, 10000, 30000] : [0, 1000, 2000]);
      assert.equal(repo.status()?.revision, 3);
    } finally { store.close(); }
  }
});
