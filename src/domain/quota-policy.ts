import type { QuotaSnapshot } from "./quota.js";

export interface QuotaPolicy {
  limitId: string;
  quotaMaxAgeMs: number;
  reservePercent: number;
  quotaReserves?: { fiveHour?: number; weekly?: number };
}

export function reserveForWindow(policy: QuotaPolicy, durationMinutes: number | null): number {
  return durationMinutes === 300 ? policy.quotaReserves?.fiveHour ?? policy.reservePercent
    : durationMinutes === 10080 ? policy.quotaReserves?.weekly ?? policy.reservePercent : policy.reservePercent;
}

export type QuotaAvailability =
  | { status: "available"; reason: "quota_available" }
  | { status: "blocked"; reason: "quota_exhausted" | "reserve_reached" }
  | { status: "unknown"; reason: "unknown_quota" | "stale_quota" | "read_failed" | "identity_unknown" | "missing_window" };

export function hasQuotaIdentity(account: QuotaSnapshot["account"]): account is NonNullable<QuotaSnapshot["account"]> {
  return !!account && account.type === "chatgpt" && !!(account.email?.trim() || account.workspaceId?.trim());
}

export function evaluateQuota(snapshot: QuotaSnapshot, policy: QuotaPolicy, now: Date): QuotaAvailability {
  const age = now.getTime() - Date.parse(snapshot.fetchedAt);
  if (!Number.isFinite(age) || age < 0 || age > policy.quotaMaxAgeMs) return { status: "unknown", reason: "stale_quota" };
  const bucket = snapshot.buckets.find((item) => item.id === policy.limitId);
  if (!bucket || bucket.windows.length === 0) return { status: "unknown", reason: "unknown_quota" };
  if (bucket.reachedType) return { status: "blocked", reason: "quota_exhausted" };
  let unknown = false;
  let reserve = false;
  for (const window of bucket.windows) {
    const remaining = window.remainingPercent;
    if (window.durationMinutes === null || window.durationMinutes <= 0 || remaining === null || !Number.isFinite(remaining)
      || remaining < 0 || remaining > 100 || window.resetsAt !== null && !(Date.parse(window.resetsAt) > now.getTime())) unknown = true;
    if (remaining !== null && remaining <= 0) return { status: "blocked", reason: "quota_exhausted" };
    if (remaining !== null && remaining <= reserveForWindow(policy, window.durationMinutes)) reserve = true;
  }
  if (unknown) return { status: "unknown", reason: "unknown_quota" };
  if (reserve) return { status: "blocked", reason: "reserve_reached" };
  return { status: "available", reason: "quota_available" };
}
