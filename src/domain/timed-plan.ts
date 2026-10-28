import type { TaskDefinition } from "./task.js";

export class TimedPlanError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}
export interface TimedPlanInput {
  name: string; taskId: string; taskRevision: number;
  mode: "at_time" | "window"; zone: string; date: string; time: string;
  repeat: "once" | "daily"; endDate: string | null;
  graceMinutes: number; catchUp: boolean;
  window: { slot: "primary" | "secondary"; durationMinutes: number; useMinutes: number;
    minPercent: number; protectMinutes: number } | null;
}
export interface TimedPlan {
  id: string; revision: number; state: "draft" | "enabled" | "paused" | "cancelled";
  input: TimedPlanInput; task: { definition: TaskDefinition; revision: number; promptSnapshot: string; promptHash: string };
  binding: { sourceKey: string; identity: string; cliVersion: string | null } | null;
  reason: string | null; createdAt: string; updatedAt: string; enabledAt: string | null;
}
export interface PlannedSlot {
  date: string; startAt: string; dueAt: string; deadlineAt: string; targetResetAt: string | null;
  protectionEndAt: string | null; offsetMinutes: number; ambiguous: boolean;
}
export interface TimedOccurrence extends PlannedSlot {
  id: string; planId: string; planRevision: number; sequence: number | null; runId: string | null;
  state: "pending" | "dispatching" | "finished" | "missed" | "cancelled";
  reason: string | null; createdAt: string;
  observation: { fetchedAt: string; actualResetAt: string | null; remainingPercent: number | null;
    alignment: "matching" | "different" | "unknown"; ready: "met" | "not_met" | "unknown";
    readyCheckedAt: string | null; firstResetAt: string | null; resetConfirmedAt: string | null } | null;
}

export interface TimedRunLink { planId: string; occurrenceId: string; dueAt: string; deadlineAt: string; continuation: boolean }
export function timedAdmission(link: TimedRunLink, now: number): "not_due" | "expired" | null {
  return link.continuation ? null : now < Date.parse(link.dueAt) ? "not_due" : now > Date.parse(link.deadlineAt) ? "expired" : null;
}

const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
function invalid(): never { throw new TimedPlanError("TIMED_INVALID", "定时计划字段无效，请检查日期、时间、时区、任务版本和数值范围。"); }
export function validDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value + "T00:00:00Z");
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value && Number(value.slice(0, 4)) >= 1970;
}
export function addDays(date: string, days: number): string {
  if (!validDate(date) || !Number.isSafeInteger(days)) return invalid();
  return new Date(Date.parse(date + "T00:00:00Z") + days * 86400000).toISOString().slice(0, 10);
}
const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(zone: string) {
  const saved = formatters.get(zone); if (saved) return saved;
  try {
    const value = new Intl.DateTimeFormat("en-CA", { timeZone: zone, calendar: "iso8601", numberingSystem: "latn",
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    if (formatters.size >= 128) formatters.delete(formatters.keys().next().value!);
    formatters.set(zone, value); return value;
  }
  catch { return invalid(); }
}
export function localParts(instant: number, zone: string): { date: string; time: string } {
  const parts = Object.fromEntries(formatter(zone).formatToParts(instant).map(p => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

/** Resolve with observed offsets on both sides of DST. Gaps are skipped; folds choose the first instant. */
export function resolveLocal(date: string, time: string, zone: string): { instant: number; offsetMinutes: number; ambiguous: boolean } | null {
  if (!validDate(date) || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) return invalid();
  const nominal = Date.parse(`${date}T${time}:00Z`), offsets = new Set<number>();
  for (let hours = -36; hours <= 36; hours += 6) {
    const sample = nominal + hours * 3600000, parts = localParts(sample, zone);
    offsets.add(Date.parse(`${parts.date}T${parts.time}:00Z`) - sample);
  }
  const candidates = [...offsets].map(offset => ({ instant: nominal - offset, offsetMinutes: offset / 60000 }))
    .filter(c => { const parts = localParts(c.instant, zone); return parts.date === date && parts.time === time; }).sort((a, b) => a.instant - b.instant);
  return candidates[0] ? { ...candidates[0], ambiguous: candidates.length > 1 } : null;
}

export function parseTimedPlan(value: unknown): TimedPlanInput {
  if (!object(value)) return invalid();
  const text = (key: string, max: number) => {
    const v = value[key]; if (typeof v !== "string" || !v.trim() || v.length > max || /[\x00-\x1f\x7f]/.test(v)) return invalid(); return v.trim();
  };
  const name = text("name", 150), taskId = text("taskId", 200), zone = text("zone", 100), time = text("time", 5);
  formatter(zone);
  if (!validDate(value.date) || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)
    || !Number.isSafeInteger(value.taskRevision) || Number(value.taskRevision) < 1 || !["at_time", "window"].includes(String(value.mode))
    || !["once", "daily"].includes(String(value.repeat)) || typeof value.catchUp !== "boolean"
    || !Number.isSafeInteger(value.graceMinutes) || Number(value.graceMinutes) < 1 || Number(value.graceMinutes) > 1440
    || value.endDate !== null && (!validDate(value.endDate) || value.endDate < value.date)) return invalid();
  let window: TimedPlanInput["window"] = null;
  if (value.mode === "window") {
    const w = value.window;
    if (!object(w) || !["primary", "secondary"].includes(String(w.slot)) || !Number.isSafeInteger(w.durationMinutes)
      || Number(w.durationMinutes) < 1 || Number(w.durationMinutes) > 10080 || !Number.isSafeInteger(w.useMinutes)
      || Number(w.useMinutes) < 1 || Number(w.useMinutes) >= Number(w.durationMinutes)
      || typeof w.minPercent !== "number" || !Number.isFinite(w.minPercent) || w.minPercent < 0 || w.minPercent > 100
      || !Number.isSafeInteger(w.protectMinutes) || Number(w.protectMinutes) < Number(w.useMinutes) || Number(w.protectMinutes) > 10080) return invalid();
    window = { slot: w.slot as "primary" | "secondary", durationMinutes: Number(w.durationMinutes), useMinutes: Number(w.useMinutes), minPercent: w.minPercent, protectMinutes: Number(w.protectMinutes) };
  }
  return { name, taskId, taskRevision: Number(value.taskRevision), mode: value.mode as TimedPlanInput["mode"], zone,
    date: value.date, time, repeat: value.repeat as TimedPlanInput["repeat"], endDate: value.endDate as string | null,
    graceMinutes: Number(value.graceMinutes), catchUp: value.catchUp, window };
}

export function planSlot(input: TimedPlanInput, date: string): PlannedSlot | null {
  if (date < input.date || input.endDate && date > input.endDate || input.repeat === "once" && date !== input.date) return null;
  const local = resolveLocal(date, input.time, input.zone); if (!local) return null;
  const start = local.instant, w = input.window, due = w ? start + (w.useMinutes - w.durationMinutes) * 60000 : start;
  return { date, startAt: new Date(start).toISOString(), dueAt: new Date(due).toISOString(),
    deadlineAt: new Date(due + input.graceMinutes * 60000).toISOString(),
    targetResetAt: w ? new Date(start + w.useMinutes * 60000).toISOString() : null,
    protectionEndAt: w ? new Date(start + w.protectMinutes * 60000).toISOString() : null,
    offsetMinutes: local.offsetMinutes, ambiguous: local.ambiguous };
}

/** Bounded lookahead includes pre-triggers on the previous calendar day and long service windows. */
export function slotsNear(input: TimedPlanInput, now: number): PlannedSlot[] {
  if (input.repeat === "once") { const slot = planSlot(input, input.date); return slot ? [slot] : []; }
  const today = localParts(now, input.zone).date, days = Math.ceil((input.window?.durationMinutes ?? 0) / 1440) + 2;
  const dates = new Set([input.date, ...Array.from({ length: days + 2 }, (_, index) => addDays(today, index - 1))]);
  return [...dates].sort().flatMap(date => { const slot = planSlot(input, date); return slot ? [slot] : []; });
}

export function skippedLocalDates(input: TimedPlanInput, now: number): string[] {
  const today = localParts(now, input.zone).date;
  return [addDays(today, -1), today].filter(date => date >= input.date && (!input.endDate || date <= input.endDate)
    && (input.repeat === "daily" || date === input.date) && !resolveLocal(date, input.time, input.zone));
}

export class TimedClockGuard {
  private wall: number | null = null; private mono = 0;
  observe(wall: number, mono: number): boolean {
    const changed = this.wall !== null && (wall < this.wall || mono < this.mono || Math.abs((wall - this.wall) - (mono - this.mono)) > 5000);
    this.wall = wall; this.mono = mono; return changed;
  }
}
