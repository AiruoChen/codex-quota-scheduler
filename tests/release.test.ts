import assert from "node:assert/strict";
import test from "node:test";
import { automatedChecks, manualChecks, readAcceptance, readManualEvidence, releaseGate, type AcceptanceReport, type ManualEvidence } from "../src/domain/release.js";

const now = new Date("2030-01-02T00:00:00.000Z");
const commit = "a".repeat(40);
const installerSha256 = "b".repeat(64);

function report(): AcceptanceReport {
  return {
    format: 1, version: "0.3.0", commit, clean: true, installerSha256, createdAt: "2030-01-01T00:00:00.000Z",
    environment: { platform: "win32", arch: "x64", node: "v22.12.0", os: "Windows_NT" },
    checks: automatedChecks.map((id) => ({ id, status: "passed", durationMs: 50, count: id === "unit" ? 238 : 1 })),
    soak: { scope: "desktop_protocol_fixture", completed: true, requestedMs: 10_000, elapsedMs: 10_003, wallMs: 10_003,
      maxGapMs: 1100, samples: 10, monitorUpdates: 2, notificationCount: 1, submissions: 10, uniqueRuns: 10, leakedChildren: 0,
      peakBytes: 100_000_000, growthBytes: 50_000, heapPeakBytes: 10_000_000 },
  };
}

function manual(): ManualEvidence {
  return {
    format: 1, version: "0.3.0", commit, installerSha256,
    checks: manualChecks.map((id) => ({ id, status: "passed", method: id === "real_account" ? "real_account" : "human_observed",
      observedAt: "2030-01-01T00:00:00.000Z", reviewer: "release_reviewer" })),
  };
}

test("候选版要求完整自动验收和真实连续运行数据", () => {
  const evidence = report();
  assert.deepEqual(releaseGate(evidence, "candidate", null, false, now).blockers, []);
  for (const id of automatedChecks) {
    const changed = structuredClone(evidence);
    changed.checks.find((item) => item.id === id)!.status = "pending";
    assert.ok(releaseGate(changed, "candidate", null, false, now).blockers.includes(`CHECK_${id.toUpperCase()}`));
  }
  for (const [change, blocker] of [
    [(item: AcceptanceReport) => { item.clean = false; }, "SOURCE_DIRTY"],
    [(item: AcceptanceReport) => { item.environment.platform = "linux"; }, "TARGET_NOT_WINDOWS_X64"],
    [(item: AcceptanceReport) => { item.soak!.completed = false; }, "SOAK_SMOKE_REQUIRED"],
    [(item: AcceptanceReport) => { item.soak!.submissions = 11; }, "SOAK_SMOKE_REQUIRED"],
    [(item: AcceptanceReport) => { item.soak!.leakedChildren = 1; }, "SOAK_SMOKE_REQUIRED"],
    [(item: AcceptanceReport) => { item.soak!.wallMs = 5_000_000; }, "SOAK_SMOKE_REQUIRED"],
    [(item: AcceptanceReport) => { item.soak!.monitorUpdates = 1; }, "SOAK_SMOKE_REQUIRED"],
    [(item: AcceptanceReport) => { item.soak!.notificationCount = 0; }, "SOAK_SMOKE_REQUIRED"],
    [(item: AcceptanceReport) => { item.soak!.requestedMs = 15_000; }, "SOAK_SMOKE_REQUIRED"],
  ] as const) {
    const changed = structuredClone(evidence); change(changed);
    assert.ok(releaseGate(changed, "candidate", null, false, now).blockers.includes(blocker));
  }
  const expired = structuredClone(evidence); expired.createdAt = "2029-01-01T00:00:00.000Z";
  assert.ok(releaseGate(expired, "candidate", null, false, now).blockers.includes("EVIDENCE_EXPIRED"));
  assert.throws(() => releaseGate(evidence, "preview" as "candidate", null, false, now), /RELEASE_EVIDENCE_INVALID/);
});

test("稳定版必须有匹配安装包的人工证据、预期签名及完整 24 小时观测", () => {
  const evidence = report(), observations = manual();
  const blocked = releaseGate(evidence, "stable", observations, false, now).blockers;
  assert.ok(blocked.includes("SIGNATURE_REQUIRED"));
  assert.ok(blocked.includes("SOAK_24H_REQUIRED"));
  evidence.soak!.requestedMs = 86_400_000;
  evidence.soak!.elapsedMs = 86_400_001;
  evidence.soak!.wallMs = 86_400_001;
  evidence.soak!.samples = 86_400;
  evidence.soak!.monitorUpdates = 100;
  assert.deepEqual(releaseGate(evidence, "stable", observations, true, now).blockers, []);
  const wrongHash = structuredClone(observations); wrongHash.installerSha256 = "c".repeat(64);
  assert.equal(releaseGate(evidence, "stable", wrongHash, true, now).blockers.filter((item) => item.startsWith("MANUAL_")).length, manualChecks.length);
  const fakeAccount = structuredClone(observations); fakeAccount.checks.find((item) => item.id === "real_account")!.method = "human_observed";
  assert.ok(releaseGate(evidence, "stable", fakeAccount, true, now).blockers.includes("MANUAL_REAL_ACCOUNT"));
  const stale = structuredClone(observations); stale.checks[0]!.observedAt = "2020-01-01T00:00:00.000Z";
  assert.ok(releaseGate(evidence, "stable", stale, true, now).blockers.includes(`MANUAL_${stale.checks[0]!.id.toUpperCase()}`));
  const insufficient = structuredClone(evidence); insufficient.soak!.samples = 8639;
  assert.ok(releaseGate(insufficient, "stable", observations, true, now).blockers.includes("SOAK_24H_REQUIRED"));
  const staleMonitor = structuredClone(evidence); staleMonitor.soak!.monitorUpdates = 99;
  assert.ok(releaseGate(staleMonitor, "stable", observations, true, now).blockers.includes("SOAK_24H_REQUIRED"));
  const shortActual = structuredClone(evidence); shortActual.soak!.requestedMs += 1000;
  assert.ok(releaseGate(shortActual, "stable", observations, true, now).blockers.includes("SOAK_24H_REQUIRED"));
});

test("公开证据只保留白名单，拒绝重复、损坏、带路径或账户信息的字段", () => {
  const input = { ...report(), taskPrompt: "secret", logs: ["C:/Users/private"],
    checks: report().checks.map((item) => ({ ...item, stderr: "secret" })),
    environment: { ...report().environment, absolutePath: "C:/Users/private" },
    soak: { ...report().soak!, account: "personal@example.com" } };
  const output = readAcceptance(input);
  assert.equal(JSON.stringify(output).includes("secret"), false);
  assert.equal(JSON.stringify(output).includes("private"), false);
  assert.equal(JSON.stringify(output).includes("personal@example.com"), false);
  const copy = structuredClone(input); copy.checks.push({ ...copy.checks[0]! });
  assert.throws(() => readAcceptance(copy), /RELEASE_EVIDENCE_INVALID/);
  assert.throws(() => readAcceptance({ ...input, environment: { ...input.environment, os: "C:/Users/private" } }), /RELEASE_EVIDENCE_INVALID/);
  assert.throws(() => readAcceptance({ ...input, soak: { ...input.soak, submissions: -1 } }), /RELEASE_EVIDENCE_INVALID/);
  const manualInput = { ...manual(), privateNotes: "secret", checks: manual().checks.map((item) => ({ ...item, account: "personal@example.com" })) };
  const manualOutput = readManualEvidence(manualInput);
  assert.equal(JSON.stringify(manualOutput).includes("secret"), false);
  assert.equal(JSON.stringify(manualOutput).includes("personal@example.com"), false);
  assert.throws(() => readManualEvidence({ ...manualInput, checks: [...manualInput.checks, manualInput.checks[0]] }), /RELEASE_EVIDENCE_INVALID/);
});
