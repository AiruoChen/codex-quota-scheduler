import { randomUUID } from "node:crypto";
import type { Clock } from "../domain/ports.js";
import type { MonitorState } from "../domain/monitor.js";
import type { TimedPlan, TimedPlanInput, TimedOccurrence } from "../domain/timed-plan.js";
import { localParts, parseTimedPlan, skippedLocalDates, slotsNear, TimedPlanError } from "../domain/timed-plan.js";
import { hasQuotaIdentity } from "../domain/quota-policy.js";
import type { MonitorOptions } from "../monitor/recognize.js";
import { digest } from "../monitor/recognize.js";
import { AppError } from "../shared/errors.js";
import type { Database } from "./database.js";
import { readMonitorState } from "./monitor-repository.js";
import { definitionOf, promptHash } from "./task-repository.js";
import { readRun } from "./run-repository.js";
import { getTimedPlan, readTimedOccurrence, timedNotice, timedOccurrences, timedPlans, timedPlanView, writeTimedOccurrence, writeTimedPlan } from "./timed-records.js";
import { ContinuationRepository } from "./continuation-repository.js";

export interface TimedContext { provider: "mock" | "codex"; streamKey: string; sourceKey: string; policy: MonitorOptions }

export class TimedPlanRepository {
  constructor(readonly db: Database, readonly context: TimedContext, readonly clock: Clock) {}
  state(): MonitorState | null {
    const row = this.db.connection.prepare("SELECT data_json FROM quota_monitor_state WHERE stream_key=?").get(this.context.streamKey);
    return row ? readMonitorState(String(row.data_json)) : null;
  }
  fresh(state = this.state()): MonitorState | null {
    const age = this.clock.now().getTime() - Date.parse(state?.snapshot?.fetchedAt ?? "");
    return state && !state.errorCode && state.snapshot?.source === "codex" && hasQuotaIdentity(state.snapshot.account)
      && state.identity && state.availability.status !== "unknown" && age >= 0 && age <= this.context.policy.quotaMaxAgeMs ? state : null;
  }
  list() {
    const now = this.clock.now().getTime();
    return timedPlans(this.db).map(p => ({ ...timedPlanView(p),
      next: slotsNear(p.input, now).filter(s => Date.parse(s.dueAt) > now && !this.consumed(p.id, s.date)).at(0) ?? null,
      occurrences: timedOccurrences(this.db, p.id).map(o => {
        const row = o.runId ? this.db.connection.prepare("SELECT data_json FROM runs WHERE id=?").get(o.runId) : null;
        const run = row ? readRun(row.data_json) : null;
        const event = o.runId ? this.db.connection.prepare("SELECT created_at FROM execution_events WHERE run_id=? AND type='submission_started' ORDER BY sequence LIMIT 1").get(o.runId) : null;
        return { ...o, actualStartedAt: run?.startedAt ?? null, submittedAt: event ? String(event.created_at) : null, runStatus: run?.status ?? null };
      }) }));
  }
  get(id: string): TimedPlan { return getTimedPlan(this.db, id); }
  private consumed(id: string, date: string): boolean {
    const row = this.db.connection.prepare("SELECT data_json FROM timed_occurrences WHERE plan_id=? AND target_date=?").get(id, date);
    if (!row) return false;
    const o = readTimedOccurrence(row.data_json);
    return !!o.runId || o.state === "missed" || o.state === "finished" || o.state === "cancelled" && !["plan_changed", "plan_stopped"].includes(o.reason ?? "");
  }
  private input(value: unknown): TimedPlanInput {
    try { return parseTimedPlan(value); }
    catch (e) { throw new AppError(e instanceof TimedPlanError ? e.code : "TIMED_INVALID", "请检查计划日期、时间、时区及数值范围。"); }
  }
  private snapshot(input: TimedPlanInput): TimedPlan["task"] {
    const live = this.db.connection.prepare("SELECT deleted_at,definition_json FROM tasks WHERE id=?").get(input.taskId);
    if (!live || live.deleted_at !== null) throw new AppError("TASK_NOT_FOUND", "计划绑定的任务不存在或已归档。");
    const row = this.db.connection.prepare("SELECT * FROM task_versions WHERE task_id=? AND revision=?").get(input.taskId, input.taskRevision);
    if (!row) throw new AppError("TASK_CONFLICT", "所选任务版本不可用，请重新选择。");
    const definition = definitionOf(JSON.parse(String(row.definition_json)));
    if (typeof row.prompt_snapshot !== "string" || promptHash(row.prompt_snapshot) !== row.prompt_hash) throw new AppError("STORAGE_INVALID", "任务版本快照校验失败。");
    return { definition, revision: input.taskRevision, promptSnapshot: row.prompt_snapshot, promptHash: String(row.prompt_hash) };
  }
  preview(value: unknown) {
    const input = this.input(value), task = this.snapshot(input), now = this.clock.now().getTime();
    const slots = slotsNear(input, now).filter(s => Date.parse(s.deadlineAt) >= now).slice(0, 12);
    const fresh = this.fresh(), actual = fresh?.snapshot?.buckets.find(b => b.id === this.context.policy.limitId)?.windows
      .find(w => w.slot === input.window?.slot && w.durationMinutes === input.window?.durationMinutes);
    return { input, task: { name: task.definition.name, revision: task.revision, model: task.definition.model ?? null,
      session: task.definition.session, sandbox: task.definition.execution?.sandbox ?? "read-only" }, slots,
      quotaKnown: !!fresh, actualResetAt: actual?.resetsAt ?? null, experimental: input.mode === "window",
      source: this.context.provider };
  }
  save(value: unknown, id?: string, revision?: number) {
    return this.db.transaction(() => {
      const input = this.input(value), task = this.snapshot(input), now = this.clock.now().toISOString();
      if (!slotsNear(input, Date.parse(now)).some(s => Date.parse(s.dueAt) > Date.parse(now))) throw new AppError("TIMED_PAST", "没有未来可执行时刻，请选择未来日期或使用手动执行。");
      const old = id ? this.get(id) : null;
      if (old && old.revision !== revision) throw new AppError("TIMED_CONFLICT", "计划已变化，草稿已保留，请重新加载后核对。");
      if (!old && Number(this.db.connection.prepare("SELECT count(*) AS n FROM timed_plans").get()!.n) >= 1000) throw new AppError("TIMED_LIMIT", "计划数量达到上限，请先整理已有计划。");
      if (old) this.stopFutureInside(old.id, "plan_changed");
      const plan: TimedPlan = { id: old?.id ?? randomUUID(), revision: (old?.revision ?? 0) + 1, input, task,
        state: "draft", binding: null, reason: null, createdAt: old?.createdAt ?? now, updatedAt: now, enabledAt: null };
      this.db.connection.prepare("INSERT INTO timed_plans VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data_json=excluded.data_json").run(plan.id, JSON.stringify(plan));
      return timedPlanView(plan);
    });
  }
  confirmation(id: string, revision: number) {
    const p = this.get(id); if (p.revision !== revision) throw new AppError("TIMED_CONFLICT", "计划版本已变化，请重新预览。");
    const state = this.fresh();
    return { ...timedPlanView(p), ...this.preview(p.input), context: state ? this.contextHash(p, state) : null,
      conflicts: this.conflicts(p), canEnable: this.context.provider === "codex" && this.db.path !== ":memory:" && !!state };
  }
  private contextHash(p: TimedPlan, state: MonitorState): string {
    return digest([p.id, p.revision, p.input, p.task.promptHash, this.context.sourceKey, state.identity, state.snapshot?.cli?.version ?? null]);
  }
  enable(id: string, revision: number, context: string, confirm: boolean, estimate: boolean, protection: boolean) {
    return this.db.transaction(() => {
      const p = this.get(id); if (p.revision !== revision) throw new AppError("TIMED_CONFLICT", "计划已变化，请重新预览。");
      if (p.state === "enabled") throw new AppError("TIMED_ALREADY_ENABLED", "计划已经启用，请先暂停或编辑。");
      if (!confirm || p.input.mode === "window" && (!estimate || !protection)) throw new AppError("CONFIRM_REQUIRED", "请明确确认无人值守执行；衔接模式还须确认实验估算及保护范围。");
      const state = this.fresh();
      if (this.context.provider !== "codex" || this.db.path === ":memory:" || !state) throw new AppError("TIMED_REQUIRES_QUOTA", "启用计划需要真实来源、持久化存储和新鲜完整额度查询。");
      if (context !== this.contextHash(p, state)) throw new AppError("TIMED_CONTEXT_CHANGED", "账户、来源、CLI 或计划已变化，请重新预览并确认。");
      const current = this.db.connection.prepare("SELECT definition_json,deleted_at FROM tasks WHERE id=?").get(p.input.taskId);
      if (!current || current.deleted_at !== null || !definitionOf(JSON.parse(String(current.definition_json))).enabled || !p.task.definition.enabled) throw new AppError("TASK_DISABLED", "当前任务停用或已归档，不能启用计划。");
      const w = p.input.window;
      if (w && !state.snapshot?.buckets.find(b => b.id === this.context.policy.limitId)?.windows.some(v => v.slot === w.slot && v.durationMinutes === w.durationMinutes)) throw new AppError("TIMED_WINDOW_CHANGED", "所选服务端窗口已变化，请重新选择并保存计划。");
      if (this.conflicts(p).length) throw new AppError("TIMED_PROTECTION_CONFLICT", "计划与另一保护时段冲突，请先调整时间。");
      if (!slotsNear(p.input, this.clock.now().getTime()).some(s => Date.parse(s.dueAt) > this.clock.now().getTime() && !this.consumed(p.id, s.date))) throw new AppError("TIMED_PAST", "没有尚未触发的未来时刻，请重新设置计划。");
      p.state = "enabled"; p.binding = { sourceKey: this.context.sourceKey, identity: state.identity!, cliVersion: state.snapshot?.cli?.version ?? null };
      p.reason = null; p.revision++; p.updatedAt = this.clock.now().toISOString(); p.enabledAt = p.updatedAt;
      writeTimedPlan(this.db, p); this.materializeInside(p); return timedPlanView(p);
    });
  }
  setState(id: string, revision: number, state: "paused" | "cancelled") {
    return this.db.transaction(() => {
      const p = this.get(id); if (p.revision !== revision) throw new AppError("TIMED_CONFLICT", "计划已变化，请重新加载。");
      this.stopFutureInside(id, "plan_stopped"); p.state = state; p.revision++; p.reason = "user_paused"; p.updatedAt = this.clock.now().toISOString();
      writeTimedPlan(this.db, p); return timedPlanView(p);
    });
  }
  stopFutureInside(id: string, reason: string): void {
    for (const row of this.db.connection.prepare("SELECT data_json FROM timed_occurrences WHERE plan_id=?").all(id)) {
      const o = readTimedOccurrence(row.data_json);
      if (o.runId) {
        const runRow = this.db.connection.prepare("SELECT data_json FROM runs WHERE id=?").get(o.runId);
        if (!runRow) throw new AppError("STORAGE_INVALID", "定时运行关联缺失。");
        const run = readRun(runRow.data_json);
        if (run.taskSnapshot.quotaContinuation?.enabled) new ContinuationRepository(this.db, this.clock).stopInside(run.id);
        if (["queued", "waiting_quota"].includes(run.status) && !this.db.connection.prepare("SELECT run_id FROM execution_lock WHERE run_id=?").get(run.id)) {
          this.db.connection.prepare("UPDATE runs SET data_json=? WHERE id=?").run(JSON.stringify({ ...run, status: "cancelled", completedAt: this.clock.now().toISOString() }), run.id);
          o.state = "cancelled"; o.reason = reason; writeTimedOccurrence(this.db, o);
        }
      } else if (o.state === "pending") { o.state = "cancelled"; o.reason = reason; writeTimedOccurrence(this.db, o); }
    }
  }
  materializeInside(p: TimedPlan): void {
    const now = this.clock.now().toISOString();
    for (const date of skippedLocalDates(p.input, Date.parse(now))) {
      if (p.enabledAt && date < localParts(Date.parse(p.enabledAt), p.input.zone).date) continue;
      const result = this.db.connection.prepare("INSERT OR IGNORE INTO metadata(key,value) VALUES (?,?)").run(`timed_gap:${p.id}:${date}`, now);
      if (result.changes) timedNotice(this.db, this.clock, "timed_missed", p.id, null);
    }
    for (const slot of slotsNear(p.input, Date.parse(now))) {
      const row = this.db.connection.prepare("SELECT data_json FROM timed_occurrences WHERE plan_id=? AND target_date=?").get(p.id, slot.date);
      const old = row ? readTimedOccurrence(row.data_json) : null;
      if (old && (old.state !== "cancelled" || !["plan_changed", "plan_stopped"].includes(old.reason ?? "") || old.runId)) continue;
      if (!old && Date.parse(slot.deadlineAt) < Date.parse(p.enabledAt ?? now)) continue;
      const o: TimedOccurrence = { ...slot, id: old?.id ?? randomUUID(), planId: p.id, planRevision: p.revision, sequence: null,
        runId: null, state: "pending", reason: null, createdAt: now, observation: null };
      this.db.connection.prepare("INSERT INTO timed_occurrences(id,plan_id,target_date,data_json) VALUES (?,?,?,?) ON CONFLICT(plan_id,target_date) DO UPDATE SET data_json=excluded.data_json")
        .run(o.id, p.id, o.date, JSON.stringify(o));
    }
  }
  protections(state = this.state(), now = this.clock.now().getTime()) {
    return timedPlans(this.db).filter(p => p.state === "enabled" && p.binding?.sourceKey === this.context.sourceKey && (!state?.identity || p.binding.identity === state.identity))
      .flatMap(p => slotsNear(p.input, now).flatMap(s => p.input.window && Date.parse(s.dueAt) <= now && now < Date.parse(s.protectionEndAt!) ? [{ planId: p.id, date: s.date, name: p.input.name, endAt: s.protectionEndAt! }] : []));
  }
  assertManualAllowed(confirmed: boolean): void {
    if (!confirmed && this.protections().length) throw new AppError("TIMED_PROTECTION_CONFIRM_REQUIRED", "当前处于额度保护时段；此执行可能消耗预留额度，请明确确认后重试。");
  }
  conflicts(plan: TimedPlan): string[] {
    if (!plan.input.window) return [];
    const now = this.clock.now().getTime(), candidates = slotsNear(plan.input, now).filter(s => Date.parse(s.protectionEndAt!) > now);
    const selfOverlap = candidates.some((a, i) => candidates.slice(i + 1).some(b => Date.parse(a.dueAt) < Date.parse(b.protectionEndAt!) && Date.parse(b.dueAt) < Date.parse(a.protectionEndAt!)));
    return [...(selfOverlap ? [plan.id] : []), ...timedPlans(this.db).filter(p => p.id !== plan.id && p.state === "enabled" && p.input.window).filter(p => candidates.some(a =>
      slotsNear(p.input, Date.parse(a.startAt)).some(b => Date.parse(a.dueAt) < Date.parse(b.protectionEndAt!) && Date.parse(b.dueAt) < Date.parse(a.protectionEndAt!)))).map(p => p.id)];
  }
}
