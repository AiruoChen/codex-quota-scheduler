import type { ExecutionOutcome, ExecutionSink, TaskRun } from "../../domain/task.js";
import { AppError } from "../../shared/errors.js";
import { isRecord } from "../../shared/validation.js";
import type { StdioRpcClient } from "./rpc-client.js";
import type { QuotaAvailability } from "../../domain/quota-policy.js";
import { rpcDiagnostic } from "./rpc-errors.js";
import { hasResumeAuthorization } from "../../domain/resume-authorization.js";
import { resumeWorkspaceRoots } from "./resume-authorization.js";

type Terminal = { status: string; usageLimitExceeded: boolean } | { error: AppError };
const usageFailure = (turn: Record<string, unknown>) => isRecord(turn.error) && turn.error.codexErrorInfo === "usageLimitExceeded";

/** Owns one turn, including notifications that arrive before turn/start responds. */
export async function runTurn(client: StdioRpcClient, threadId: string, run: TaskRun, signal: AbortSignal, sink: ExecutionSink,
  beforeSubmit: () => QuotaAvailability): Promise<ExecutionOutcome> {
  const messages = new Map<string, { text: string; phase: string | null }>();
  let messageBytes = 0;
  let turnId: string | undefined;
  let submitted = false;
  let stopping: "cancelled" | "timeout" | "attention" | undefined;
  let ended = false;
  let interrupted = false;
  let stopTimer: NodeJS.Timeout | undefined;
  const buffered: Array<{ method: string; params: Record<string, unknown> }> = [];
  let resolveTerminal!: (value: Terminal) => void;
  const terminal = new Promise<Terminal>((resolve) => { resolveTerminal = resolve; });
  const finish = (value: Terminal) => { if (!ended) { ended = true; resolveTerminal(value); } };
  const output = () => {
    const values = [...messages.values()];
    const final = values.filter((message) => message.phase === "final_answer");
    return (final.length ? final : values).map((message) => message.text).join("\n");
  };
  function requestStop(reason: "cancelled" | "timeout" | "attention") {
    stopping ??= reason;
    if (!turnId || interrupted || ended) return;
    interrupted = true;
    sink.event("interrupt_requested", { reason: stopping, turnId });
    // An RPC acknowledgement alone is not proof that the turn stopped.
    void client.request("turn/interrupt", { threadId, turnId }).catch(() => {});
    stopTimer = setTimeout(() => finish({ error: new AppError("EXECUTION_STOP_UNCONFIRMED", "未确认回合已停止，请核对会话及文件变更。") }), 5000);
  }
  const abort = () => requestStop(signal.reason === "timeout" ? "timeout" : "cancelled");
  function saveMessage(id: string, text: string, phase: string | null) {
    if (stopping === "attention") return;
    const previous = messages.get(id);
    const bytes = messageBytes - Buffer.byteLength(previous?.text ?? "") + Buffer.byteLength(text);
    // Bound all retained messages, including non-final messages hidden by output().
    if (bytes + messages.size > 1024 * 1024 || !previous && messages.size >= 2048) {
      requestStop("attention"); return;
    }
    messageBytes = bytes;
    messages.set(id, { text, phase });
    sink.output(output());
  }
  const agentItem = (item: Record<string, unknown>) => {
    if (item.type === "agentMessage" && typeof item.id === "string" && typeof item.text === "string") {
      saveMessage(item.id, item.text, typeof item.phase === "string" ? item.phase : null);
    }
  };
  const consume = (method: string, params: Record<string, unknown>) => {
    if (ended) return;
    const eventTurn = typeof params.turnId === "string" ? params.turnId : isRecord(params.turn) ? params.turn.id : undefined;
    if (eventTurn !== turnId) return;
    if (method === "item/agentMessage/delta" && typeof params.itemId === "string" && typeof params.delta === "string") {
      const message = messages.get(params.itemId) ?? { text: "", phase: null };
      saveMessage(params.itemId, message.text + params.delta, message.phase);
    }
    if ((method === "item/started" || method === "item/completed") && isRecord(params.item)) {
      const item = params.item;
      sink.event(method, { itemId: item.id, itemType: item.type, status: item.status ?? null, exitCode: item.exitCode ?? null });
      agentItem(item);
    }
    if (method === "error") sink.event("turn_error", { retrying: params.willRetry === true });
    if (method === "turn/completed" && isRecord(params.turn) && typeof params.turn.status === "string") {
      if (Array.isArray(params.turn.items)) for (const item of params.turn.items) if (isRecord(item)) agentItem(item);
      sink.event("turn/completed", { status: params.turn.status });
      finish({ status: params.turn.status, usageLimitExceeded: usageFailure(params.turn) });
    }
  };
  const offNotification = client.onNotification((method, params) => {
    if (!isRecord(params) || params.threadId !== threadId) return;
    if (!turnId) {
      if (buffered.length >= 2048) { finish({ error: new AppError("EXECUTION_EVENT_LIMIT", "回合启动阶段事件过多，需核对状态。") }); return; }
      buffered.push({ method, params });
    } else consume(method, params);
  });
  const offFailure = client.onFailure((error) => finish({ error }));
  client.handleServerRequests((method, params) => {
    if (isRecord(params) && typeof params.threadId === "string" && params.threadId !== threadId) return undefined;
    sink.event("needs_attention", { method });
    requestStop("attention");
    if (method === "item/commandExecution/requestApproval" || method === "item/fileChange/requestApproval") return { decision: "cancel" };
    return undefined;
  });
  signal.addEventListener("abort", abort, { once: true });
  try {
    if (signal.aborted) return { status: signal.reason === "timeout" ? "failed" : "cancelled", output: "", error: signal.reason === "timeout" ? "EXECUTION_TIMEOUT: 提交前超时。" : null };
    const execution = run.taskSnapshot.execution;
    const sandbox = execution?.sandbox ?? "read-only";
    const quota = beforeSubmit();
    if (quota.status !== "available") return { status: "waiting_quota", output: "", error: `QUOTA_WAIT: ${quota.reason}` };
    sink.admit?.();
    sink.submitted();
    submitted = true;
    const response = await client.request("turn/start", {
      threadId, input: [{ type: "text", text: run.promptSnapshot }], cwd: run.taskSnapshot.projectDir,
      approvalPolicy: "on-request", approvalsReviewer: "user",
      sandboxPolicy: sandbox === "read-only" ? { type: "readOnly", networkAccess: false }
        : { type: "workspaceWrite", writableRoots: run.taskSnapshot.environment?.writableRoots ?? [run.taskSnapshot.projectDir], networkAccess: false, excludeSlashTmp: true, excludeTmpdirEnvVar: true },
      ...(run.taskSnapshot.environment ? { runtimeWorkspaceRoots: hasResumeAuthorization(run.taskSnapshot) ? resumeWorkspaceRoots(run.taskSnapshot) : run.taskSnapshot.environment.roots.length ? run.taskSnapshot.environment.roots : [run.taskSnapshot.projectDir] } : {}),
      ...(hasResumeAuthorization(run.taskSnapshot) ? { environments: [] } : {}),
      ...(run.taskSnapshot.model ? { model: run.taskSnapshot.model } : {}),
      ...(execution?.effort ? { effort: execution.effort } : {}),
    });
    if (!isRecord(response) || !isRecord(response.turn) || typeof response.turn.id !== "string") throw new AppError("CODEX_PROTOCOL_ERROR", "回合启动响应缺少 turn.id。");
    turnId = response.turn.id;
    sink.turn(turnId);
    for (const event of buffered) consume(event.method, event.params);
    if (response.turn.status !== "inProgress" && typeof response.turn.status === "string") {
      if (Array.isArray(response.turn.items)) for (const item of response.turn.items) if (isRecord(item)) agentItem(item);
      finish({ status: response.turn.status, usageLimitExceeded: usageFailure(response.turn) });
    }
    if (signal.aborted) abort();
    if (stopping) requestStop(stopping);
    const result = await terminal;
    if ("error" in result) return { status: "needs_attention", output: output(), error: `${result.error.code}: ${result.error.message}` };
    if (stopping === "attention") return { status: "needs_attention", output: output(), error: "EXECUTION_REVIEW_REQUIRED: 任务需要审批、补充输入或超出当前输出限制。" };
    if (result.status === "completed") return { status: "succeeded", output: output(), error: null };
    if (result.status === "interrupted") return {
      status: stopping === "timeout" ? "failed" : "cancelled", output: output(),
      error: stopping === "timeout" ? "EXECUTION_TIMEOUT: 任务超时，已确认回合中断。" : null,
    };
    if (result.status === "failed") return { status: "failed", output: output(), error: result.usageLimitExceeded ? "CODEX_QUOTA_INTERRUPTED: 已确认回合因额度耗尽失败。" : "CODEX_TURN_FAILED: Codex 回合未成功完成。",
      ...(result.usageLimitExceeded && !stopping ? { quotaFailure: { threadId, turnId } } : {}) };
    return { status: "needs_attention", output: output(), error: "CODEX_TURN_STATUS_UNKNOWN: 未识别的回合状态，请人工核对。" };
  } catch (error) {
    const diagnostic = rpcDiagnostic(error);
    if (diagnostic) sink.event("codex_rpc_error", { ...diagnostic });
    const appError = error instanceof AppError ? error : new AppError("EXECUTION_FAILED", "手动执行失败。");
    return { status: submitted ? "needs_attention" : appError.code === "TIMED_PROTECTION_ACTIVE" ? "waiting_quota" : "failed", output: output(), error: `${appError.code}: ${appError.message}` };
  } finally {
    signal.removeEventListener("abort", abort);
    offNotification(); offFailure();
    clearTimeout(stopTimer);
  }
}
