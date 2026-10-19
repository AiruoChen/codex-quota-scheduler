import type { QuotaSnapshot } from "../domain/quota.js";
import type { TaskDefinition } from "../domain/task.js";

export interface SchedulingPolicy {
  limitId: string;
  quotaMaxAgeMs: number;
  reservePercent: number;
}

export type Decision =
  | { action: "run"; taskId: string }
  | { action: "wait"; reason: "busy" | "empty_queue" | "unknown_quota" | "stale_quota" | "quota_exhausted" | "reserve_reached" };

/** Pure eligibility preview. Persistence, deduplication and dispatch are later phases. */
export function evaluateQueue(
  snapshot: QuotaSnapshot,
  tasks: readonly TaskDefinition[],
  policy: SchedulingPolicy,
  now: Date,
  running: boolean,
): Decision {
  if (running) return { action: "wait", reason: "busy" };
  const next = tasks.filter((task) => task.enabled).sort((a, b) => b.priority - a.priority)[0];
  if (!next) return { action: "wait", reason: "empty_queue" };
  const age = now.getTime() - Date.parse(snapshot.fetchedAt);
  if (!Number.isFinite(age) || age < 0 || age > policy.quotaMaxAgeMs) {
    return { action: "wait", reason: "stale_quota" };
  }
  const bucket = snapshot.buckets.find((item) => item.id === policy.limitId);
  if (!bucket || bucket.windows.length === 0) return { action: "wait", reason: "unknown_quota" };
  if (bucket.reachedType) return { action: "wait", reason: "quota_exhausted" };
  for (const window of bucket.windows) {
    const remaining = window.remainingPercent;
    if (window.durationMinutes === null || remaining === null || !Number.isFinite(remaining)) {
      return { action: "wait", reason: "unknown_quota" };
    }
    if (remaining <= 0) return { action: "wait", reason: "quota_exhausted" };
    if (remaining <= policy.reservePercent) return { action: "wait", reason: "reserve_reached" };
  }
  return { action: "run", taskId: next.id };
}
