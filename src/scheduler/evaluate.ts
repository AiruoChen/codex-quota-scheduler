import type { QuotaSnapshot } from "../domain/quota.js";
import type { TaskDefinition } from "../domain/task.js";
import { evaluateQuota } from "../domain/quota-policy.js";

export interface SchedulingPolicy {
  limitId: string;
  quotaMaxAgeMs: number;
  reservePercent: number;
}

export type Decision =
  | { action: "run"; taskId: string }
  | { action: "wait"; reason: "busy" | "empty_queue" | "unknown_quota" | "stale_quota" | "quota_exhausted" | "reserve_reached" };

/** Pure eligibility preview. The scheduling service owns dispatch and persistence. */
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
  const quota = evaluateQuota(snapshot, policy, now);
  if (quota.status !== "available") return { action: "wait", reason: quota.reason === "stale_quota" ? "stale_quota"
    : quota.reason === "quota_exhausted" || quota.reason === "reserve_reached" ? quota.reason : "unknown_quota" };
  return { action: "run", taskId: next.id };
}
