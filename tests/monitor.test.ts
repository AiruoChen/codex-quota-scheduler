import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { AppServerQuotaFeed } from "../src/adapters/codex/quota-feed.js";
import { defaultCodexOptions } from "../src/adapters/codex/launcher.js";
import { normalizeQuota } from "../src/adapters/codex/normalize-quota.js";
import type { MonitorState, MonitorUpdate } from "../src/domain/monitor.js";
import type { QuotaFeed, QuotaSnapshot } from "../src/domain/quota.js";
import { ContinuousQuotaMonitor } from "../src/monitor/continuous-monitor.js";
import { recognize } from "../src/monitor/recognize.js";
import { AppError } from "../src/shared/errors.js";
import { SqliteMonitorRepository } from "../src/storage/monitor-repository.js";
import { SqliteStore } from "../src/storage/sqlite-store.js";

const epoch = Date.parse("2026-10-20T00:00:00Z");
const options = { limitId: "codex", reservePercent: 10, quotaMaxAgeMs: 120000, pollIntervalMs: 1000 };
function snapshot(time = epoch, reset = epoch + 60000, short = 100, weekly = 20): QuotaSnapshot {
  return { ...normalizeQuota({ rateLimitsByLimitId: { codex: {
    primary: { usedPercent: short, windowDurationMins: 300, resetsAt: reset / 1000 },
    secondary: { usedPercent: weekly, windowDurationMins: 10080, resetsAt: (epoch + 86400000) / 1000 },
  } } }, new Date(time), "codex"), account: { type: "chatgpt", email: "monitor@example.test", workspaceId: null, planType: "plus" } };
}
function baseline() { return recognize(null, { snapshot: snapshot() }, options, new Date(epoch)).state; }
const resets = (update: ReturnType<typeof recognize> | MonitorUpdate) => update.events.filter((event) => event.type === "quota_reset");

test("刷新需新快照确认，同一窗口跨轮询和进程重启只记录一次", async () => {
  const dir = await mkdtemp(join(tmpdir(), "quota-history-"));
  let time = epoch;
  const clock = { now: () => new Date(time) };
  let store = new SqliteStore(join(dir, "state.sqlite"), clock);
  try {
    let repo = new SqliteMonitorRepository(store.database, "stream", options, clock);
    assert.equal(resets(repo.record({ snapshot: snapshot() })).length, 0);
    time += 61000;
    const refreshed = snapshot(time, epoch + 18060000, 5);
    assert.equal(resets(repo.record({ snapshot: refreshed })).length, 1);
    store.close(); store = new SqliteStore(join(dir, "state.sqlite"), clock);
    repo = new SqliteMonitorRepository(store.database, "stream", options, clock);
    assert.equal(resets(repo.record({ snapshot: refreshed })).length, 0);
    assert.equal(repo.events().filter((event) => event.type === "quota_reset").length, 1);
    assert.equal(repo.status()?.availability.status, "available");
    await store.check();
  } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
});

test("仅到达本地截止时间或使用比例下降不算窗口刷新", () => {
  for (const current of [snapshot(epoch + 61000, epoch + 60000, 0), snapshot(epoch + 1000, epoch + 60000, 0)]) {
    const update = recognize(baseline(), { snapshot: current }, options, new Date(current.fetchedAt));
    assert.equal(resets(update).length, 0);
    if (Date.parse(current.fetchedAt) > epoch + 60000) assert.equal(update.state.availability.status, "unknown");
  }
});

test("事件写入与状态检查点一起回滚，失败后不会丢失刷新", () => {
  let time = epoch;
  const clock = { now: () => new Date(time) };
  const store = new SqliteStore(":memory:", clock);
  const repo = new SqliteMonitorRepository(store.database, "atomic", options, clock);
  try {
    repo.record({ snapshot: snapshot() });
    store.database.connection.exec("CREATE TRIGGER fail_checkpoint BEFORE UPDATE ON quota_monitor_state BEGIN SELECT RAISE(ABORT, 'simulated I/O error'); END");
    time += 61000;
    const current = snapshot(time, epoch + 18060000, 0);
    assert.throws(() => repo.record({ snapshot: current }));
    assert.equal(repo.status()?.revision, 1);
    assert.equal(repo.events().filter((event) => event.type === "quota_reset").length, 0);
    store.database.connection.exec("DROP TRIGGER fail_checkpoint");
    assert.equal(resets(repo.record({ snapshot: current })).length, 1);
  } finally { store.close(); }
});

test("刷新历史清理后仍保留去重标识", () => {
  let time = epoch;
  const clock = { now: () => new Date(time) };
  const store = new SqliteStore(":memory:", clock);
  const repo = new SqliteMonitorRepository(store.database, "dedupe", options, clock);
  try {
    repo.record({ snapshot: snapshot() });
    time += 61000;
    const current = snapshot(time, epoch + 18060000, 0);
    assert.equal(resets(repo.record({ snapshot: current })).length, 1);
    store.database.connection.exec("DELETE FROM quota_monitor_events");
    time = epoch;
    repo.record({ snapshot: snapshot() }); // clock rollback establishes a new comparison baseline
    time += 61000;
    assert.equal(resets(repo.record({ snapshot: current })).length, 0);
  } finally { store.close(); }
});

test("短窗口刷新与周额度可用是两个独立判断", () => {
  const current = snapshot(epoch + 61000, epoch + 18060000, 0, 100);
  const update = recognize(baseline(), { snapshot: current }, options, new Date(current.fetchedAt));
  assert.equal(resets(update).length, 1);
  assert.deepEqual(update.state.availability, { status: "blocked", reason: "quota_exhausted" });
});

test("已知周窗口缺失不会变成可用；重新出现使用保留的边界", () => {
  const current = snapshot(epoch + 61000, epoch + 18060000, 0);
  current.buckets[0]!.windows.pop();
  const missing = recognize(baseline(), { snapshot: current }, options, new Date(current.fetchedAt));
  assert.deepEqual(missing.state.availability, { status: "unknown", reason: "missing_window" });
  const restored = recognize(missing.state, { snapshot: snapshot(epoch + 62000, epoch + 18060000, 0) }, options, new Date(epoch + 62000));
  assert.equal(restored.state.availability.status, "available");
  assert.equal(resets(restored).length, 0);
});

test("窗口整体缺失、空字段和未知身份不触发刷新", () => {
  for (const change of [(s: QuotaSnapshot) => { s.buckets = []; },
    (s: QuotaSnapshot) => { s.buckets[0]!.windows[0]!.remainingPercent = null; },
    (s: QuotaSnapshot) => { s.account = { type: "chatgpt", email: null, workspaceId: null, planType: "plus" }; }]) {
    const current = snapshot(epoch + 61000, epoch + 18060000, 0); change(current);
    const update = recognize(baseline(), { snapshot: current }, options, new Date(current.fetchedAt));
    assert.equal(resets(update).length, 0);
    assert.equal(update.state.availability.status, "unknown");
  }
});

test("账户、工作区、套餐和来源变化都重建基线", () => {
  for (const change of [(s: QuotaSnapshot) => { s.account!.email = "other@example.test"; },
    (s: QuotaSnapshot) => { s.account!.workspaceId = "workspace-other"; },
    (s: QuotaSnapshot) => { s.account!.planType = "pro"; },
    (s: QuotaSnapshot) => { s.source = "mock"; }]) {
    const current = snapshot(epoch + 61000, epoch + 18060000, 0); change(current);
    const update = recognize(baseline(), { snapshot: current }, options, new Date(current.fetchedAt));
    assert.equal(resets(update).length, 0);
    assert.ok(update.events.some((event) => event.type === "identity_changed"));
  }
});

test("持续未知身份不会反复产生身份切换事件", () => {
  const current = snapshot(); delete current.account;
  const first = recognize(null, { snapshot: current }, options, new Date(epoch));
  const second = recognize(first.state, { snapshot: current }, options, new Date(epoch));
  assert.equal(second.state.availability.reason, "identity_unknown");
  assert.equal(second.events.length, 0);
});

test("时长和窗口槽变化不会把另一窗口识别为刷新", () => {
  const current = snapshot(epoch + 61000, epoch + 18060000, 0);
  current.buckets[0]!.windows[0]!.durationMinutes = 60;
  assert.equal(resets(recognize(baseline(), { snapshot: current }, options, new Date(current.fetchedAt))).length, 0);
});

test("提前移动的重置边界、回退的边界和重复值不生成刷新", () => {
  const early = recognize(baseline(), { snapshot: snapshot(epoch + 1000, epoch + 18060000, 0) }, options, new Date(epoch + 1000));
  assert.equal(resets(early).length, 0);
  const later = recognize(early.state, { snapshot: snapshot(epoch + 61000, epoch + 18060000, 0) }, options, new Date(epoch + 61000));
  assert.equal(resets(later).length, 0);
  const regression = recognize(later.state, { snapshot: snapshot(epoch + 62000, epoch + 60000, 0) }, options, new Date(epoch + 62000));
  assert.equal(regression.state.windows[0]?.resetsAt, new Date(epoch + 18060000).toISOString());
  assert.equal(resets(recognize(regression.state, { snapshot: snapshot(epoch + 63000, epoch + 18060000, 0) }, options, new Date(epoch + 63000))).length, 0);
});

test("未来、陈旧和乱序快照不覆盖基线", () => {
  for (const time of [epoch + 1000, epoch - 121000, epoch - 1000]) {
    const update = recognize(baseline(), { snapshot: snapshot(time, epoch + 18060000, 0) }, options, new Date(epoch));
    assert.equal(update.state.errorCode, "STALE_QUOTA");
    assert.equal(update.state.snapshot?.fetchedAt, new Date(epoch).toISOString());
    assert.equal(resets(update).length, 0);
  }
});

test("系统时钟回退后重建比较基线，不误报刷新", () => {
  const update = recognize(baseline(), { snapshot: snapshot(epoch - 1000, epoch + 18060000, 0) }, options, new Date(epoch - 1000));
  assert.equal(resets(update).length, 0);
  assert.equal(update.state.errorCode, null);
  assert.ok(update.events.some((event) => event.type === "clock_changed"));
});

test("断网保留窗口但立即撤销可用状态，重复错误不刷事件", () => {
  const first = recognize(baseline(), { errorCode: "CODEX_NETWORK_ERROR" }, options, new Date(epoch + 1000));
  const second = recognize(first.state, { errorCode: "CODEX_NETWORK_ERROR" }, options, new Date(epoch + 2000));
  assert.equal(second.state.snapshot?.source, "codex");
  assert.equal(second.state.availability.status, "unknown");
  assert.equal(second.events.length, 0);
  const recovered = recognize(second.state, { snapshot: snapshot(epoch + 61000, epoch + 18060000, 0) }, options, new Date(epoch + 61000));
  assert.equal(resets(recovered).length, 1);
  assert.ok(recovered.events.some((event) => event.type === "read_recovered"));
});

test("只返回周窗口时不补造五小时；多额度桶各自识别刷新", () => {
  const onlyWeekly = snapshot(); onlyWeekly.buckets[0]!.windows.shift();
  const first = recognize(null, { snapshot: onlyWeekly }, options, new Date(epoch));
  assert.equal(first.state.availability.status, "available");
  assert.equal(first.state.windows.length, 1);
  const initial = snapshot(); initial.buckets.push({ ...structuredClone(initial.buckets[0]!), id: "other" });
  const prior = recognize(null, { snapshot: initial }, options, new Date(epoch));
  const current = snapshot(epoch + 61000, epoch + 18060000, 0); current.buckets.push({ ...structuredClone(current.buckets[0]!), id: "other" });
  assert.deepEqual(resets(recognize(prior.state, { snapshot: current }, options, new Date(epoch + 61000))).map((event) => event.data.bucketId), ["codex", "other"]);
  const after = recognize(prior.state, { snapshot: current }, options, new Date(epoch + 61000));
  const next = structuredClone(current); next.fetchedAt = new Date(epoch + 62000).toISOString();
  next.buckets[1]!.windows[0]!.resetsAt = new Date(epoch + 60000).toISOString();
  assert.equal(recognize(after.state, { snapshot: next }, options, new Date(epoch + 62000)).state.availability.status, "available");
});

test("离线查看状态重新计算新鲜度，存储损坏会明确失败", async () => {
  let time = epoch;
  const clock = { now: () => new Date(time) };
  const store = new SqliteStore(":memory:", clock);
  try {
    const repo = new SqliteMonitorRepository(store.database, "one", options, clock);
    repo.record({ snapshot: snapshot(epoch, epoch + 60000, 0) });
    time += 60001;
    assert.deepEqual(repo.status()?.availability, { status: "unknown", reason: "unknown_quota" });
    time += 60000;
    assert.deepEqual(repo.status()?.availability, { status: "unknown", reason: "stale_quota" });
    assert.equal(new SqliteMonitorRepository(store.database, "another", options, clock).status(), null);
    store.database.connection.prepare("UPDATE quota_monitor_state SET data_json='{}'").run();
    assert.throws(() => repo.status(), { code: "STORAGE_INVALID" });
    await assert.rejects(store.check(), { code: "STORAGE_INVALID" });
  } finally { store.close(); }
});

test("指数退避不会被通知风暴绕过，成功后恢复采样间隔", async () => {
  let time = epoch; const times: number[] = []; let hint: (() => void) | undefined; let closed = false;
  const clock = { now: () => new Date(time) };
  const store = new SqliteStore(":memory:", clock);
  const feed: QuotaFeed = {
    async read() { times.push(time - epoch); if (times.length <= 3) throw new AppError("CODEX_NETWORK_ERROR", "private error"); return snapshot(time, time + 3600000, 0); },
    subscribe(listener) { hint = listener; return () => { hint = undefined; }; }, async close() { closed = true; },
  };
  try {
    const monitor = new ContinuousQuotaMonitor(feed, new SqliteMonitorRepository(store.database, "retry", options, clock), clock,
      { async sleep(ms) { time += ms; hint?.(); } });
    const updates: MonitorUpdate[] = [];
    await monitor.run(new AbortController().signal, (update) => { updates.push(update); }, 5);
    assert.deepEqual(times, [0, 1000, 3000, 7000, 8000]);
    assert.equal(updates[3]?.state.failures, 0);
    assert.ok(closed); assert.equal(hint, undefined);
    assert.ok(!JSON.stringify(updates).includes("private error"));
  } finally { store.close(); }
});

test("到达服务端预计边界提前查询；睡眠唤醒立即重读", async () => {
  for (const wake of [false, true]) {
    let time = epoch; let calls = 0;
    const clock = { now: () => new Date(time) };
    const store = new SqliteStore(":memory:", clock);
    const policy = { ...options, pollIntervalMs: 60000 };
    try {
      const provider = { async read() { calls++; return snapshot(time, calls === 1 ? epoch + 2000 : time + 3600000, 0); } };
      const monitor = new ContinuousQuotaMonitor(provider, new SqliteMonitorRepository(store.database, "wake", policy, clock), clock,
        { async sleep(ms) { time += wake ? 3600000 : ms; } });
      await monitor.run(new AbortController().signal, () => {}, 2);
      assert.equal(calls, 2);
      assert.equal(time - epoch, wake ? 3600000 : 3000);
    } finally { store.close(); }
  }
});

test("停止监控清理订阅和连接，不留下失败样本", async () => {
  let time = epoch; let closed = false; let subscribed = false;
  const controller = new AbortController();
  const clock = { now: () => new Date(time) };
  const store = new SqliteStore(":memory:", clock);
  const repo = new SqliteMonitorRepository(store.database, "stop", options, clock);
  const feed: QuotaFeed = { async read() { return snapshot(time); },
    subscribe() { subscribed = true; return () => { subscribed = false; }; }, async close() { closed = true; } };
  try {
    const monitor = new ContinuousQuotaMonitor(feed, repo, clock, { async sleep(ms) { time += ms; controller.abort(); throw new Error("aborted"); } });
    await monitor.run(controller.signal, () => {});
    assert.equal(repo.status()?.revision, 1); assert.equal(repo.status()?.failures, 0);
    assert.ok(closed); assert.equal(subscribed, false);
  } finally { store.close(); }
});

test("存储或回调失败停止循环，不伪装成网络重试", async () => {
  const store = new SqliteStore(":memory:");
  const repo = new SqliteMonitorRepository(store.database, "corrupt", options);
  store.database.connection.prepare("INSERT INTO quota_monitor_state VALUES ('corrupt','{}')").run();
  try {
    const monitor = new ContinuousQuotaMonitor({ async read() { return snapshot(); } }, repo);
    await assert.rejects(monitor.sample(), { code: "STORAGE_INVALID" });
    let closed = false;
    const feed: QuotaFeed = { async read() { return snapshot(Date.now(), Date.now() + 3600000, 0); }, subscribe() { return () => {}; }, async close() { closed = true; } };
    const another = new ContinuousQuotaMonitor(feed, new SqliteMonitorRepository(store.database, "callback", options));
    await assert.rejects(another.run(new AbortController().signal, () => { throw new Error("consumer failed"); }), /consumer failed/);
    assert.equal(closed, true);
  } finally { store.close(); }
});

for (const scenario of ["monitor-notify", "monitor-exit"]) test(`${scenario} 通知或连接退出触发新读取并回收子进程`, async () => {
  const dir = await mkdtemp(join(tmpdir(), "quota-feed-"));
  const store = new SqliteStore(":memory:");
  const trace = join(dir, "trace.jsonl");
  const feed = new AppServerQuotaFeed({ ...defaultCodexOptions, executable: process.execPath,
    args: [resolve("tests/fixtures/fake-codex.mjs"), "--scenario", scenario, "--trace", trace], requestTimeoutMs: 3000, shutdownTimeoutMs: 200 });
  try {
    const policy = { ...options, pollIntervalMs: 60000 };
    const monitor = new ContinuousQuotaMonitor(feed, new SqliteMonitorRepository(store.database, scenario, policy));
    const updates: MonitorUpdate[] = [];
    await monitor.run(new AbortController().signal, (update) => { updates.push(update); }, 2);
    const events = (await readFile(trace, "utf8")).trim().split("\n").map((line: string) => JSON.parse(line) as Record<string, unknown>);
    assert.equal(events.filter((event) => event.method === "account/rateLimits/read").length, 2);
    const starts = events.filter((event) => typeof event.pid === "number");
    assert.equal(starts.length, scenario === "monitor-exit" ? 2 : 1);
    for (const start of starts) {
      // Windows can keep an exited process briefly visible after stdio closes.
      let exited = false;
      for (let attempt = 0; attempt < 40; attempt++) {
        try { process.kill(start.pid as number, 0); }
        catch { exited = true; break; }
        await delay(50);
      }
      assert.ok(exited, "monitor child is reaped after shutdown");
    }
    assert.equal(updates[1]?.state.failures, 0);
    assert.equal(resets(updates[1]!).length, 0);
  } finally { await feed.close(); store.close(); await rm(dir, { recursive: true, force: true }); }
});

test("账户在查询期间变化时拒绝整份快照", async () => {
  const feed = new AppServerQuotaFeed({ ...defaultCodexOptions, executable: process.execPath,
    args: [resolve("tests/fixtures/fake-codex.mjs"), "--scenario", "monitor-account-change"], requestTimeoutMs: 3000, shutdownTimeoutMs: 200 });
  try { await assert.rejects(feed.read(), { code: "CODEX_ACCOUNT_CHANGED" }); }
  finally { await feed.close(); }
});

test("重复账户套餐通知不当作切换账户，合并通知避免连续重查", async () => {
  const feed = new AppServerQuotaFeed({ ...defaultCodexOptions, executable: process.execPath,
    args: [resolve("tests/fixtures/fake-codex.mjs"), "--scenario", "monitor-account-notify"], requestTimeoutMs: 3000, shutdownTimeoutMs: 200 });
  let hints = 0;
  const unsubscribe = feed.subscribe(() => { hints++; });
  try {
    assert.equal((await feed.read()).source, "codex");
    assert.equal((await feed.read()).source, "codex");
    assert.equal(hints, 1);
  } finally { unsubscribe(); await feed.close(); }
});

test("CLI 有限监控输出 JSONL，重启可离线读取状态和事件", async () => {
  const dir = await mkdtemp(join(tmpdir(), "quota-cli-"));
  const config = join(dir, "config.json");
  try {
    await writeFile(config, JSON.stringify({ schemaVersion: 1, provider: "mock", ...options, tasksFile: "unused.json", storage: { databasePath: "state.sqlite" } }));
    const cli = (...args: string[]) => {
      const child = spawnSync(process.execPath, ["--experimental-sqlite", "dist/src/cli.js", "monitor", ...args, "--config", config], { encoding: "utf8", timeout: 15000 });
      assert.equal(child.status, 0, child.stderr); return child.stdout.trim();
    };
    const updates = cli("watch", "--samples", "2").split("\n").map((line) => JSON.parse(line) as MonitorUpdate);
    assert.equal(updates.length, 2); assert.equal(updates[1]?.state.snapshot?.source, "mock");
    const state = JSON.parse(cli("status")) as MonitorState; assert.equal(state.revision, 2);
    assert.ok(JSON.parse(cli("events")).some((event: { type: string }) => event.type === "baseline"));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
