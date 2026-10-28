import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { normalizeQuota } from "../src/adapters/codex/normalize-quota.js";
import { loadConfig } from "../src/config/load.js";
import { addDays, parseTimedPlan, planSlot, resolveLocal, skippedLocalDates, slotsNear, timedAdmission, TimedClockGuard, type TimedPlanInput } from "../src/domain/timed-plan.js";
import { ManualExecutionService } from "../src/executor/manual-service.js";
import { SqliteStore } from "../src/storage/sqlite-store.js";
import { TimedPlanRepository } from "../src/storage/timed-plan-repository.js";
import { TimedDispatch } from "../src/storage/timed-dispatch.js";
import { timedContext } from "../src/storage/timed-context.js";
import { SqliteMonitorRepository } from "../src/storage/monitor-repository.js";
import { SqliteSchedulerRepository } from "../src/storage/scheduler-repository.js";
import { desktopEvents } from "../src/storage/desktop-feed.js";
import { inspectProfileDatabase } from "../src/storage/profile-snapshot.js";
import { DatabaseSync } from "node:sqlite";
import { removableDispatchQueueView } from "../src/storage/database.js";

const epoch = Date.parse("2026-10-28T00:00:00Z");
const input = (patch: Partial<TimedPlanInput> = {}): TimedPlanInput => ({ name: "Morning", taskId: "one", taskRevision: 1,
  mode: "at_time", zone: "UTC", date: "2026-10-28", time: "00:05", repeat: "once", endDate: null, graceMinutes: 5, catchUp: false, window: null, ...patch });

async function setup(trigger: "available" | "refresh" = "available", initialReset?: number | null) {
  const dir = await mkdtemp(join(tmpdir(), "timed-isolated-"));
  const config = await loadConfig("config/codex.example.json"); config.storage.databasePath = join(dir, "data.sqlite");
  config.scheduler = { trigger }; let time = epoch, mono = 0;
  const clock = { now: () => new Date(time), monotonic: () => mono }, store = new SqliteStore(config.storage.databasePath, clock);
  const context = timedContext(config), plans = new TimedPlanRepository(store.database, context, clock), timed = new TimedDispatch(plans);
  const monitor = new SqliteMonitorRepository(store.database, context.streamKey, config, clock);
  const scheduler = new SqliteSchedulerRepository(store.database, context.streamKey, trigger, config, clock, timed);
  await store.tasks.create({ id: "one", name: "One", projectDir: dir, promptFile: join(dir, "unused.md"), enabled: true,
    priority: 10, session: { mode: "new" }, execution: { sandbox: "read-only", timeoutMs: 1000 } }, "PRIVATE_TIMED_PROMPT");
  function quota(used = 0, weekly = 0, reset: number | null = time + 3600000, duration = 300, email = "fixture@example.invalid") {
    return { ...normalizeQuota({ rateLimitsByLimitId: { codex: { primary: { usedPercent: used, windowDurationMins: duration, resetsAt: reset === null ? null : reset / 1000 },
      secondary: { usedPercent: weekly, windowDurationMins: 10080, resetsAt: (time + 86400000) / 1000 } } } }, clock.now(), "codex"),
    account: { type: "chatgpt" as const, email, planType: "plus", workspaceId: null } };
  }
  function sample(used = 0, weekly = 0, reset?: number | null, duration?: number, email?: string) { return monitor.record({ snapshot: quota(used, weekly, reset, duration, email) }); }
  sample(0, 0, initialReset); timed.maintain(sample(0, 0, initialReset));
  function enable(definition = input()) {
    const p = plans.save(definition), confirm = plans.confirmation(p.id, p.revision);
    return plans.enable(p.id, p.revision, confirm.context!, true, true, true);
  }
  async function finish(id: string, status: "succeeded" | "waiting_quota" | "needs_attention" = "succeeded") {
    await store.runs.update(id, { status, output: "", error: null }, "running"); store.execution.release(id);
  }
  return { dir, config, context, clock, store, plans, timed, monitor, scheduler, sample, quota, enable, finish,
    advance(ms: number) { time += ms; mono += ms; }, jump(ms: number) { time += ms; },
    async cleanup() { store.close(); await rm(dir, { recursive: true, force: true }); } };
}

test("时间公式使用服务端任意长度，跨午夜按目标日期归属", () => {
  const p = input({ zone: "Asia/Shanghai", time: "08:00", mode: "window", window: { slot: "primary", durationMinutes: 300, useMinutes: 120, minPercent: 90, protectMinutes: 240 } });
  const s = planSlot(p, p.date)!;
  assert.equal(s.dueAt, "2026-10-27T21:00:00.000Z"); assert.equal(s.startAt, "2026-10-28T00:00:00.000Z"); assert.equal(s.targetResetAt, "2026-10-28T02:00:00.000Z");
  const earlier = planSlot({ ...p, time: "01:00" }, p.date)!;
  assert.equal(earlier.dueAt, "2026-10-27T14:00:00.000Z");
  assert.equal(Date.parse(planSlot({ ...p, window: { ...p.window!, durationMinutes: 75, useMinutes: 15 } }, p.date)!.dueAt), Date.parse(s.startAt) - 3600000);
});

test("每日使用 IANA 当地时间；夏令时缺口跳过、重叠只取首次，不固定加24小时", () => {
  assert.equal(resolveLocal("2026-03-08", "02:30", "America/New_York"), null);
  const fold = resolveLocal("2026-11-01", "01:30", "America/New_York")!;
  assert.equal(new Date(fold.instant).toISOString(), "2026-11-01T05:30:00.000Z"); assert.equal(fold.ambiguous, true);
  const p = input({ date: "2026-03-07", time: "02:30", repeat: "daily", zone: "America/New_York" });
  const slots = slotsNear(p, Date.parse("2026-03-08T12:00Z")); assert.ok(!slots.some(s => s.date === "2026-03-08"));
  assert.deepEqual(skippedLocalDates(p, Date.parse("2026-03-08T12:00Z")), ["2026-03-08"]);
  assert.equal(Date.parse(planSlot(p, "2026-03-09")!.dueAt) - Date.parse(planSlot(p, "2026-03-07")!.dueAt), 47 * 3600000);
});

test("无效日期、时区、时长、结束日期及补执行字段严格拒绝", () => {
  for (const patch of [{ date: "2026-02-30" }, { zone: "Not/AZone" }, { time: "25:00" }, { catchUp: undefined }, { graceMinutes: 0 }, { endDate: "2026-01-01" }]) assert.throws(() => parseTimedPlan({ ...input(), ...patch }));
  for (const useMinutes of [-1, 0, 300]) assert.throws(() => parseTimedPlan(input({ mode: "window", window: { slot: "primary", durationMinutes: 300, useMinutes, minPercent: 90, protectMinutes: 240 } })));
  assert.equal(addDays("2026-12-31", 1), "2027-01-01");
});

test("保存只生成草稿，启用必须确认真实新鲜来源与当前上下文，始终不恢复派发", async () => {
  const e = await setup(); try {
    const p = e.plans.save(input()); assert.equal((await e.store.runs.recent()).length, 0); assert.equal(e.plans.list()[0]!.occurrences.length, 0);
    const c = e.plans.confirmation(p.id, p.revision);
    assert.throws(() => e.plans.enable(p.id, p.revision, c.context!, false, false, false), { code: "CONFIRM_REQUIRED" });
    assert.throws(() => e.plans.enable(p.id, p.revision, "wrong", true, true, true), { code: "TIMED_CONTEXT_CHANGED" });
    assert.throws(() => e.plans.enable(p.id, 999, c.context!, true, true, true), { code: "TIMED_CONFLICT" });
    const enabled = e.plans.enable(p.id, p.revision, c.context!, true, false, false);
    assert.equal(e.scheduler.status().paused, true); assert.equal((await e.store.runs.recent()).length, 0);
    assert.throws(() => e.plans.enable(enabled.id, enabled.revision, "wrong", true, true, true), { code: "TIMED_ALREADY_ENABLED" });
    await e.store.check();
  } finally { await e.cleanup(); }
});

test("过去单次、模拟来源和未知额度不能静默启用", async () => {
  const e = await setup(); try {
    assert.throws(() => e.plans.save(input({ time: "00:00" })), { code: "TIMED_PAST" });
    const p = e.plans.save(input()); const mock = new TimedPlanRepository(e.store.database, { ...e.context, provider: "mock" }, e.clock);
    assert.throws(() => mock.enable(p.id, p.revision, "", true, true, true), { code: "TIMED_REQUIRES_QUOTA" });
    e.monitor.record({ errorCode: "CODEX_AUTH_REQUIRED" }); assert.equal(e.plans.confirmation(p.id, p.revision).canEnable, false);
    assert.throws(() => e.plans.enable(p.id, p.revision, "", true, true, true), { code: "TIMED_REQUIRES_QUOTA" });
  } finally { await e.cleanup(); }
});

test("到时独立于 refresh 触发，不消耗凭据，不重复领取；初始暂停及互斥仍有效", async () => {
  const e = await setup("refresh"); try {
    const p = e.enable(), token = e.scheduler.acquire(); e.scheduler.resume();
    assert.equal(e.scheduler.claimNext(token, e.sample()).action, "wait");
    e.advance(300000); const update = e.sample();
    const d = e.scheduler.claimNext(token, update); assert.equal(d.action, "run"); if (d.action !== "run") return;
    assert.equal(d.run.timed?.planId, p.id); assert.equal(d.run.promptSnapshot, "PRIVATE_TIMED_PROMPT");
    assert.equal(e.scheduler.claimNext(token, update).action, "wait");
    assert.throws(() => e.store.execution.claim(d.run.id), { code: "TIMED_SCHEDULER_ONLY" });
    e.store.execution.event(d.run.id, "submission_started", {}); await e.finish(d.run.id); e.scheduler.complete(token, d.run.id);
    assert.equal(e.scheduler.claimNext(token, e.sample()).action, "wait");
    assert.equal(e.plans.list()[0]!.occurrences[0]!.state, "finished");
    assert.equal(e.store.database.connection.prepare("SELECT grant_key FROM scheduler_streams").get()?.grant_key, null);
    e.scheduler.release(token); await e.store.check();
  } finally { await e.cleanup(); }
});

test("每日同一任务版本生成不同实例和运行；普通队列版本去重保持不变", async () => {
  const e = await setup(); try {
    e.enable(input({ repeat: "daily" })); const ordinary = e.scheduler.enqueue("one"); assert.equal(e.scheduler.enqueue("one").id, ordinary.id);
    e.scheduler.remove(ordinary.id); const token = e.scheduler.acquire(); e.scheduler.resume(); const ids: string[] = [];
    for (let day = 0; day < 2; day++) {
      e.advance(day === 0 ? 300000 : 86400000); const d = e.scheduler.claimNext(token, e.sample()); assert.equal(d.action, "run");
      if (d.action === "run") { ids.push(d.run.id); await e.finish(d.run.id); e.scheduler.complete(token, d.run.id); }
    }
    assert.equal(new Set(ids).size, 2); assert.equal((await e.store.runs.recent()).filter(r => r.timed).every(r => r.taskRevision === 1), true);
    e.scheduler.release(token); await e.store.check();
  } finally { await e.cleanup(); }
});

test("定时候选按优先级参与公共排序，已有 refresh 凭据留给普通队列", async () => {
  const e = await setup("refresh"); try {
    await e.store.tasks.create({ id: "higher", name: "Higher", enabled: true, projectDir: e.dir, promptFile: "unused.md", priority: 100, session: { mode: "new" } }, "Synthetic higher priority");
    e.enable(input({ taskId: "higher", time: "01:05" })); const ordinary = e.scheduler.enqueue("one"), token = e.scheduler.acquire(); e.scheduler.resume();
    e.advance(65 * 60000); const update = e.sample(0, 0, epoch + 7200000);
    assert.ok(update.events.some(v => v.type === "quota_reset"));
    const d = e.scheduler.claimNext(token, update); assert.equal(d.action, "run"); if (d.action !== "run") return;
    assert.equal(d.run.taskId, "higher"); const stream = e.store.database.connection.prepare("SELECT grant_key,run_id FROM scheduler_streams").get()!;
    assert.ok(stream.grant_key); assert.equal(stream.run_id, null); await e.finish(d.run.id); e.scheduler.complete(token, d.run.id);
    const next = e.scheduler.claimNext(token, update); assert.equal(next.action, "run"); if (next.action === "run") { assert.equal(next.run.id, ordinary.id); await e.finish(next.run.id); }
    e.scheduler.release(token); await e.store.check();
  } finally { await e.cleanup(); }
});

test("同优先级按稳定入队顺序；两个调度写者不能重复取得同一定时实例", async () => {
  const e = await setup(); try {
    e.enable(); const ordinary = e.scheduler.enqueue("one"), token = e.scheduler.acquire(); e.scheduler.resume(); e.advance(300000);
    const update = e.sample(), d = e.scheduler.claimNext(token, update); assert.equal(d.action, "run"); if (d.action !== "run") return;
    assert.equal(d.run.id, ordinary.id); await e.finish(d.run.id); e.scheduler.complete(token, d.run.id);
    const timed = e.scheduler.claimNext(token, update); assert.equal(timed.action, "run");
    const other = new SqliteSchedulerRepository(e.store.database, e.context.streamKey, "available", e.config, e.clock, e.timed);
    assert.throws(() => other.acquire(), { code: "SCHEDULER_BUSY" });
    assert.equal(other.claimNext(token, update).action, "wait");
    if (timed.action === "run") await e.finish(timed.run.id); e.scheduler.release(token); await e.store.check();
  } finally { await e.cleanup(); }
});

test("计划固定旧任务版本，编辑任务不替换快照；停用会暂停计划", async () => {
  const e = await setup(); try {
    const p = e.enable(), task = (await e.store.tasks.get("one"))!;
    await e.store.tasks.update({ ...task, name: "Edited" }, "NEW_PRIVATE_PROMPT", 1);
    e.advance(300000); const token = e.scheduler.acquire(); e.scheduler.resume(); const d = e.scheduler.claimNext(token, e.sample());
    assert.equal(d.action, "run"); if (d.action === "run") { assert.equal(d.run.taskRevision, 1); assert.equal(d.run.promptSnapshot, "PRIVATE_TIMED_PROMPT"); await e.finish(d.run.id); e.scheduler.complete(token, d.run.id); }
    await e.store.tasks.update({ ...(await e.store.tasks.get("one"))!, enabled: false }, "NEW_PRIVATE_PROMPT", 2);
    e.timed.maintain(e.sample()); assert.equal(e.plans.get(p.id).reason, "task_disabled");
    e.scheduler.release(token);
  } finally { await e.cleanup(); }
});

test("额度保留线、周额度、未知数据及到时暂停都阻断，截止后只记错过", async () => {
  const e = await setup(); try {
    e.enable(); const token = e.scheduler.acquire(); e.advance(300000);
    assert.equal(e.scheduler.claimNext(token, e.sample()).action, "wait"); e.scheduler.resume();
    for (const [used, week] of [[100, 0], [0, 100], [95, 0]]) assert.equal(e.scheduler.claimNext(token, e.sample(used, week)).action, "wait");
    assert.equal(e.scheduler.claimNext(token, e.monitor.record({ errorCode: "CODEX_QUERY_FAILED" })).action, "wait");
    e.advance(300001); assert.equal(e.scheduler.claimNext(token, e.sample()).action, "wait");
    assert.equal(e.plans.list()[0]!.occurrences[0]!.state, "missed"); assert.equal((await e.store.runs.recent()).length, 0); e.scheduler.release(token);
  } finally { await e.cleanup(); }
});

test("离线错过默认跳过；显式补执行仅限有效期", async () => {
  for (const catchUp of [false, true]) {
    const e = await setup(); try {
      e.enable(input({ catchUp })); e.advance(301000); const token = e.scheduler.acquire(); e.scheduler.resume();
      const update = { ...e.sample(), discontinuityAt: e.clock.now().toISOString() };
      const d = e.scheduler.claimNext(token, update); assert.equal(d.action, catchUp ? "run" : "wait");
      if (d.action === "run") { await e.finish(d.run.id); e.scheduler.complete(token, d.run.id); }
      else assert.equal(e.plans.list()[0]!.occurrences[0]!.reason, "missed_offline");
      e.scheduler.release(token);
    } finally { await e.cleanup(); }
  }
});

test("向前或向后时钟跳变暂停定时及全局派发，不制造刷新", async () => {
  for (const jump of [10000, -10000]) {
    const e = await setup(); try {
      const p = e.enable(); e.jump(jump); const update = e.sample(); e.timed.maintain(update);
      assert.equal(e.plans.get(p.id).reason, "clock_changed"); assert.equal(e.scheduler.status().paused, true);
      assert.ok(!update.events.some(v => v.type === "quota_reset"));
    } finally { await e.cleanup(); }
  }
  const guard = new TimedClockGuard(); assert.equal(guard.observe(0, 0), false); assert.equal(guard.observe(86400000, 86400000), false);
});

test("保护阻止普通自动任务和未确认手动执行，自己的预触发可执行，暂停撤销保护", async () => {
  const e = await setup(); try {
    const p = e.enable(input({ mode: "window", time: "03:05", window: { slot: "primary", durationMinutes: 300, useMinutes: 120, minPercent: 90, protectMinutes: 240 } }));
    const ordinary = e.scheduler.enqueue("one"), token = e.scheduler.acquire(); e.scheduler.resume(); e.advance(300000);
    assert.throws(() => e.plans.assertManualAllowed(false), { code: "TIMED_PROTECTION_CONFIRM_REQUIRED" }); e.plans.assertManualAllowed(true);
    const d = e.scheduler.claimNext(token, e.sample(0, 0, epoch + (5 * 60 + 5) * 60000)); assert.equal(d.action, "run");
    if (d.action === "run") { assert.ok(d.run.timed); await e.finish(d.run.id); e.scheduler.complete(token, d.run.id); }
    assert.equal(e.scheduler.claimNext(token, e.sample()).action, "wait"); assert.equal((await e.store.runs.get(ordinary.id))!.status, "queued");
    e.plans.setState(p.id, p.revision, "paused"); assert.equal(e.plans.protections().length, 0);
    const next = e.scheduler.claimNext(token, e.sample(0, 0, epoch + 305 * 60000)); assert.equal(next.action, "run"); if (next.action === "run") await e.finish(next.run.id);
    e.scheduler.release(token); await e.store.check();
  } finally { await e.cleanup(); }
});

test("保护冲突拒绝启用，边界不符不发送也不重复通知，窗口长度更改要求重新确认", async () => {
  const e = await setup(); try {
    const definition = input({ mode: "window", time: "03:05", window: { slot: "primary", durationMinutes: 300, useMinutes: 120, minPercent: 90, protectMinutes: 240 } });
    const p = e.enable(definition), second = e.plans.save({ ...definition, name: "Other" }), c = e.plans.confirmation(second.id, second.revision);
    assert.equal(c.conflicts.length, 1); assert.throws(() => e.plans.enable(second.id, second.revision, c.context!, true, true, true), { code: "TIMED_PROTECTION_CONFLICT" });
    e.advance(300000); const token = e.scheduler.acquire(); e.scheduler.resume();
    for (let i = 0; i < 3; i++) assert.equal(e.scheduler.claimNext(token, e.sample()).action, "wait");
    assert.equal(e.plans.list()[0]!.occurrences[0]!.reason, "window_conflict");
    assert.equal(e.store.database.connection.prepare("SELECT count(*) AS n FROM recovery_events WHERE type='timed_attention'").get()?.n, 1);
    e.timed.maintain(e.sample(0, 0, undefined, 75)); assert.equal(e.plans.get(p.id).reason, "window_changed"); assert.equal(e.plans.protections().length, 0);
    e.scheduler.release(token);
  } finally { await e.cleanup(); }
});

test("最终提交前重新核验保护和计划授权；手动覆盖必须显式且只绑定本次运行", async () => {
  const e = await setup(); try {
    const p = e.enable(input({ mode: "window", time: "03:05", window: { slot: "primary", durationMinutes: 300, useMinutes: 120, minPercent: 90, protectMinutes: 240 } }));
    e.advance(300000); let sends = 0;
    const manual = new ManualExecutionService(e.config, e.store, e.clock, { async execute(_r, _s, sink) { sink.admit?.(); sink.submitted(); sends++; return { status: "succeeded", output: "", error: null }; } });
    await assert.rejects(manual.runTask("one", new AbortController().signal), { code: "TIMED_PROTECTION_CONFIRM_REQUIRED" });
    const run = await manual.runTask("one", new AbortController().signal, undefined, 1, true);
    assert.equal(run.status, "succeeded"); assert.equal(sends, 1); assert.equal(e.store.execution.events(run.id).some(v => v.type === "timed_manual_confirmed"), true);
    e.plans.setState(p.id, p.revision, "cancelled"); assert.equal(e.plans.protections().length, 0);
  } finally { await e.cleanup(); }
});

test("修改计划需重新授权；已消费实例跨编辑、重启不得重发，遗留执行权不释放", async () => {
  const e = await setup(); try {
    const p = e.enable(), token = e.scheduler.acquire(); e.scheduler.resume(); e.advance(300000);
    const d = e.scheduler.claimNext(token, e.sample()); assert.equal(d.action, "run"); if (d.action !== "run") return;
    const replacement = new TimedDispatch(new TimedPlanRepository(e.store.database, e.context, e.clock)); replacement.maintain(e.sample());
    assert.equal(e.store.execution.active()?.runId, d.run.id); assert.equal(e.scheduler.claimNext(token, e.sample()).action, "wait");
    await e.finish(d.run.id); e.scheduler.complete(token, d.run.id);
    const draft = e.plans.save(input({ time: "00:09" }), p.id, p.revision); assert.equal(draft.state, "draft");
    assert.throws(() => e.plans.enable(draft.id, draft.revision, e.plans.confirmation(draft.id, draft.revision).context!, true, true, true), { code: "TIMED_PAST" });
    assert.equal((await e.store.runs.recent()).length, 1); e.scheduler.release(token); await e.store.check();
  } finally { await e.cleanup(); }
});

test("新鲜账户变化暂停并撤销保护；修改保留线不改变来源标识", async () => {
  const e = await setup(); try {
    const p = e.enable(); assert.equal(timedContext({ ...e.config, reservePercent: 30 }).sourceKey, e.context.sourceKey);
    e.timed.maintain(e.sample(0, 0, undefined, undefined, "other@example.invalid")); assert.equal(e.plans.get(p.id).reason, "account_changed");
  } finally { await e.cleanup(); }
});

test("窗口目标只由完整查询评估，到时不制造重置；通知只含固定分类且游标去重", async () => {
  const e = await setup(); try {
    e.enable(input({ mode: "window", time: "03:05", window: { slot: "primary", durationMinutes: 300, useMinutes: 120, minPercent: 90, protectMinutes: 240 } }));
    const base = desktopEvents(e.store.database, "fixture", null, [], () => true).cursor;
    e.advance(185 * 60000); const update = e.sample(20); e.timed.maintain(update);
    const o = e.plans.list()[0]!.occurrences.find(v => v.date === "2026-10-28")!;
    assert.equal(o.observation?.ready, "not_met"); assert.equal(o.observation?.resetConfirmedAt, null);
    const feed = desktopEvents(e.store.database, "fixture", base, [], () => true);
    assert.ok(feed.events.some(v => v.kind === "timed_attention" && v.target === "schedules"));
    assert.ok(!JSON.stringify(feed).includes("PRIVATE")); assert.ok(!JSON.stringify(feed).includes(e.dir)); assert.ok(!JSON.stringify(feed).includes("fixture@example"));
    assert.deepEqual(desktopEvents(e.store.database, "fixture", feed.cursor, [], () => true).events, []);
  } finally { await e.cleanup(); }
});

test("deadline 仅限制初次发送，额度中断续接仍走既有证据链", () => {
  const link = { planId: "one", occurrenceId: "two", dueAt: new Date(epoch).toISOString(), deadlineAt: new Date(epoch + 60000).toISOString(), continuation: false };
  assert.equal(timedAdmission(link, epoch - 1), "not_due"); assert.equal(timedAdmission(link, epoch), null); assert.equal(timedAdmission(link, epoch + 60001), "expired");
  assert.equal(timedAdmission({ ...link, continuation: true }, epoch + 86400000), null);
});

test("初始完整额度未提供重置时间时，仅经实验和保护确认后允许一个预触发实例，不虚报对齐", async () => {
  const e = await setup("available", null); try {
    const definition = input({ mode: "window", time: "03:05", window: { slot: "primary", durationMinutes: 300, useMinutes: 120, minPercent: 90, protectMinutes: 240 } });
    const draft = e.plans.save(definition), context = e.plans.confirmation(draft.id, draft.revision).context!;
    assert.throws(() => e.plans.enable(draft.id, draft.revision, context, true, false, true), { code: "CONFIRM_REQUIRED" });
    e.plans.enable(draft.id, draft.revision, context, true, true, true); const token = e.scheduler.acquire(); e.scheduler.resume(); e.advance(300000);
    const d = e.scheduler.claimNext(token, e.sample(0, 0, null)); assert.equal(d.action, "run");
    if (d.action === "run") { e.timed.assertScheduledAllowed(d.run); e.store.execution.event(d.run.id, "submission_started", {}); await e.finish(d.run.id); e.scheduler.complete(token, d.run.id); }
    e.timed.maintain(e.sample(0, 0, null));
    assert.equal(e.plans.list()[0]!.occurrences[0]!.observation?.alignment, "unknown");
    assert.equal(e.scheduler.claimNext(token, e.sample(0, 0, null)).action, "wait"); e.scheduler.release(token);
  } finally { await e.cleanup(); }
});

test("截止前最终核验仍拒绝已暂停的计划或变化后的 CLI，不接受旧启用确认", async () => {
  const e = await setup(); try {
    const p = e.enable(), token = e.scheduler.acquire(); e.scheduler.resume(); e.advance(300000);
    const d = e.scheduler.claimNext(token, e.sample()); assert.equal(d.action, "run");
    if (d.action === "run") {
      const changed = e.monitor.record({ snapshot: { ...e.quota(), cli: { version: "1.0.0-fixture" } } });
      assert.throws(() => e.timed.assertScheduledAllowed(d.run), { code: "TIMED_PLAN_CHANGED" });
      e.timed.maintain(changed); assert.equal(e.plans.get(p.id).reason, "cli_changed"); await e.finish(d.run.id);
    }
    e.scheduler.release(token);
  } finally { await e.cleanup(); }
});

test("schema10→11保留任务、运行、队列移除与身份；备份包含计划且完整性检查有效", async () => {
  const e = await setup(); try {
    const run = e.scheduler.enqueue("one"); e.scheduler.remove(run.id); e.store.close();
    const old = new DatabaseSync(e.config.storage.databasePath);
    old.exec(`DROP VIEW dispatch_queue; DROP TABLE timed_queue; DROP TABLE timed_occurrences; DROP TABLE timed_plans; DROP TABLE queue_order; ${removableDispatchQueueView}; PRAGMA user_version=10`); old.close();
    const migrated = new SqliteStore(e.config.storage.databasePath, e.clock);
    try {
      assert.equal((await migrated.tasks.get("one"))!.revision, 1); assert.ok(await migrated.runs.get(run.id));
      assert.equal(migrated.database.connection.prepare("SELECT count(*) AS n FROM queue_removals").get()?.n, 1);
      const plans = new TimedPlanRepository(migrated.database, e.context, e.clock); plans.save(input());
      const backup = migrated.database.backup(join(e.dir, "backup.sqlite")); assert.equal(inspectProfileDatabase(backup).schema, 11);
      await migrated.check();
    } finally { migrated.close(); }
  } finally { await e.cleanup(); }
});
