import assert from "node:assert/strict";
import test from "node:test";
import { createRpcError, readRpcDiagnostic, rpcDiagnostic, CodexRpcError } from "../src/adapters/codex/rpc-errors.js";

const secret = "PRIVATE_TOKEN PRIVATE_PROMPT https://fixture.invalid/?token=PRIVATE_TOKEN C:/private-fixture-path user@example.test";
const examples = [
  [401, "ignored", "authentication_required", "CODEX_AUTH_REQUIRED"],
  [-32601, "ignored", "method_unsupported", "CODEX_INCOMPATIBLE"],
  [-32602, "ignored", "invalid_parameters", "CODEX_INCOMPATIBLE"],
  [-32600, "no rollout found for thread id fixture-thread", "thread_history_missing", "CODEX_RPC_ERROR"],
  [-32600, "session fixture-thread is archived.", "thread_archived", "CODEX_RPC_ERROR"],
  [-32600, "thread fixture-thread is closing; retry thread/resume after the thread is closed", "thread_closing", "CODEX_RPC_ERROR"],
  [-32600, "thread/resume requires experimentalApi capability", "capability_required", "CODEX_RPC_ERROR"],
  [-32600, "paginated threads require thread/turns/list and thread/items/list support", "history_paging_required", "CODEX_RPC_ERROR"],
  [-32600, "`permissions` cannot be combined with `sandbox`", "permission_parameters_conflict", "CODEX_RPC_ERROR"],
  [-32000, "fetch failed:", "network_failure", "CODEX_NETWORK_ERROR"],
] as const;
for (const [code, message, reason, appCode] of examples) test(`RPC ${reason}：明确证据分类且不携带原始错误`, () => {
  const error = createRpcError({ code, message: message + " " + secret, data: { credentials: secret }, cause: secret }, "thread/resume", "0.164.0-alpha.11.1");
  assert.equal(error.code, appCode); assert.equal(error.diagnostic.reason, reason);
  assert.equal(error.diagnostic.stage, "resume_thread");
  assert.deepEqual(Object.keys(error.diagnostic), ["format", "diagnosticId", "method", "stage", "rpcCode", "reason", "cliVersion"]);
  const exposed = JSON.stringify(error) + error.stack;
  for (const value of ["PRIVATE_TOKEN", "PRIVATE_PROMPT", "fixture.invalid", "private-fixture-path", "user@example.test"]) assert.ok(!exposed.includes(value));
  assert.match(error.message, new RegExp(error.diagnostic.diagnosticId));
  assert.ok(Object.isFrozen(error.diagnostic));
});

test("通用 -32600、回显关键词、未知或过大的消息均保持未知，不猜账户／网络／权限原因", () => {
  for (const message of ["", "input contains unauthorized login network fetch timeout sandbox", "custom refusal " + secret, "x".repeat(9000)]) {
    const error = createRpcError({ code: -32600, message, data: { code: 401 } }, "thread/resume", "0.164.0-alpha.11.1");
    assert.equal(error.diagnostic.reason, "unknown"); assert.equal(error.code, "CODEX_RPC_ERROR");
  }
});

test("RPC 非法字段、方法及版本不能作为日志字符串透传；诊断导出丢弃额外字段并验证阶段", () => {
  const error = createRpcError({ code: "401", message: false }, secret, secret);
  assert.equal(error.diagnostic.method, "other"); assert.equal(error.diagnostic.rpcCode, null);
  assert.equal(error.diagnostic.cliVersion, null); assert.equal(error.diagnostic.reason, "unknown");
  const projected = readRpcDiagnostic({ ...error.diagnostic, raw: secret });
  assert.deepEqual(projected, error.diagnostic);
  for (const patch of [{ stage: secret }, { reason: secret }, { diagnosticId: secret }, { cliVersion: secret }, { rpcCode: Infinity }, { method: "__proto__" }]) {
    assert.equal(readRpcDiagnostic({ ...error.diagnostic, ...patch }), null);
  }
  assert.equal(rpcDiagnostic(new Error(secret)), null);
  const copy = new CodexRpcError({ ...error.diagnostic, raw: secret } as typeof error.diagnostic);
  assert.ok(!JSON.stringify(copy).includes(secret));
});

test("初始化拒绝只接受准确消息，诊断编号每次不同且保留固定握手阶段", () => {
  const first = createRpcError({ code: -32600, message: "Not initialized" }, "initialize", "0.164.0-alpha.11.1");
  const second = createRpcError({ code: -32600, message: "Not initialized" }, "initialize", "0.164.0-alpha.11.1");
  assert.equal(first.diagnostic.reason, "initialization_required"); assert.equal(first.diagnostic.stage, "initialize");
  assert.notEqual(first.diagnostic.diagnosticId, second.diagnostic.diagnosticId);
});
