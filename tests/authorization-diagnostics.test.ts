import assert from "node:assert/strict";
import test from "node:test";
import { supportsEmptyTurnEnvironments, inspectTurnEnvironmentOverride } from "../src/adapters/codex/turn-environment-protocol.js";
import { ResumeAuthorizationMismatch, resumeMismatchDiagnostic, resumeMismatchMessage } from "../src/adapters/codex/resume-diagnostics.js";
import { defaultCodexOptions } from "../src/adapters/codex/launcher.js";
import { resolve } from "node:path";

test("必须从协议字段和明确的空数组语义确认禁用环境能力，不能只猜测字段名", () => {
  const schema = { properties: { environments: { type: ["array", "null"], items: { $ref: "#/definitions/TurnEnvironmentParams" },
    description: "Optional environments. Empty disables environment access for this turn." } } };
  assert.equal(supportsEmptyTurnEnvironments(schema), true);
  for (const candidate of [null, {}, { properties: {} }, { properties: { environments: {} } },
    { properties: { environments: { ...schema.properties.environments, description: "Unknown" } } },
    { properties: { environments: { ...schema.properties.environments, type: "string" } } },
    { properties: { environments: { ...schema.properties.environments, items: {} } } }]) {
    assert.equal(supportsEmptyTurnEnvironments(candidate), false);
  }
});

test("授权诊断只有固定字段，未知异常不泄露原文、凭据、指令和私人路径", () => {
  const privateError = Object.assign(new Error("PRIVATE_PATH PRIVATE_PROMPT PRIVATE_TOKEN"), { reason: "network_access", cwd: "PRIVATE_PATH" });
  assert.deepEqual(resumeMismatchDiagnostic(privateError, "PRIVATE_VERSION", false), {
    format: 1, stage: "resume_authorization", reason: "verification_unavailable", cliVersion: null, environmentOverrideVerified: false,
  });
  assert.ok(!resumeMismatchMessage(privateError).includes("PRIVATE"));
  const known = new ResumeAuthorizationMismatch("network_access"); known.message = "PRIVATE_RAW_MESSAGE";
  assert.equal(resumeMismatchDiagnostic(known, "0.164.0-alpha.11.1", true).reason, "network_access");
  assert.ok(!resumeMismatchMessage(known).includes("PRIVATE"));
  assert.deepEqual(Object.keys(resumeMismatchDiagnostic(known, "0.164.0-alpha.11.1", true)).sort(),
    ["format", "stage", "reason", "cliVersion", "environmentOverrideVerified"].sort());
});

test("协议检查时 CLI 版本与已连接版本不同则不能证明环境禁用能力", async () => {
  assert.equal(await inspectTurnEnvironmentOverride({ executable: process.execPath,
    args: [resolve("tests/fixtures/fake-execution.mjs")], env: process.env, version: "0.159.0-fixture" },
    { ...defaultCodexOptions, requestTimeoutMs: 3000 }), false);
});
