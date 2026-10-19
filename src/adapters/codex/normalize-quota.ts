import type { QuotaBucket, QuotaSnapshot, QuotaWindow } from "../../domain/quota.js";
import { isRecord } from "../../shared/validation.js";

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function nonNegative(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function normalizeWindow(value: unknown, slot: QuotaWindow["slot"]): QuotaWindow | null {
  if (value === null || value === undefined) return null;
  const data = isRecord(value) ? value : {};
  const usedPercent = nonNegative(data.usedPercent);
  const duration = nonNegative(data.windowDurationMins);
  const timestamp = nonNegative(data.resetsAt);
  const date = timestamp === null ? null : new Date(timestamp * 1000);
  return {
    slot,
    durationMinutes: duration !== null && duration > 0 ? duration : null,
    usedPercent,
    remainingPercent: usedPercent === null ? null : Math.max(0, 100 - usedPercent),
    resetsAt: date !== null && Number.isFinite(date.getTime()) ? date.toISOString() : null,
  };
}

function normalizeBucket(value: unknown, fallbackId: string): QuotaBucket {
  const data = isRecord(value) ? value : {};
  const windows = [normalizeWindow(data.primary, "primary"), normalizeWindow(data.secondary, "secondary")];
  return {
    id: fallbackId,
    name: text(data.limitName),
    planType: text(data.planType),
    reachedType: text(data.rateLimitReachedType),
    windows: windows.filter((window): window is QuotaWindow => window !== null),
  };
}

/** Accepts the result of account/rateLimits/read, not a JSON-RPC envelope. */
export function normalizeQuota(
  result: unknown,
  fetchedAt: Date,
  source: QuotaSnapshot["source"],
): QuotaSnapshot {
  const data = isRecord(result) ? result : {};
  let buckets: QuotaBucket[] = [];
  if (isRecord(data.rateLimitsByLimitId) && Object.keys(data.rateLimitsByLimitId).length > 0) {
    buckets = Object.entries(data.rateLimitsByLimitId).map(([id, value]) => normalizeBucket(value, id));
  } else if (isRecord(data.rateLimits)) {
    buckets = [normalizeBucket(data.rateLimits, text(data.rateLimits.limitId) ?? "unknown")];
  }
  return { source, fetchedAt: fetchedAt.toISOString(), buckets };
}
