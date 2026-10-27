import { createHash } from "node:crypto";
import type { MonitorEvent, MonitorObservation, MonitorState, TrackedWindow } from "../domain/monitor.js";
import type { QuotaSnapshot } from "../domain/quota.js";
import { evaluateQuota, hasQuotaIdentity, type QuotaPolicy } from "../domain/quota-policy.js";

export interface MonitorOptions extends QuotaPolicy { pollIntervalMs: number }
export const digest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");

function identity(snapshot: QuotaSnapshot): string | null {
  if (snapshot.source === "mock") return "mock";
  const account = snapshot.account;
  if (!hasQuotaIdentity(account)) return null;
  return digest([snapshot.source, account.type, account.email, account.workspaceId, account.planType]);
}

/** Pure transition. Time alone never generates quota_reset or makes an unknown snapshot available. */
export function recognize(previous: MonitorState | null, observation: MonitorObservation, options: MonitorOptions, now: Date) {
  const createdAt = now.toISOString();
  const events: Omit<MonitorEvent, "sequence">[] = [];
  const emit = (type: MonitorEvent["type"], data: MonitorEvent["data"], key: string | null = null) => events.push({ type, data, key, createdAt });
  const state: MonitorState = previous ? structuredClone(previous) : {
    revision: 0, observedAt: createdAt, identity: null, snapshot: null, windows: [],
    availability: { status: "unknown", reason: "unknown_quota" }, failures: 0, errorCode: null, nextPollAt: createdAt,
  };
  const oldAvailability = state.availability;
  const rollback = previous !== null && now.getTime() < Date.parse(previous.observedAt);
  state.revision++;
  state.observedAt = createdAt;
  if (rollback) { state.windows = []; state.snapshot = null; emit("clock_changed", { direction: "backward" }); }
  if ("errorCode" in observation) {
    state.failures = Math.min(30, state.failures + 1);
    state.errorCode = observation.errorCode;
    state.availability = { status: "unknown", reason: "read_failed" };
    if (previous?.errorCode !== state.errorCode) emit("read_error", { code: state.errorCode });
  } else {
    const snapshot = observation.snapshot;
    const fetched = Date.parse(snapshot.fetchedAt);
    const stale = !Number.isFinite(fetched) || fetched > now.getTime() || now.getTime() - fetched > options.quotaMaxAgeMs
      || state.snapshot !== null && fetched < Date.parse(state.snapshot.fetchedAt);
    if (stale) {
      state.failures = Math.min(30, state.failures + 1);
      state.errorCode = "STALE_QUOTA";
      state.availability = { status: "unknown", reason: "stale_quota" };
      if (previous?.errorCode !== state.errorCode) emit("read_error", { code: state.errorCode });
    } else {
      const nextIdentity = identity(snapshot);
      const comparable = nextIdentity !== null && state.identity === nextIdentity;
      if (!comparable) {
        state.windows = [];
        if (state.snapshot === null || state.identity !== nextIdentity) emit(state.snapshot === null ? "baseline" : "identity_changed", { source: snapshot.source });
      }
      if (previous?.errorCode) emit("read_recovered", { previousCode: previous.errorCode });
      state.identity = nextIdentity;
      state.failures = 0;
      state.errorCode = null;
      let regressed = false;
      for (const bucket of snapshot.buckets) for (const window of bucket.windows) {
        if (window.durationMinutes === null || window.durationMinutes <= 0 || window.remainingPercent === null) continue;
        const index = state.windows.findIndex((item) => item.bucketId === bucket.id && item.slot === window.slot);
        const prior = state.windows[index];
        const next: TrackedWindow = { bucketId: bucket.id, slot: window.slot, durationMinutes: window.durationMinutes, resetsAt: window.resetsAt };
        if (comparable && prior?.durationMinutes === window.durationMinutes && prior.resetsAt !== null && window.resetsAt !== null
          && Date.parse(prior.resetsAt) <= fetched && Date.parse(window.resetsAt) > fetched && Date.parse(window.resetsAt) > Date.parse(prior.resetsAt)) {
          const key = digest([nextIdentity, bucket.id, window.slot, window.durationMinutes, window.resetsAt]);
          emit("quota_reset", { bucketId: bucket.id, slot: window.slot, durationMinutes: window.durationMinutes,
            previousResetsAt: prior.resetsAt, resetsAt: window.resetsAt, remainingPercent: window.remainingPercent }, key);
        }
        // Keep high-water boundaries when a server sends an older cached window.
        if (prior?.durationMinutes === next.durationMinutes && prior.resetsAt !== null
          && (next.resetsAt === null || Date.parse(next.resetsAt) < Date.parse(prior.resetsAt))) {
          if (bucket.id === options.limitId) regressed = true;
          continue;
        }
        if (index < 0) state.windows.push(next); else state.windows[index] = next;
      }
      state.snapshot = snapshot;
      state.availability = evaluateQuota(snapshot, options, now);
      const current = snapshot.buckets.find((bucket) => bucket.id === options.limitId);
      const missing = state.windows.some((known) => known.bucketId === options.limitId && !current?.windows.some((window) => window.slot === known.slot));
      if (missing && state.availability.status === "available") state.availability = { status: "unknown", reason: "missing_window" };
      if (regressed && state.availability.status === "available") state.availability = { status: "unknown", reason: "unknown_quota" };
      if (nextIdentity === null) state.availability = { status: "unknown", reason: "identity_unknown" };
    }
  }
  if (oldAvailability.status !== state.availability.status || oldAvailability.reason !== state.availability.reason) {
    emit("availability_changed", { previous: oldAvailability.status, status: state.availability.status, reason: state.availability.reason });
  }
  let delay = state.failures > 0
    ? Math.min(Math.max(300000, options.pollIntervalMs), options.pollIntervalMs * 2 ** (state.failures - 1)) : options.pollIntervalMs;
  if (state.failures === 0 && state.snapshot) for (const bucket of state.snapshot.buckets) {
    if (bucket.id !== options.limitId) continue;
    for (const window of bucket.windows) if (window.resetsAt !== null) {
      const until = Date.parse(window.resetsAt) - now.getTime() + 1000;
      if (until > 0) delay = Math.min(delay, until);
    }
  }
  state.nextPollAt = new Date(now.getTime() + Math.max(1000, delay)).toISOString();
  return { state, events };
}
