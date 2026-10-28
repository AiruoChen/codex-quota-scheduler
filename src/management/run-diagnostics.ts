import type { TaskRun, ExecutionEvent } from "../domain/task.js";
import { readExecutionTrace } from "../adapters/codex/execution-trace.js";
import { readResumeMismatchDiagnostic } from "../adapters/codex/resume-diagnostics.js";
import { readRpcDiagnostic } from "../adapters/codex/rpc-errors.js";
import { systemErrorCode } from "../shared/errors.js";

export function runDiagnostics(run: TaskRun, events: ExecutionEvent[], now: Date, active: boolean, originPresent: boolean) {
  const traces = events.filter(e => e.type === "codex_trace").slice(-256).flatMap(e => {
    const record = readExecutionTrace(e.data); return record ? [{ sequence: e.sequence, ...record }] : [];
  });
  const mismatches = events.filter(e => e.type === "resume_authorization_mismatch").flatMap(e => {
    const data = readResumeMismatchDiagnostic(e.data); return data ? [data] : [];
  });
  const rpcErrors = events.filter(e => e.type === "codex_rpc_error").flatMap(e => { const d = readRpcDiagnostic(e.data); return d ? [d] : []; });
  const submitted = events.some(e => e.type === "submission_started"), hasTurn = !!run.turnId;
  const states = ["queued", "waiting_quota", "running", "succeeded", "failed", "needs_attention", "cancelled"];
  const lifecycle = events.filter(e => ["submission_started", "execution_finished", "scheduler_removed", "recovery_confirmed"].includes(e.type)).map(e => ({
    sequence: e.sequence, event: e.type, status: typeof e.data.status === "string" && states.includes(e.data.status) ? e.data.status : null,
  }));
  const canReconcile = run.status === "needs_attention" && !active && hasTurn && !!run.threadId && originPresent;
  const knownCodes = ["CODEX_AUTHORIZATION_MISMATCH", "CODEX_AUTHORIZATION_CHANGED", "CODEX_AUTHORIZATION_UNSUPPORTED", "CODEX_RPC_ERROR", "CODEX_NETWORK_ERROR", "CODEX_NOT_FOUND", "CODEX_START_FAILED", "CODEX_INCOMPATIBLE", "CODEX_TIMEOUT", "CODEX_AUTH_REQUIRED", "CODEX_ENVIRONMENT_UNVERIFIED", "EXECUTION_FAILED", "EXECUTION_TIMEOUT", "STORAGE_WRITE_FAILED", "THREAD_BUSY", "THREAD_PROJECT_MISMATCH", "ACCOUNT_CHANGED"];
  const code = run.error?.split(":", 1)[0] ?? "";
  const exceptions = events.filter(e => e.type === "execution_exception").map(e => ({ code: typeof e.data.code === "string" && knownCodes.includes(e.data.code) ? e.data.code : "UNKNOWN", systemCode: systemErrorCode({ code: e.data.systemCode }) }));
  return { format: 2, generatedAt: now.toISOString(),
    runId: /^[a-f0-9-]{36}$/.test(run.id) ? run.id : "hidden", status: states.includes(run.status) ? run.status : "unknown",
    evidence: { submissionStarted: submitted, recordedThread: !!run.threadId, recordedTurn: hasTurn, activeExecution: active, originRecorded: originPresent },
    failureCode: knownCodes.includes(code) ? code : run.error ? "UNKNOWN" : null, exceptions,
    stages: events.flatMap(e => e.type === "execution_stage" && typeof e.data.stage === "string" && ["validate_local_task", "connect"].includes(e.data.stage) ? [{ sequence: e.sequence, stage: e.data.stage }] : []),
    guidance: canReconcile ? "可以按已记录来源和准确回合只读核对，再应用已确认终态。"
      : !hasTurn ? "没有准确回合，不能应用远端结果。请人工核对后从队列移除或确认解除阻塞；不会重发原任务。"
      : "当前证据或执行状态不满足应用结果条件，请先核对执行权与原始来源。",
    canReconcile, authorization: mismatches.at(-1) ?? null, rpcErrors, lifecycle,
    timeline: traces, timelineAvailable: traces.length > 0,
    timelineTruncated: events.some(e => e.type === "codex_trace_truncated") || events.filter(e => e.type === "codex_trace").length > 256,
    limitations: ["这是完整控制流程的脱敏诊断，不包含凭据、任务正文、输出内容或原始私人目录。",
      "path/thread/environment 代号仅用于本次运行内对照；同一原始值使用同一代号，最终权限判断使用真实目录核验。",
      ...(traces.length ? [] : ["该记录未保存请求/响应时间线，可能来自旧版或在连接前失败，无法补回未保存的响应。"])] };
}
