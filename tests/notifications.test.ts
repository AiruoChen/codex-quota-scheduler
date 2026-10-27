import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { emptyCheckpoint, notificationTransition, noticeCopy, type DesktopFeed } from "../src/domain/notifications.js";
import { NotificationStore } from "../src/desktop/notification-store.js";
import { DesktopNotifications, type NoticeChannel } from "../src/desktop/notifications.js";
import { DesktopVisibility } from "../src/desktop/visibility.js";
import { route, routeRunId } from "../src/management/gui/shell.js";
import { readDesktopFeed, readFeedRequest } from "../src/adapters/http/desktop-protocol.js";

const date = new Date("2026-10-26T00:00:00Z"), scope = "a".repeat(64);
const feed = (): DesktopFeed => ({ provider: "mock", scope, cursor: { execution: 0, recovery: 0, quota: 0 }, baseline: false, pendingAttention: false, events: [], monitor: { failures: 0, errorCode: null } });

test("通知只处理状态变化；明确登录失效立即提醒，持续故障/恢复去重", () => {
  let state = emptyCheckpoint();
  const step = (value: DesktopFeed | null) => { const result = notificationTransition(state, value, date); state = result.checkpoint; return result.notices.map((notice) => notice.kind); };
  assert.deepEqual(step(feed()), []);
  const auth = feed(); auth.monitor = { errorCode: "CODEX_AUTH_REQUIRED", failures: 1 };
  assert.deepEqual(step(auth), ["login_required"]); assert.deepEqual(step(auth), []);
  auth.monitor.failures = 20; assert.deepEqual(step(auth), []);
  assert.deepEqual(step(null), []); assert.deepEqual(step(null), []); assert.deepEqual(step(null), ["service_failure"]); assert.deepEqual(step(null), []);
  assert.deepEqual(step(auth), ["service_recovered"]); assert.deepEqual(step(feed()), ["quota_recovered"]); assert.deepEqual(step(feed()), []);
  const broken = feed(); broken.monitor = { failures: 2, errorCode: "CODEX_RPC_FAILED" };
  assert.deepEqual(step(broken), []); broken.monitor.failures = 3; assert.deepEqual(step(broken), ["quota_failure"]); assert.deepEqual(step(broken), []);
  assert.deepEqual(step(feed()), ["quota_recovered"]);
});

test("相同事件和新来源待核对摘要只记录一次，计时不会凭空生成额度刷新", () => {
  const value = feed(); value.baseline = true; value.pendingAttention = true;
  const first = notificationTransition(emptyCheckpoint(), value, date);
  assert.deepEqual(first.notices.map((event) => event.kind), ["needs_attention"]);
  assert.deepEqual(notificationTransition(first.checkpoint, value, new Date(date.getTime() + 99999999)).notices, []);
  value.baseline = false; value.events = [{ key: "b".repeat(64), kind: "quota_reset", target: "overview", runId: null, createdAt: date.toISOString() }];
  const reset = notificationTransition(first.checkpoint, value, date); assert.equal(reset.notices[0]?.kind, "quota_reset");
  assert.deepEqual(notificationTransition(reset.checkpoint, value, date).notices, []);
});

test("检查点与记录先落盘再请求系统显示；重启不重复，关闭通知仍保留本地事件", async () => {
  const dir = await mkdtemp(join(tmpdir(), "notices-")), path = join(dir, "desktop.json");
  let calls = 0;
  const channel: NoticeChannel = { supported: () => true, close() {}, show(notice) { calls++; assert.ok(JSON.parse(readFileSync(path, "utf8")).history.some((row: { id: string }) => row.id === notice.id)); } };
  const value = feed(); value.cursor.execution = 1; value.events = [{ key: "c".repeat(64), kind: "task_succeeded", runId: "fixture-run", target: "runs", createdAt: date.toISOString() }];
  try {
    const first = new DesktopNotifications(new NotificationStore(path), channel, () => {}, { now: () => date }); await first.initialize(); await first.accept(value);
    assert.equal(calls, 1); const revision = first.state!.revision;
    await first.accept(value); assert.equal(first.state!.revision, revision); assert.equal(calls, 1); await first.close();
    const second = new DesktopNotifications(new NotificationStore(path), channel, () => {}, { now: () => date }); await second.initialize(); await second.accept(value); assert.equal(calls, 1);
    await second.preference("enabled"); value.events[0] = { ...value.events[0]!, key: "d".repeat(64), kind: "task_failed" }; value.cursor.execution++;
    await second.accept(value); assert.equal(calls, 1); assert.equal(second.state?.history.at(-1)?.delivery, "disabled");
    assert.equal(await second.explainClose(), true); assert.equal(await second.explainClose(), false);
    assert.ok(!Object.values(noticeCopy).some((copy) => /fixture-run|@|prompt|output/i.test(copy.title + copy.body)));
    await second.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("通知不支持或原生失败仍保存记录，额度刷新通知默认关闭，批量最多三条系统请求", async () => {
  const dir = await mkdtemp(join(tmpdir(), "notices-fallback-")), path = join(dir, "desktop.json");
  let supported = false, calls = 0, failed: (() => void) | undefined;
  const channel: NoticeChannel = { supported: () => supported, close() {}, show(_notice, failure) { calls++; failed = failure; } };
  const controller = new DesktopNotifications(new NotificationStore(path), channel, () => {});
  const value = feed();
  try {
    await controller.initialize();
    value.events = [{ key: "e".repeat(64), kind: "needs_attention", runId: "fixture", target: "runs", createdAt: date.toISOString() }];
    await controller.accept(value); assert.equal(controller.state!.history.at(-1)?.delivery, "unsupported");
    supported = true; value.events = [{ ...value.events[0]!, key: "f".repeat(64), kind: "quota_reset", runId: null, target: "overview" }];
    await controller.accept(value); assert.equal(calls, 0); assert.equal(controller.state!.history.at(-1)?.delivery, "disabled");
    await controller.preference("quotaReset"); value.events = Array.from({ length: 8 }, (_, index) => ({ key: String(index).repeat(64), kind: "task_succeeded", runId: `fixture-${index}`, target: "runs", createdAt: date.toISOString() }));
    await controller.accept(value); assert.equal(calls, 3); assert.equal(controller.state!.history.filter((item) => item.delivery === "local").length, 5);
    failed!(); await controller.store.settled(); assert.equal((await controller.store.load()).history.at(-1)?.delivery, "failed");
    await controller.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("桌面状态写锁/备份/损坏保护；并发偏好写入不覆盖彼此", async () => {
  const dir = await mkdtemp(join(tmpdir(), "notices-state-")), path = join(dir, "desktop.json"), store = new NotificationStore(path);
  try {
    await store.initialize();
    await Promise.all([store.update((state) => { state.settings.enabled = false; }), store.update((state) => { state.settings.quotaReset = true; })]);
    assert.deepEqual((await store.load()).settings, { enabled: false, quotaReset: true, closeExplained: false });
    assert.equal(JSON.parse(await readFile(path + ".bak", "utf8")).settings.enabled, false);
    await writeFile(path + ".lock", "other-owner"); await assert.rejects(store.update(() => {}), { code: "DESKTOP_STATE_BUSY" }); assert.equal(await readFile(path + ".lock", "utf8"), "other-owner");
    await rm(path + ".lock"); await writeFile(path, "broken-state");
    await assert.rejects(store.initialize(), { code: "DESKTOP_STATE_INVALID" }); assert.equal(await readFile(path, "utf8"), "broken-state");
    assert.equal(JSON.parse(await readFile(path + ".bak", "utf8")).settings.enabled, false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("托盘不可用和退出中不会隐藏窗口；关闭合并且保存期间开始退出时保留进度", async () => {
  let available = false, stopping = false, hidden = 0, fallback = 0, progress = 0, release!: (first: boolean) => void;
  const visibility = new DesktopVisibility({ available: () => available, stopping: () => stopping, explainOnce: () => new Promise((done) => { release = done; }), hide: () => { hidden++; }, unavailable: () => { fallback++; }, progress: () => { progress++; } });
  await visibility.hide(); assert.equal(fallback, 1); assert.equal(hidden, 0);
  available = true; const pending = visibility.hide(); assert.equal(visibility.hide(), pending); stopping = true; release(true); await pending;
  assert.equal(progress, 1); assert.equal(hidden, 0);
  stopping = false; const next = visibility.hide(); release(false); await next; assert.equal(hidden, 1);
});

test("通知协议校验来源/检查点并剔除额外载荷；深链接只读准确运行 ID", () => {
  const value = feed(); value.events = [{ key: "1".repeat(64), kind: "task_succeeded", runId: "fixture", target: "runs", createdAt: date.toISOString() }];
  const decoded = readDesktopFeed({ ...value, events: [{ ...value.events[0], prompt: "PRIVATE_SYNTHETIC_BODY" }] });
  assert.ok(!JSON.stringify(decoded).includes("PRIVATE_SYNTHETIC_BODY"));
  assert.throws(() => readFeedRequest(new URLSearchParams("scope=wrong")), { code: "INVALID_ARGUMENT" });
  assert.throws(() => readDesktopFeed({ ...value, cursor: { execution: -1 } }), { code: "RUNTIME_INCOMPATIBLE" });
  assert.equal(route("#runs/exact-id"), "runs"); assert.equal(routeRunId("#runs/exact-id"), "exact-id");
  assert.equal(routeRunId("#runs/%00"), null); assert.equal(routeRunId("#runs/%bad"), null); assert.equal(routeRunId("#overview/anything"), null);
});
