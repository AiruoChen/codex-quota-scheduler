import type { TimedPlan, TimedOccurrence } from "../domain/timed-plan.js";
import { parseTimedPlan, validDate } from "../domain/timed-plan.js";
import { AppError } from "../shared/errors.js";
import { isRecord } from "../shared/validation.js";
import { definitionOf, promptHash } from "./task-repository.js";
import type { Database } from "./database.js";
import type { Clock } from "../domain/ports.js";
import { recoveryEvent } from "./recovery-repository.js";

export const iso = (v: unknown): v is string => typeof v === "string" && Number.isFinite(Date.parse(v));
const nullableIso = (v: unknown) => v === null || iso(v);
export const uuid = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9-]{36}$/.test(v);
export function invalidTimedStorage(): never { throw new AppError("STORAGE_INVALID", "定时计划记录无效，请保留原数据并核对备份。"); }
export function readTimedPlan(raw: unknown): TimedPlan {
  try {
    const p = JSON.parse(String(raw)) as TimedPlan;
    if (!isRecord(p) || !uuid(p.id) || !Number.isSafeInteger(p.revision) || p.revision < 1
      || !["draft", "enabled", "paused", "cancelled"].includes(p.state) || !isRecord(p.task)
      || !iso(p.createdAt) || !iso(p.updatedAt) || !nullableIso(p.enabledAt)
      || !(p.reason === null || typeof p.reason === "string" && /^[a-z_]{1,64}$/.test(p.reason))) return invalidTimedStorage();
    p.input = parseTimedPlan(p.input); p.task.definition = definitionOf(p.task.definition);
    if (p.input.taskId !== p.task.definition.id || p.input.taskRevision !== p.task.revision
      || typeof p.task.promptSnapshot !== "string" || promptHash(p.task.promptSnapshot) !== p.task.promptHash
      || p.binding !== null && (!isRecord(p.binding) || ![p.binding.sourceKey, p.binding.identity].every(v => typeof v === "string" && /^[a-f0-9]{64}$/.test(v))
        || !(p.binding.cliVersion === null || typeof p.binding.cliVersion === "string" && /^[a-zA-Z0-9.+_-]{1,100}$/.test(p.binding.cliVersion)))
      || p.state === "enabled" && (!p.binding || !p.enabledAt)) return invalidTimedStorage();
    return p;
  } catch { return invalidTimedStorage(); }
}
export function readTimedOccurrence(raw: unknown): TimedOccurrence {
  try {
    const o = JSON.parse(String(raw)) as TimedOccurrence;
    if (!isRecord(o) || !uuid(o.id) || !uuid(o.planId) || !validDate(o.date) || !Number.isSafeInteger(o.planRevision) || o.planRevision < 1
      || !(o.sequence === null || Number.isSafeInteger(o.sequence) && o.sequence > 0) || !(o.runId === null || uuid(o.runId))
      || !["pending", "dispatching", "finished", "missed", "cancelled"].includes(o.state)
      || ![o.startAt, o.dueAt, o.deadlineAt, o.createdAt].every(iso) || Date.parse(o.deadlineAt) < Date.parse(o.dueAt)
      || ![o.targetResetAt, o.protectionEndAt].every(nullableIso) || !Number.isFinite(o.offsetMinutes) || typeof o.ambiguous !== "boolean"
      || !(o.reason === null || typeof o.reason === "string" && /^[a-z_]{1,64}$/.test(o.reason))) return invalidTimedStorage();
    const v = o.observation;
    if (v !== null && (!isRecord(v) || !iso(v.fetchedAt) || ![v.actualResetAt, v.readyCheckedAt, v.firstResetAt, v.resetConfirmedAt].every(nullableIso)
      || !(v.remainingPercent === null || typeof v.remainingPercent === "number" && Number.isFinite(v.remainingPercent) && v.remainingPercent >= 0 && v.remainingPercent <= 100)
      || !["matching", "different", "unknown"].includes(v.alignment) || !["met", "not_met", "unknown"].includes(v.ready))) return invalidTimedStorage();
    return o;
  } catch { return invalidTimedStorage(); }
}
export function getTimedPlan(db: Database, id: string): TimedPlan {
  const row = db.connection.prepare("SELECT data_json FROM timed_plans WHERE id=?").get(id);
  if (!row) throw new AppError("TIMED_NOT_FOUND", "定时计划不存在。");
  return readTimedPlan(row.data_json);
}
export function timedPlans(db: Database): TimedPlan[] {
  return db.connection.prepare("SELECT data_json FROM timed_plans ORDER BY rowid").all().map(r => readTimedPlan(r.data_json));
}
export function timedOccurrences(db: Database, planId: string, limit = 40): TimedOccurrence[] {
  return db.connection.prepare("SELECT data_json FROM timed_occurrences WHERE plan_id=? ORDER BY sequence DESC LIMIT ?").all(planId, limit).map(r => readTimedOccurrence(r.data_json));
}
export function writeTimedPlan(db: Database, plan: TimedPlan): void {
  readTimedPlan(JSON.stringify(plan));
  db.connection.prepare("UPDATE timed_plans SET data_json=? WHERE id=?").run(JSON.stringify(plan), plan.id);
}
export function writeTimedOccurrence(db: Database, occurrence: TimedOccurrence): void {
  readTimedOccurrence(JSON.stringify(occurrence));
  db.connection.prepare("UPDATE timed_occurrences SET data_json=? WHERE id=?").run(JSON.stringify(occurrence), occurrence.id);
}
export function timedNotice(db: Database, clock: Clock, kind: "timed_missed" | "timed_attention" | "timed_ready", planId: string, occurrenceId: string | null): void {
  recoveryEvent(db, clock, null, kind, { planId, occurrenceId });
}
export function timedPlanView(p: TimedPlan) {
  return { id: p.id, revision: p.revision, state: p.state, input: p.input, reason: p.reason,
    task: { name: p.task.definition.name, revision: p.task.revision, model: p.task.definition.model ?? null,
      session: p.task.definition.session, sandbox: p.task.definition.execution?.sandbox ?? "read-only" },
    createdAt: p.createdAt, updatedAt: p.updatedAt, enabledAt: p.enabledAt };
}
