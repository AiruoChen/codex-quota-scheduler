import type { QuotaSnapshot, QuotaWindow } from "./quota.js";
import { evaluateQuota, hasQuotaIdentity, type QuotaPolicy } from "./quota-policy.js";

export interface QuotaInterruption {
  version: 1;
  reason: "usageLimitExceeded";
  threadId: string;
  turnId: string;
  connectionKey: string;
  accountScope: string;
  observedAt: string;
  bucketId: string;
  windows: Array<Pick<QuotaWindow, "slot" | "durationMinutes" | "resetsAt"> & { depleted: boolean }>;
}
export interface ContinuationLink {
  rootRunId: string;
  parentRunId: string;
  parentTurnId: string;
  attempt: number;
  connectionKey: string;
  accountScope: string;
  evidence: QuotaInterruption;
}
export const continuationSuffix = "\n\n请继续这个被截断的任务";

export function isQuotaInterruption(value: unknown): value is QuotaInterruption {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return item.version === 1 && item.reason === "usageLimitExceeded"
    && [item.threadId, item.turnId, item.bucketId].every(value => typeof value === "string" && value.length > 0)
    && [item.connectionKey, item.accountScope].every(value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value))
    && typeof item.observedAt === "string" && Number.isFinite(Date.parse(item.observedAt))
    && Array.isArray(item.windows) && item.windows.length > 0 && item.windows.length <= 10
    && item.windows.every(value => {
      if (!value || typeof value !== "object") return false;
      const window = value as Record<string, unknown>;
      return ["primary", "secondary"].includes(String(window.slot)) && typeof window.durationMinutes === "number" && Number.isFinite(window.durationMinutes)
        && window.durationMinutes > 0 && typeof window.depleted === "boolean" && typeof window.resetsAt === "string" && Date.parse(window.resetsAt) > Date.parse(String(item.observedAt));
    }) && item.windows.some(window => (window as Record<string, unknown>).depleted === true);
}

/** Requires a confirmed terminal usage error AND a fresh full query showing a depleted server window. */
export function quotaInterruption(snapshot: QuotaSnapshot, policy: QuotaPolicy, now: Date,
  target: Pick<QuotaInterruption, "threadId" | "turnId" | "connectionKey" | "accountScope">): QuotaInterruption | null {
  const age = now.getTime() - Date.parse(snapshot.fetchedAt);
  const bucket = snapshot.buckets.find(item => item.id === policy.limitId);
  if (snapshot.source !== "codex" || !hasQuotaIdentity(snapshot.account) || age < 0 || age > policy.quotaMaxAgeMs || !Number.isFinite(age)
    || !bucket?.windows.length || bucket.windows.some(window => window.remainingPercent === null || !Number.isFinite(window.remainingPercent)
      || window.remainingPercent < 0 || window.remainingPercent > 100 || !window.durationMinutes || !window.resetsAt || !(Date.parse(window.resetsAt) > now.getTime()))
    || !bucket.windows.some(window => window.remainingPercent === 0)) return null;
  return { version: 1, reason: "usageLimitExceeded", ...target, observedAt: snapshot.fetchedAt, bucketId: bucket.id,
    windows: bucket.windows.map(window => ({ slot: window.slot, durationMinutes: window.durationMinutes, resetsAt: window.resetsAt, depleted: window.remainingPercent === 0 })) };
}

/** A clock boundary or a reserve change alone cannot prove a reset. Every blocking server window must advance. */
export function continuationReady(evidence: QuotaInterruption, snapshot: QuotaSnapshot, policy: QuotaPolicy, now: Date): boolean {
  if (!isQuotaInterruption(evidence) || snapshot.source !== "codex" || !hasQuotaIdentity(snapshot.account) || evidence.bucketId !== policy.limitId || Date.parse(snapshot.fetchedAt) <= Date.parse(evidence.observedAt)
    || evaluateQuota(snapshot, policy, now).status !== "available") return false;
  const windows = snapshot.buckets.find(bucket => bucket.id === evidence.bucketId)?.windows;
  return !!windows && evidence.windows.every(previous => {
    const current = windows.find(window => window.slot === previous.slot && window.durationMinutes === previous.durationMinutes);
    return !!current && (!previous.depleted || !!current.resetsAt && !!previous.resetsAt
      && now.getTime() >= Date.parse(previous.resetsAt) && Date.parse(current.resetsAt) > Date.parse(previous.resetsAt));
  });
}
