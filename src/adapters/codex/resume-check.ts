import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import type { RecoveryTarget } from "../../domain/recovery.js";
import { hasQuotaIdentity } from "../../domain/quota-policy.js";
import { AppError } from "../../shared/errors.js";
import { isRecord } from "../../shared/validation.js";
import { codexConnectionKey } from "./connection-key.js";
import type { CodexOptions } from "./launcher.js";
import { connectCodex, readAccount } from "./session.js";
import { rpcDiagnostic, type CodexRpcDiagnostic } from "./rpc-errors.js";

const errorCodes = new Set(["CODEX_AUTH_REQUIRED", "CODEX_AUTH_UNSUPPORTED", "CODEX_INCOMPATIBLE", "CODEX_RPC_ERROR", "CODEX_NETWORK_ERROR",
  "CODEX_TIMEOUT", "CODEX_EXITED", "CODEX_START_FAILED", "CODEX_CONNECTION_CLOSED", "CODEX_PROTOCOL_ERROR",
  "CODEX_NOT_FOUND", "CODEX_LAUNCHER_UNSUPPORTED", "CODEX_CANCELLED", "EXECUTION_CANCELLED",
  "ORIGIN_UNKNOWN", "CONNECTION_MISMATCH", "ACCOUNT_MISMATCH", "RESUME_TARGET_INVALID", "THREAD_MISMATCH", "PROJECT_MISMATCH"]);
export interface ResumeCheckReport {
  format: 1;
  diagnosticId: string;
  result: "blocked" | "read_only_checks_passed";
  cliVersion: string | null;
  connectionMatched: boolean;
  accountMatched: boolean;
  directoryMatched: boolean;
  metadataReadable: boolean;
  historyMode: "legacy" | "paginated" | "unknown";
  ephemeral: boolean | null;
  turnsListReadable: boolean;
  itemsListReadable: boolean;
  resumeVerified: false;
  permissionsVerified: false;
  errorCode: string | null;
  rpcDiagnostics: CodexRpcDiagnostic[];
}

/** Read-only compatibility evidence, never a recovery/reconciliation or a promise that resume will succeed. */
export async function checkResumeCompatibility(options: CodexOptions, target: Pick<RecoveryTarget, "run" | "origin">, signal?: AbortSignal): Promise<ResumeCheckReport> {
  const report: ResumeCheckReport = { format: 1, diagnosticId: randomUUID(), result: "blocked", cliVersion: null,
    connectionMatched: false, accountMatched: false, directoryMatched: false, metadataReadable: false,
    historyMode: "unknown", ephemeral: null, turnsListReadable: false, itemsListReadable: false,
    resumeVerified: false, permissionsVerified: false, errorCode: null, rpcDiagnostics: [] };
  try {
    const { run, origin } = target;
    if (!origin || !hasQuotaIdentity(origin.account)) throw new AppError("ORIGIN_UNKNOWN", "缺少已记录来源或账户。");
    if (origin.connectionKey !== codexConnectionKey(options)) throw new AppError("CONNECTION_MISMATCH", "当前连接与已记录来源不符。");
    report.connectionMatched = true;
    if (run.taskSnapshot.session.mode !== "resume" || run.threadId !== null && run.threadId !== run.taskSnapshot.session.threadId) {
      throw new AppError("RESUME_TARGET_INVALID", "缺少一致的已记录续接目标。");
    }
    const threadId = run.taskSnapshot.session.threadId;
    const { client, launch } = await connectCodex(options, signal);
    try {
      report.cliVersion = launch.version.length <= 80 && /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(launch.version) ? launch.version : null;
      const matches = (account: typeof origin.account) => (["type", "email", "planType", "workspaceId"] as const).every((key) => account[key] === origin.account[key]);
      if (!matches(await readAccount(client, signal))) throw new AppError("ACCOUNT_MISMATCH", "当前账户与已记录账户不符。");
      report.accountMatched = true;
      const response = await client.request("thread/read", { threadId, includeTurns: false }, signal);
      if (!isRecord(response) || !isRecord(response.thread) || response.thread.id !== threadId || typeof response.thread.cwd !== "string") {
        throw new AppError("THREAD_MISMATCH", "准确会话元数据不完整。");
      }
      report.metadataReadable = true;
      if (await realpath(response.thread.cwd) !== await realpath(run.taskSnapshot.projectDir)) throw new AppError("PROJECT_MISMATCH", "原会话目录与快照不符。");
      report.directoryMatched = true;
      report.historyMode = response.thread.historyMode === "legacy" || response.thread.historyMode === "paginated" ? response.thread.historyMode : "unknown";
      report.ephemeral = typeof response.thread.ephemeral === "boolean" ? response.thread.ephemeral : null;
      const turns = await client.request("thread/turns/list", { threadId, limit: 1, itemsView: "notLoaded", sortDirection: "asc" }, signal);
      if (!isRecord(turns) || !Array.isArray(turns.data)) throw new AppError("CODEX_PROTOCOL_ERROR", "回合列表格式无效。");
      report.turnsListReadable = true;
      // Prefer an accurately recorded turn. Otherwise inspect only the first page's shape, never infer a target turn from it.
      const items = await client.request("thread/items/list", { threadId, limit: 1, sortDirection: "asc", ...(run.turnId ? { turnId: run.turnId } : {}) }, signal);
      if (!isRecord(items) || !Array.isArray(items.data)) throw new AppError("CODEX_PROTOCOL_ERROR", "历史条目列表格式无效。");
      report.itemsListReadable = true;
      if (!matches(await readAccount(client, signal))) {
        report.accountMatched = false;
        throw new AppError("ACCOUNT_MISMATCH", "查询期间账户发生变化。");
      }
      report.result = "read_only_checks_passed";
    } finally { await client.close(); }
  } catch (error) {
    report.errorCode = error instanceof AppError && errorCodes.has(error.code) ? error.code : "RESUME_CHECK_FAILED";
    const diagnostic = rpcDiagnostic(error);
    if (diagnostic) report.rpcDiagnostics.push(diagnostic);
  }
  return report;
}
