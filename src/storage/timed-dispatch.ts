import { randomUUID } from "node:crypto";
import type { MonitorUpdate } from "../domain/monitor.js";
import type { TimedOccurrence, TimedPlan } from "../domain/timed-plan.js";
import { timedAdmission, TimedClockGuard } from "../domain/timed-plan.js";
import type { TaskRun } from "../domain/task.js";
import { AppError } from "../shared/errors.js";
import type { Database } from "./database.js";
import { readRun } from "./run-repository.js";
import { definitionOf } from "./task-repository.js";
import { ExecutionRepository } from "./execution-repository.js";
import { insertQueuePosition, reserveQueuePosition } from "./queue-position.js";
import { TimedPlanRepository } from "./timed-plan-repository.js";
import { readTimedOccurrence, timedNotice, timedOccurrences, timedPlans, writeTimedOccurrence, writeTimedPlan } from "./timed-records.js";

type Runtime = { startedAt: number; guard: TimedClockGuard };
const runtimes = new WeakMap<Database, Runtime>();
export interface TimedCandidate { plan: TimedPlan; occurrence: TimedOccurrence; priority: number; sequence: number }

/** All methods except maintain() are called inside the dispatcher's synchronous database transaction. */
export class TimedDispatch {
  private readonly runtime: Runtime;
  constructor(readonly plans: TimedPlanRepository, private readonly monotonic: () => number = () => plans.clock.monotonic?.() ?? performance.now()) {
    let runtime = runtimes.get(plans.db);
    if (!runtime) { runtime = { startedAt: plans.clock.now().getTime(), guard: new TimedClockGuard() }; runtimes.set(plans.db, runtime); }
    this.runtime = runtime;
  }
  maintain(update: MonitorUpdate): void {
    this.plans.db.transaction(() => { if (this.plans.state()?.revision === update.state.revision) this.maintainInside(update); });
  }
  maintainInside(update: MonitorUpdate): void {
    const { db, clock, context } = this.plans, now = clock.now().getTime(), fresh = this.plans.fresh(update.state);
    const active = timedPlans(db).filter(p => p.state === "enabled");
    const observedJump = this.runtime.guard.observe(now, this.monotonic());
    const clockChanged = active.length > 0 && (observedJump || update.events.some(e => e.type === "clock_changed"));
    for (const p of active) {
      const task = db.connection.prepare("SELECT definition_json,deleted_at FROM tasks WHERE id=?").get(p.input.taskId);
      const selected = p.input.window, bucket = fresh?.snapshot?.buckets.find(b => b.id === context.policy.limitId);
      const reason = clockChanged ? "clock_changed" : p.binding?.sourceKey !== context.sourceKey ? "source_changed"
        : fresh && p.binding.identity !== fresh.identity ? "account_changed"
        : fresh && p.binding.cliVersion !== (fresh.snapshot?.cli?.version ?? null) ? "cli_changed"
        : selected && bucket && !bucket.windows.some(w => w.slot === selected.slot && w.durationMinutes === selected.durationMinutes) ? "window_changed"
        : !task || task.deleted_at !== null || !definitionOf(JSON.parse(String(task.definition_json))).enabled ? "task_disabled" : null;
      if (reason) {
        this.plans.stopFutureInside(p.id, "plan_changed"); p.state = "paused"; p.reason = reason; p.revision++;
        p.updatedAt = clock.now().toISOString(); writeTimedPlan(db, p); timedNotice(db, clock, "timed_attention", p.id, null); continue;
      }
      this.plans.materializeInside(p);
      // Include every unstarted slot after a long offline interval, while bounding finished history work.
      const pending = db.connection.prepare("SELECT data_json FROM timed_occurrences WHERE plan_id=? AND json_extract(data_json,'$.state')='pending'").all(p.id).map(r => readTimedOccurrence(r.data_json));
      const relevant = new Map([...timedOccurrences(db, p.id, 40), ...pending].map(o => [o.id, o]));
      for (const o of relevant.values()) {
        if (o.state === "cancelled") continue;
        if (o.state === "pending") {
          if (o.runId) {
            const row = db.connection.prepare("SELECT data_json FROM runs WHERE id=?").get(o.runId);
            if (!row) throw new AppError("STORAGE_INVALID", "定时运行关联缺失。");
            const run = readRun(row.data_json);
            if (!["queued", "waiting_quota"].includes(run.status)) {
              o.state = run.status === "running" ? "dispatching" : "finished"; writeTimedOccurrence(db, o);
            }
          }
          if (o.state === "pending" && Date.parse(o.dueAt) <= now) {
            const cutoff = Math.max(this.runtime.startedAt, Date.parse(update.discontinuityAt ?? "") || 0);
            if (now > Date.parse(o.deadlineAt) || !p.input.catchUp && !o.runId && Date.parse(o.dueAt) < cutoff) {
              this.miss(o, now > Date.parse(o.deadlineAt) ? "deadline_expired" : "missed_offline");
            } else {
              if (o.sequence === null) { o.sequence = reserveQueuePosition(db); writeTimedOccurrence(db, o); }
              const wait = !fresh ? "quota_unknown" : db.connection.prepare("SELECT paused FROM scheduler_control WHERE singleton=1").get()?.paused === 1 ? "dispatch_paused"
                : db.connection.prepare("SELECT run_id FROM execution_lock").get() ? "waiting_execution"
                : fresh.availability.status !== "available" ? "waiting_quota" : "waiting_dispatch";
              if (wait !== "waiting_dispatch" || !["window_conflict", "protected_period"].includes(o.reason ?? "")) this.reason(o, wait);
            }
          }
        }
        this.observe(p, o, update);
      }
    }
    if (clockChanged) db.connection.prepare("UPDATE scheduler_control SET paused=1,reason='clock_changed',updated_at=? WHERE singleton=1").run(clock.now().toISOString());
  }
  private reason(o: TimedOccurrence, reason: string): void {
    if (o.reason !== reason) { o.reason = reason; writeTimedOccurrence(this.plans.db, o); }
  }
  private miss(o: TimedOccurrence, reason: string): void {
    const { db, clock } = this.plans;
    if (o.runId) {
      const row = db.connection.prepare("SELECT data_json FROM runs WHERE id=?").get(o.runId);
      if (row) {
        const run = readRun(row.data_json);
        if (["queued", "waiting_quota"].includes(run.status)) db.connection.prepare("UPDATE runs SET data_json=? WHERE id=?")
          .run(JSON.stringify({ ...run, status: "cancelled", completedAt: clock.now().toISOString(), error: "TIMED_DEADLINE: 已超过本实例启动有效期。" }), run.id);
      }
    }
    o.state = "missed"; o.reason = reason; writeTimedOccurrence(db, o); timedNotice(db, clock, "timed_missed", o.planId, o.id);
  }
  private observe(p: TimedPlan, o: TimedOccurrence, update: MonitorUpdate): void {
    if (!p.input.window || this.plans.clock.now().getTime() < Date.parse(o.dueAt)
      || this.plans.clock.now().getTime() > Date.parse(o.protectionEndAt!) + p.input.graceMinutes * 60000) return;
    const state = this.plans.fresh(update.state), window = state?.snapshot?.buckets.find(b => b.id === this.plans.context.policy.limitId)?.windows
      .find(w => w.slot === p.input.window!.slot && w.durationMinutes === p.input.window!.durationMinutes);
    const before = JSON.stringify(o.observation), previous = o.observation;
    const fetchedAt = window ? state!.snapshot!.fetchedAt : this.plans.clock.now().toISOString();
    const actual = window?.resetsAt ?? null;
    const observation: NonNullable<TimedOccurrence["observation"]> = { fetchedAt, actualResetAt: actual,
      remainingPercent: window?.remainingPercent ?? null,
      alignment: actual ? Math.abs(Date.parse(actual) - Date.parse(o.targetResetAt!)) <= 60000 ? "matching" : "different" : "unknown",
      ready: previous?.ready ?? "unknown", readyCheckedAt: previous?.readyCheckedAt ?? null,
      firstResetAt: previous?.firstResetAt ?? null, resetConfirmedAt: previous?.resetConfirmedAt ?? null };
    if (o.runId && actual && !observation.firstResetAt
      && this.plans.db.connection.prepare("SELECT sequence FROM execution_events WHERE run_id=? AND type='submission_started'").get(o.runId)) observation.firstResetAt = actual;
    if (previous?.actualResetAt && actual && Date.parse(actual) > Date.parse(previous.actualResetAt) + 1000
      && this.plans.clock.now().getTime() >= Date.parse(previous.actualResetAt)
      && update.events.some(e => e.type === "quota_reset" && e.data.bucketId === this.plans.context.policy.limitId)) observation.resetConfirmedAt ??= fetchedAt;
    const now = this.plans.clock.now().getTime(), start = Date.parse(o.startAt), wakeDeadline = start + p.input.graceMinutes * 60000;
    if (!observation.readyCheckedAt && now >= start && (window || now > wakeDeadline)) {
      observation.readyCheckedAt = fetchedAt;
      observation.ready = window && now <= wakeDeadline ? window.remainingPercent !== null && window.remainingPercent >= p.input.window.minPercent
        && state!.availability.status === "available" ? "met" : "not_met" : "unknown";
      timedNotice(this.plans.db, this.plans.clock, observation.ready === "met" ? "timed_ready" : "timed_attention", p.id, o.id);
    }
    o.observation = observation;
    if (JSON.stringify(observation) !== before) writeTimedOccurrence(this.plans.db, o);
  }
  candidates(): TimedCandidate[] {
    const { db, clock } = this.plans, now = clock.now().getTime(), state = this.plans.state();
    if (!this.plans.fresh(state)) return [];
    const protections = this.plans.protections(state, now), candidates: TimedCandidate[] = [];
    for (const p of timedPlans(db).filter(p => p.state === "enabled" && p.binding?.sourceKey === this.plans.context.sourceKey && p.binding.identity === state!.identity)) {
      for (const o of timedOccurrences(db, p.id, 40).filter(o => o.state === "pending" && o.sequence !== null && Date.parse(o.dueAt) <= now && now <= Date.parse(o.deadlineAt))) {
        if (protections.some(h => h.planId !== p.id || h.date !== o.date)) { this.reason(o, "protected_period"); continue; }
        const w = p.input.window;
        const actual = w ? state!.snapshot!.buckets.find(b => b.id === this.plans.context.policy.limitId)?.windows.find(v => v.slot === w.slot && v.durationMinutes === w.durationMinutes) : null;
        if (w && (!actual || actual.resetsAt && Math.abs(Date.parse(actual.resetsAt) - Date.parse(o.targetResetAt!)) > 60000)) {
          if (o.reason !== "window_conflict") timedNotice(db, clock, "timed_attention", p.id, o.id);
          this.reason(o, "window_conflict"); continue;
        }
        candidates.push({ plan: p, occurrence: o, priority: p.task.definition.priority, sequence: o.sequence! });
      }
    }
    return candidates.sort((a, b) => b.priority - a.priority || a.sequence - b.sequence);
  }
  claim(candidate: TimedCandidate): TaskRun {
    const { db, clock } = this.plans, p = this.plans.get(candidate.plan.id);
    const row = db.connection.prepare("SELECT data_json FROM timed_occurrences WHERE id=?").get(candidate.occurrence.id);
    if (!row) throw new AppError("TIMED_NOT_FOUND", "定时实例不存在。");
    const o = readTimedOccurrence(row.data_json), now = clock.now().getTime();
    if (p.state !== "enabled" || p.revision !== o.planRevision || o.state !== "pending" || o.sequence === null
      || now < Date.parse(o.dueAt) || now > Date.parse(o.deadlineAt)) throw new AppError("TIMED_CONFLICT", "计划或执行时刻已变化，请重新核对。");
    let id = o.runId;
    if (!id) {
      id = randomUUID();
      const run: TaskRun = { id, taskId: p.input.taskId, taskRevision: p.task.revision, taskSnapshot: structuredClone(p.task.definition),
        promptSnapshot: p.task.promptSnapshot, promptHash: p.task.promptHash, status: "queued", createdAt: clock.now().toISOString(),
        startedAt: null, completedAt: null, threadId: null, turnId: null, output: "", error: null,
        timed: { planId: p.id, occurrenceId: o.id, dueAt: o.dueAt, deadlineAt: o.deadlineAt, continuation: false } };
      readRun(JSON.stringify(run));
      db.connection.prepare("INSERT INTO runs VALUES (?,?,?)").run(id, run.taskId, JSON.stringify(run));
      db.connection.prepare("INSERT INTO timed_queue VALUES (?,?,?,?)").run(id, o.id, run.taskId, run.taskRevision);
      insertQueuePosition(db, id, o.sequence); o.runId = id;
    }
    const execution = new ExecutionRepository(db, clock), claimed = execution.claimInside(id, true);
    o.state = "dispatching"; o.reason = null; writeTimedOccurrence(db, o);
    execution.event(id, "timed_claimed", { planId: p.id, occurrenceId: o.id, dueAt: o.dueAt, actualAt: clock.now().toISOString() });
    return claimed;
  }
  completeInside(run: TaskRun): void {
    if (!run.timed || run.timed.continuation) return;
    const row = this.plans.db.connection.prepare("SELECT data_json FROM timed_occurrences WHERE id=?").get(run.timed.occurrenceId);
    if (!row) throw new AppError("STORAGE_INVALID", "定时实例关联缺失。");
    const o = readTimedOccurrence(row.data_json), p = this.plans.get(o.planId);
    const submitted = !!this.plans.db.connection.prepare("SELECT sequence FROM execution_events WHERE run_id=? AND type='submission_started'").get(run.id);
    if (run.status === "waiting_quota" && !submitted && p.state !== "enabled") this.plans.db.connection.prepare("UPDATE runs SET data_json=? WHERE id=?")
      .run(JSON.stringify({ ...run, status: "cancelled", completedAt: this.plans.clock.now().toISOString() }), run.id);
    o.state = run.status === "waiting_quota" && !submitted && p.state === "enabled" ? "pending" : "finished";
    o.reason = o.state === "pending" ? "waiting_quota" : run.status;
    if (run.error?.startsWith("TIMED_DEADLINE:") && !submitted) { o.state = "missed"; o.reason = "deadline_expired"; timedNotice(this.plans.db, this.plans.clock, "timed_missed", p.id, o.id); }
    writeTimedOccurrence(this.plans.db, o);
  }
  assertScheduledAllowed(run: TaskRun): void {
    if (run.timed) {
      const admission = timedAdmission(run.timed, this.plans.clock.now().getTime());
      if (admission) throw new AppError(admission === "not_due" ? "TIMED_NOT_DUE" : "TIMED_DEADLINE", "本实例不在允许启动的时段内，未发送指令。");
      const p = this.plans.get(run.timed.planId), state = this.plans.state();
      const row = this.plans.db.connection.prepare("SELECT data_json FROM timed_occurrences WHERE id=?").get(run.timed.occurrenceId);
      const occurrence = row ? readTimedOccurrence(row.data_json) : null;
      const live = this.plans.db.connection.prepare("SELECT deleted_at,definition_json FROM tasks WHERE id=?").get(run.taskId);
      if (p.state !== "enabled" || p.binding?.sourceKey !== this.plans.context.sourceKey || p.binding.identity !== state?.identity || p.binding.cliVersion !== (state?.snapshot?.cli?.version ?? null)
        || !occurrence || occurrence.planRevision !== p.revision || !live || live.deleted_at !== null || !definitionOf(JSON.parse(String(live.definition_json))).enabled) throw new AppError("TIMED_PLAN_CHANGED", "计划授权、任务状态或来源已变化，未发送指令。");
      if (!run.timed.continuation && p.input.window) {
        const fresh = this.plans.fresh(state), w = p.input.window;
        const actual = fresh?.snapshot?.buckets.find(b => b.id === this.plans.context.policy.limitId)?.windows.find(v => v.slot === w.slot && v.durationMinutes === w.durationMinutes);
        if (!actual || actual.resetsAt && Math.abs(Date.parse(actual.resetsAt) - Date.parse(occurrence.targetResetAt!)) > 60000) throw new AppError("TIMED_WINDOW_CHANGED", "提交前完整查询发现窗口冲突或数据不完整，请重新核对计划；未发送指令。");
      }
    }
    const allowed = run.timed && !run.timed.continuation ? run.timed : null;
    const own = allowed ? this.plans.db.connection.prepare("SELECT data_json FROM timed_occurrences WHERE id=?").get(allowed.occurrenceId) : null;
    const date = own ? readTimedOccurrence(own.data_json).date : null;
    if (this.plans.protections().some(h => h.planId !== allowed?.planId || h.date !== date)) throw new AppError("TIMED_PROTECTION_ACTIVE", "处于额度保护时段，等待其他已授权任务。");
  }
}
