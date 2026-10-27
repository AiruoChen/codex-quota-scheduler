import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { QuotaSnapshot } from "../src/domain/quota.js";
import { quotaDisplay } from "../src/management/quota-display.js";
import { recognize } from "../src/monitor/recognize.js";
import { SqliteMonitorRepository } from "../src/storage/monitor-repository.js";
import { SqliteStore } from "../src/storage/sqlite-store.js";

const epoch = Date.parse("2026-10-20T00:00:00Z");
const policy = { limitId: "codex", reservePercent: 10, quotaMaxAgeMs: 120000, pollIntervalMs: 1000 };
function snapshot(time: number, offset = 0, remaining = 50): QuotaSnapshot {
  return { source: "codex", fetchedAt: new Date(time).toISOString(),
    account: { type: "chatgpt", email: "quota@example.test", workspaceId: null, planType: "plus" },
    buckets: [{ id: "codex", name: null, planType: null, reachedType: null, windows: [
      { slot: "primary", durationMinutes: 300, usedPercent: 100 - remaining, remainingPercent: remaining, resetsAt: new Date(epoch + 60000 + offset).toISOString() },
      { slot: "secondary", durationMinutes: 10080, usedPercent: 20, remainingPercent: 80, resetsAt: new Date(epoch + 86400000 + offset).toISOString() },
    ] }] };
}
const initial = () => recognize(null, { snapshot: snapshot(epoch) }, policy, new Date(epoch)).state;

test("完整查询的双窗口正负一秒差异可显示读数，不生成刷新且保留较晚历史边界", () => {
  let prior = initial();
  for (const [index, offset] of [0, -1000, 0, 1000, 0, 1000].entries()) {
    const now = new Date(epoch + index * 1000);
    const update = recognize(prior, { snapshot: snapshot(now.getTime(), offset) }, policy, now);
    assert.equal(update.state.availability.status, "available");
    assert.deepEqual(quotaDisplay(update.state, policy, now).windows.map(w => w.remainingPercent), [50, 80]);
    assert.equal(update.events.filter(e => e.type === "quota_reset").length, 0);
    assert.ok(Date.parse(update.state.windows[0]!.resetsAt!) >= Date.parse(prior.windows[0]!.resetsAt!));
    prior = update.state;
  }
});

test("大于一秒回退、空边界、过期边界、缺失窗口和未知身份仍不放行", () => {
  for (const change of [
    (s: QuotaSnapshot) => { s.buckets[0]!.windows[0]!.resetsAt = new Date(epoch + 58999).toISOString(); },
    (s: QuotaSnapshot) => { s.buckets[0]!.windows[1]!.resetsAt = null; },
    (s: QuotaSnapshot) => { s.buckets[0]!.windows[0]!.resetsAt = new Date(epoch).toISOString(); },
    (s: QuotaSnapshot) => { s.buckets[0]!.windows.pop(); },
    (s: QuotaSnapshot) => { delete s.account; },
  ]) {
    const s = snapshot(epoch + 1000, -1000); change(s);
    const update = recognize(initial(), { snapshot: s }, policy, new Date(s.fetchedAt));
    assert.equal(update.state.availability.status, "unknown");
    assert.ok(quotaDisplay(update.state, policy, new Date(s.fetchedAt)).windows.every(w => w.remainingPercent === null));
    assert.equal(update.events.filter(e => e.type === "quota_reset").length, 0);
  }
});

test("截止时间附近的一秒修正不算刷新，当前窗口到期仍显示未知", () => {
  for (const offset of [-1000, 0, 1000]) {
    for (const time of [epoch + 60000, epoch + 61000]) {
      const s = snapshot(time, offset);
      const update = recognize(initial(), { snapshot: s }, policy, new Date(time));
      assert.equal(update.events.filter(e => e.type === "quota_reset").length, 0);
      if (Date.parse(s.buckets[0]!.windows[0]!.resetsAt!) <= time) {
        assert.equal(update.state.availability.status, "unknown");
        assert.ok(quotaDisplay(update.state, policy, new Date(time)).windows.every(w => w.remainingPercent === null));
      }
    }
  }
});

test("一秒兼容不会绕过耗尽、保留线、快照过期或查询失败", () => {
  for (const remaining of [0, 10]) {
    const s = snapshot(epoch + 1000, -1000, remaining);
    const update = recognize(initial(), { snapshot: s }, policy, new Date(s.fetchedAt));
    assert.equal(update.state.availability.status, "blocked");
  }
  for (const observation of [{ snapshot: snapshot(epoch - 120001, -1000) }, { errorCode: "CODEX_NETWORK_ERROR" }]) {
    assert.equal(recognize(initial(), observation, policy, new Date(epoch)).state.availability.status, "unknown");
  }
});

test("真正窗口推进仍须越过历史边界且完整重查，反复一秒差异不重复刷新", () => {
  let prior = initial();
  const events = [];
  for (const [index, offset] of [18000000, 17999000, 18000000, 18001000].entries()) {
    const now = new Date(epoch + 61000 + index * 1000);
    const update = recognize(prior, { snapshot: snapshot(now.getTime(), offset) }, policy, now);
    events.push(...update.events.filter(e => e.type === "quota_reset"));
    prior = update.state;
  }
  assert.equal(events.length, 1);
  assert.equal(events[0]?.data.slot, "primary");
});

test("已有未知检查点无需删库，重启后完整查询即可恢复显示且刷新去重不变", async () => {
  const dir = await mkdtemp(join(tmpdir(), "quota-boundary-"));
  let time = epoch;
  const clock = { now: () => new Date(time) };
  let store = new SqliteStore(join(dir, "state.sqlite"), clock);
  try {
    let repo = new SqliteMonitorRepository(store.database, "test", policy, clock);
    const state = repo.record({ snapshot: snapshot(time, 1000) }).state;
    state.snapshot = snapshot(time);
    state.availability = { status: "unknown", reason: "unknown_quota" };
    store.database.connection.prepare("UPDATE quota_monitor_state SET data_json=? WHERE stream_key=?").run(JSON.stringify(state), "test");
    store.close(); store = new SqliteStore(join(dir, "state.sqlite"), clock);
    repo = new SqliteMonitorRepository(store.database, "test", policy, clock);
    assert.equal(repo.status()?.availability.status, "unknown", "opening the database alone cannot restore quota");
    time += 1000;
    repo.record({ snapshot: snapshot(time) });
    assert.deepEqual(quotaDisplay(repo.status(), policy, clock.now()).windows.map(w => w.remainingPercent), [50, 80]);
    assert.equal(repo.events().filter(e => e.type === "quota_reset").length, 0);
    await store.check();
  } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
});
