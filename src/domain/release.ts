export const automatedChecks = ["check", "unit", "demo", "package", "package_installer", "desktop", "lifecycle", "installer", "privacy", "soak_smoke"] as const;
export const manualChecks = ["clean_windows", "real_account", "native_notifications", "display_scaling", "fault_recovery", "p0_walkthrough"] as const;
export type CheckStatus = "passed" | "failed" | "pending";
export interface AcceptanceCheck { id: typeof automatedChecks[number]; status: CheckStatus; durationMs: number; count: number }
export interface SoakEvidence {
  scope: "desktop_protocol_fixture"; completed: boolean; requestedMs: number; elapsedMs: number; wallMs: number;
  maxGapMs: number; samples: number; monitorUpdates: number; notificationCount: number; submissions: number; uniqueRuns: number; leakedChildren: number;
  peakBytes: number; growthBytes: number; heapPeakBytes: number;
}
export interface AcceptanceReport {
  format: 1; version: string; commit: string; clean: boolean; installerSha256: string; createdAt: string;
  environment: { platform: string; arch: string; node: string; os: string };
  checks: AcceptanceCheck[]; soak: SoakEvidence | null;
}
export interface ManualEvidence {
  format: 1; version: string; commit: string; installerSha256: string;
  checks: Array<{ id: typeof manualChecks[number]; status: CheckStatus; method: "human_observed" | "real_account"; observedAt: string; reviewer: string }>;
}
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const integer = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0;
const hash = (value: unknown, size: number) => typeof value === "string" && new RegExp(`^[a-f0-9]{${size}}$`).test(value);
const version = (value: unknown) => typeof value === "string" && /^\d+\.\d+\.\d+$/.test(value);
function invalid(): never { throw new Error("RELEASE_EVIDENCE_INVALID"); }

/** Reconstruct a publishable whitelist; raw logs, paths, account identifiers and arbitrary result fields cannot escape. */
export function readAcceptance(value: unknown): AcceptanceReport {
  if (!object(value) || value.format !== 1 || !version(value.version) || !hash(value.commit, 40) || !hash(value.installerSha256, 64)
    || typeof value.clean !== "boolean" || typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt))
    || !object(value.environment) || !Array.isArray(value.checks) || value.checks.length > 20) invalid();
  const environment = value.environment;
  if (![environment.platform, environment.arch, environment.node, environment.os].every((item) => typeof item === "string" && /^[a-zA-Z0-9.+_-]{1,80}$/.test(item))) invalid();
  const checks = value.checks.map((check) => {
    if (!object(check) || !automatedChecks.includes(check.id as typeof automatedChecks[number]) || !["passed", "failed", "pending"].includes(String(check.status))
      || !integer(check.durationMs) || !integer(check.count)) invalid();
    return { id: check.id, status: check.status, durationMs: check.durationMs, count: check.count } as AcceptanceCheck;
  });
  if (new Set(checks.map((item) => item.id)).size !== checks.length) invalid();
  let soak: SoakEvidence | null = null;
  if (value.soak !== null) {
    const item = value.soak;
    if (!object(item) || item.scope !== "desktop_protocol_fixture" || typeof item.completed !== "boolean"
      || !["requestedMs", "elapsedMs", "wallMs", "maxGapMs", "samples", "monitorUpdates", "notificationCount", "submissions", "uniqueRuns", "leakedChildren", "peakBytes", "growthBytes", "heapPeakBytes"].every((key) => integer(item[key]))) invalid();
    soak = { scope: item.scope, completed: item.completed, requestedMs: Number(item.requestedMs), elapsedMs: Number(item.elapsedMs), wallMs: Number(item.wallMs),
      maxGapMs: Number(item.maxGapMs), samples: Number(item.samples), monitorUpdates: Number(item.monitorUpdates), notificationCount: Number(item.notificationCount),
      submissions: Number(item.submissions), uniqueRuns: Number(item.uniqueRuns),
      leakedChildren: Number(item.leakedChildren), peakBytes: Number(item.peakBytes), growthBytes: Number(item.growthBytes), heapPeakBytes: Number(item.heapPeakBytes) };
  }
  return { format: 1, version: String(value.version), commit: String(value.commit), clean: value.clean, installerSha256: String(value.installerSha256),
    createdAt: value.createdAt, environment: { platform: String(environment.platform), arch: String(environment.arch), node: String(environment.node), os: String(environment.os) }, checks, soak };
}

export function readManualEvidence(value: unknown): ManualEvidence {
  if (!object(value) || value.format !== 1 || !version(value.version) || !hash(value.commit, 40) || !hash(value.installerSha256, 64) || !Array.isArray(value.checks) || value.checks.length > manualChecks.length) invalid();
  const checks = value.checks.map((check) => {
    if (!object(check) || !manualChecks.includes(check.id as typeof manualChecks[number]) || !["passed", "failed", "pending"].includes(String(check.status))
      || !["human_observed", "real_account"].includes(String(check.method)) || typeof check.observedAt !== "string" || !Number.isFinite(Date.parse(check.observedAt))
      || typeof check.reviewer !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(check.reviewer)) invalid();
    return { id: check.id, status: check.status, method: check.method, observedAt: check.observedAt, reviewer: check.reviewer } as ManualEvidence["checks"][number];
  });
  if (new Set(checks.map((item) => item.id)).size !== checks.length) invalid();
  return { format: 1, version: String(value.version), commit: String(value.commit), installerSha256: String(value.installerSha256), checks };
}

export function releaseGate(report: AcceptanceReport, channel: "candidate" | "stable", manual: ManualEvidence | null, signed: boolean, now = new Date()) {
  if (channel !== "candidate" && channel !== "stable") invalid();
  const blockers: string[] = [];
  if (!report.clean) blockers.push("SOURCE_DIRTY");
  for (const id of automatedChecks) if (!report.checks.some((item) => item.id === id && item.status === "passed")) blockers.push(`CHECK_${id.toUpperCase()}`);
  if (!report.checks.some((item) => item.id === "unit" && item.count > 0)) blockers.push("UNIT_RESULTS_MISSING");
  if (report.environment.platform !== "win32" || report.environment.arch !== "x64") blockers.push("TARGET_NOT_WINDOWS_X64");
  if (Date.parse(report.createdAt) > now.getTime() || now.getTime() - Date.parse(report.createdAt) > 30 * 86400000) blockers.push("EVIDENCE_EXPIRED");
  if (!report.soak?.completed || report.soak.requestedMs < 10000 || report.soak.elapsedMs < report.soak.requestedMs
    || report.soak.monitorUpdates < 2 || report.soak.notificationCount < 1
    || report.soak.submissions < 1 || report.soak.submissions !== report.soak.uniqueRuns
    || report.soak.leakedChildren !== 0 || report.soak.maxGapMs > 15000 || Math.abs(report.soak.wallMs - report.soak.elapsedMs) > 5000
    || report.soak.peakBytes > 1536 * 1024 * 1024 || report.soak.growthBytes > 256 * 1024 * 1024 || report.soak.heapPeakBytes > 256 * 1024 * 1024) blockers.push("SOAK_SMOKE_REQUIRED");
  if (channel === "stable") {
    if (!signed) blockers.push("SIGNATURE_REQUIRED");
    const same = manual?.version === report.version && manual.commit === report.commit && manual.installerSha256 === report.installerSha256;
    for (const id of manualChecks) {
      const check = same ? manual!.checks.find((item) => item.id === id) : undefined;
      if (!check || check.status !== "passed" || id === "real_account" && check.method !== "real_account"
        || Date.parse(check.observedAt) > now.getTime() || now.getTime() - Date.parse(check.observedAt) > 30 * 86400000) blockers.push(`MANUAL_${id.toUpperCase()}`);
    }
    const soak = report.soak;
    if (!soak || !soak.completed || soak.requestedMs < 86400000 || soak.elapsedMs < soak.requestedMs
      || Math.abs(soak.wallMs - soak.elapsedMs) > 5000
      || soak.maxGapMs > 15000 || soak.samples < 8640 || soak.monitorUpdates < 100 || soak.notificationCount < 1
      || soak.submissions < 1 || soak.submissions !== soak.uniqueRuns || soak.leakedChildren !== 0
      || soak.peakBytes > 1536 * 1024 * 1024 || soak.growthBytes > 256 * 1024 * 1024 || soak.heapPeakBytes > 256 * 1024 * 1024) blockers.push("SOAK_24H_REQUIRED");
  }
  return { allowed: blockers.length === 0, blockers, channel };
}
