import type { MonitorState } from "../domain/monitor.js";
import type { QuotaPolicy } from "../domain/quota-policy.js";
import type { QuotaWindow } from "../domain/quota.js";

export interface DisplayWindow {
  bucketId: string;
  bucketName: string;
  slot: QuotaWindow["slot"];
  durationMinutes: number | null;
  remainingPercent: number | null;
  resetsAt: string | null;
  missing: boolean;
}

/** Presentation only. Eligibility and refresh recognition remain in the existing domain services. */
export function quotaDisplay(state: MonitorState | null, policy: QuotaPolicy, now: Date) {
  const snapshot = state?.snapshot;
  const fetched = Date.parse(snapshot?.fetchedAt ?? "");
  const fresh = !!snapshot && Number.isFinite(fetched) && now.getTime() >= fetched
    && now.getTime() - fetched <= policy.quotaMaxAgeMs && !state?.errorCode;
  const readable = fresh && state?.availability.status !== "unknown";
  const windows: DisplayWindow[] = (snapshot?.buckets ?? []).flatMap((bucket) => bucket.windows.map((window) => ({
    bucketId: bucket.id, bucketName: bucket.name ?? bucket.id, slot: window.slot, durationMinutes: window.durationMinutes,
    remainingPercent: readable && window.durationMinutes !== null && window.durationMinutes > 0
      && window.remainingPercent !== null && Number.isFinite(window.remainingPercent) && window.remainingPercent >= 0 && window.remainingPercent <= 100
      && (window.resetsAt === null || Date.parse(window.resetsAt) > now.getTime()) ? window.remainingPercent : null,
    resetsAt: window.resetsAt, missing: false,
  })));
  for (const previous of state?.windows ?? []) {
    if (!windows.some((window) => window.bucketId === previous.bucketId && window.slot === previous.slot && window.durationMinutes === previous.durationMinutes)) {
      windows.push({ ...previous, bucketName: previous.bucketId, remainingPercent: null, resetsAt: null, missing: true });
    }
  }
  const boundaries = windows.map((window) => Date.parse(window.resetsAt ?? "")).filter((time) => Number.isFinite(time) && time > now.getTime());
  return { fresh, validUntil: fresh ? new Date(Math.min(fetched + policy.quotaMaxAgeMs, ...boundaries)).toISOString() : null,
    account: snapshot?.source === "mock" ? "模拟账户" : snapshot?.account ? maskAccount(snapshot.account.email) : "账户身份未知",
    plan: snapshot?.account?.planType ?? null, cliVersion: snapshot?.cli?.version ?? null, windows };
}

export function maskAccount(email: string | null): string {
  if (!email || !email.includes("@")) return "账户信息已隐藏";
  return `${email.slice(0, 1)}***@${email.slice(email.lastIndexOf("@") + 1)}`;
}
