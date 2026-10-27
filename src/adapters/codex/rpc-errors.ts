import { randomUUID } from "node:crypto";
import { AppError } from "../../shared/errors.js";
import { isRecord } from "../../shared/validation.js";

const stages = {
  initialize: "initialize", "account/read": "account", "account/rateLimits/read": "quota",
  "thread/start": "create_thread", "thread/read": "read_thread", "thread/resume": "resume_thread",
  "thread/turns/list": "read_history", "thread/items/list": "read_history",
  "turn/start": "submit_turn", "turn/interrupt": "interrupt_turn", other: "other",
  "model/list": "read_catalog", "project/list": "read_catalog", "project/read": "read_catalog", "thread/list": "read_catalog",
} as const;
export type RpcMethod = keyof typeof stages;
const descriptions = {
  authentication_required: "账户认证被拒绝，请核对相同数据目录的登录状态。",
  method_unsupported: "当前接口不可用，请核对本机 CLI 对应协议。",
  invalid_parameters: "服务端报告参数无效，请核对本机 CLI 对应协议。",
  thread_history_missing: "服务端报告会话历史不可用，请只读核对准确会话及数据来源。",
  thread_archived: "服务端报告会话已归档；不会自动取消归档。",
  thread_closing: "服务端报告会话正在关闭；不会自动重试恢复。",
  capability_required: "服务端明确要求实验能力；不会自动开启或重试。",
  history_paging_required: "服务端明确要求分页历史支持，请核对历史接口兼容性。",
  permission_parameters_conflict: "服务端报告 permissions 与 sandbox 参数冲突；不会放宽权限。",
  initialization_required: "服务端报告初始化状态不匹配，请核对握手流程。",
  network_failure: "服务端明确报告网络请求失败，请检查连接。",
  unknown: "具体原因未知；通用 RPC 编号不能证明历史、权限或账户问题。",
} as const;
export type RpcReason = keyof typeof descriptions;
export interface CodexRpcDiagnostic {
  format: 1;
  diagnosticId: string;
  method: RpcMethod;
  stage: typeof stages[RpcMethod];
  rpcCode: number | null;
  reason: RpcReason;
  cliVersion: string | null;
}
const versionPattern = /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/;
const uuidPattern = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/;
export const rpcMethod = (method: string): RpcMethod => Object.hasOwn(stages, method) ? method as RpcMethod : "other";

/** Project an untrusted/persisted value onto the exact export allowlist. No raw error or cause is retained. */
export function readRpcDiagnostic(value: unknown): CodexRpcDiagnostic | null {
  if (!isRecord(value) || value.format !== 1 || typeof value.diagnosticId !== "string" || !uuidPattern.test(value.diagnosticId)
    || typeof value.method !== "string" || !Object.hasOwn(stages, value.method)
    || typeof value.reason !== "string" || !Object.hasOwn(descriptions, value.reason)
    || value.rpcCode !== null && !Number.isSafeInteger(value.rpcCode)
    || value.cliVersion !== null && (typeof value.cliVersion !== "string" || value.cliVersion.length > 80 || !versionPattern.test(value.cliVersion))) return null;
  const method = value.method as RpcMethod;
  if (value.stage !== stages[method]) return null;
  return { format: 1, diagnosticId: value.diagnosticId, method, stage: stages[method],
    rpcCode: value.rpcCode as number | null, reason: value.reason as RpcReason, cliVersion: value.cliVersion as string | null };
}

function classify(code: number | null, message: string, method: RpcMethod): RpcReason {
  if (code === 401 || code === 403) return "authentication_required";
  if (code === -32601) return "method_unsupported";
  if (code === -32602) return "invalid_parameters";
  // Match only specific, anchored server evidence. Incidental words in echoed input are not diagnoses.
  if (/^(?:Unauthorized|Not authenticated|Not logged in)(?:[.: ]|$)/i.test(message)) return "authentication_required";
  if (method.startsWith("thread/")) {
    if (/^(?:no rollout found for (?:thread|conversation) id |thread not found(?:[.: ]|$))/i.test(message)) return "thread_history_missing";
    if (/^session [\w-]{1,128} is archived(?:[. ]|$)/i.test(message)) return "thread_archived";
    if (/^thread [\w-]{1,128} is closing;/i.test(message)) return "thread_closing";
  }
  if (/^[\w/.`-]{1,120} requires experimentalApi capability(?:[.: ]|$)/.test(message)) return "capability_required";
  if (/^paginated threads require thread\/turns\/list and thread\/items\/list support(?:[. ]|$)/.test(message)) return "history_paging_required";
  if (/^`permissions` cannot be combined with `sandbox`(?:[. ]|$)/.test(message)) return "permission_parameters_conflict";
  if (/^(?:Not initialized|Already initialized)$/.test(message)) return "initialization_required";
  if (/^(?:fetch failed|failed to fetch|network error)(?:[.: ]|$)/i.test(message)) return "network_failure";
  return "unknown";
}

export class CodexRpcError extends AppError {
  readonly diagnostic: Readonly<CodexRpcDiagnostic>;
  constructor(diagnostic: CodexRpcDiagnostic) {
    const safe = readRpcDiagnostic(diagnostic);
    if (!safe) throw new AppError("RPC_DIAGNOSTIC_INVALID", "RPC 诊断字段无效。");
    const reason = safe.reason;
    const code = reason === "authentication_required" ? "CODEX_AUTH_REQUIRED"
      : reason === "method_unsupported" || reason === "invalid_parameters" ? "CODEX_INCOMPATIBLE"
      : reason === "network_failure" ? "CODEX_NETWORK_ERROR" : "CODEX_RPC_ERROR";
    super(code, `Codex 拒绝 ${safe.method} 请求（RPC ${safe.rpcCode ?? "unknown"}；分类 ${reason}；诊断 ${safe.diagnosticId}）。${descriptions[reason]}`);
    this.diagnostic = Object.freeze(safe);
    this.name = "CodexRpcError";
  }
}

export function createRpcError(error: unknown, method: string, cliVersion: string): CodexRpcError {
  const code = isRecord(error) && Number.isSafeInteger(error.code) ? error.code as number : null;
  const message = isRecord(error) && typeof error.message === "string" && error.message.length <= 8192 ? error.message : "";
  const safeMethod = rpcMethod(method);
  const diagnostic: CodexRpcDiagnostic = { format: 1, diagnosticId: randomUUID(), method: safeMethod, stage: stages[safeMethod], rpcCode: code,
    reason: classify(code, message, safeMethod), cliVersion: cliVersion.length <= 80 && versionPattern.test(cliVersion) ? cliVersion : null };
  return new CodexRpcError(Object.freeze(diagnostic));
}

export function rpcDiagnostic(error: unknown): CodexRpcDiagnostic | null {
  return error instanceof CodexRpcError ? readRpcDiagnostic(error.diagnostic) : null;
}
