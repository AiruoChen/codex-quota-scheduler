import type { TaskExecutor } from "../domain/ports.js";
import { systemClock, type Clock } from "../domain/ports.js";
import type { ExecutionOutcome, ExecutionSink, TaskRun } from "../domain/task.js";
import { AppError } from "../shared/errors.js";
import { stat, realpath } from "node:fs/promises";
import type { AppConfig } from "../config/load.js";
import { connectCodex, readAccount, readQuota } from "../adapters/codex/session.js";
import { evaluateQueue } from "../scheduler/evaluate.js";
import { isRecord } from "../shared/validation.js";
import { runTurn } from "./turn-runner.js";

export class CodexExecutor implements TaskExecutor {
  constructor(private readonly config: AppConfig, private readonly clock: Clock = systemClock) {}

  async execute(run: TaskRun, signal: AbortSignal, sink: ExecutionSink): Promise<ExecutionOutcome> {
    if (this.config.provider !== "codex") throw new AppError("EXECUTION_REQUIRES_CODEX", "手动执行必须使用 provider=codex，不能使用模拟额度。");
    if (!(await stat(run.taskSnapshot.projectDir)).isDirectory()) throw new AppError("PROJECT_NOT_FOUND", "任务工作目录不是有效目录。");
    if (!run.promptSnapshot.trim()) throw new AppError("EMPTY_PROMPT", "任务指令为空。");
    const { client, launch } = await connectCodex(this.config.codex, signal);
    try {
      const quota = await readQuota(client, this.clock, launch.version, signal);
      const decision = evaluateQueue(quota, [run.taskSnapshot], this.config, this.clock.now(), false);
      sink.event("preflight", { source: quota.source, cliVersion: launch.version, planType: quota.account?.planType, decision });
      if (decision.action !== "run") return { status: "waiting_quota", output: "", error: `QUOTA_WAIT: ${decision.reason}` };
      const task = run.taskSnapshot;
      if (task.session.mode === "resume") {
        const stored = await client.request("thread/read", { threadId: task.session.threadId, includeTurns: false }, signal);
        if (!isRecord(stored) || !isRecord(stored.thread) || typeof stored.thread.cwd !== "string"
          || await realpath(stored.thread.cwd) !== await realpath(task.projectDir)) throw new AppError("THREAD_PROJECT_MISMATCH", "续接会话的工作目录与任务项目不一致。");
        if (isRecord(stored.thread.status) && stored.thread.status.type === "active") throw new AppError("THREAD_BUSY", "目标会话已有活动回合。");
      }
      const response = await client.request(task.session.mode === "new" ? "thread/start" : "thread/resume", {
        ...(task.session.mode === "resume" ? { threadId: task.session.threadId, excludeTurns: true } : {}),
        cwd: task.projectDir, approvalPolicy: "on-request", approvalsReviewer: "user", sandbox: task.execution?.sandbox ?? "read-only",
        ...(task.model ? { model: task.model } : {}),
      }, signal);
      if (!isRecord(response) || !isRecord(response.thread) || typeof response.thread.id !== "string") throw new AppError("CODEX_PROTOCOL_ERROR", "会话响应缺少 thread.id。");
      const thread = response.thread;
      if (isRecord(thread.status) && thread.status.type === "active") throw new AppError("THREAD_BUSY", "目标会话已有活动回合，不能追加指令。");
      if (task.session.mode === "resume") {
        if (thread.id !== task.session.threadId || typeof thread.cwd !== "string" || await realpath(thread.cwd) !== await realpath(task.projectDir)) {
          throw new AppError("THREAD_PROJECT_MISMATCH", "续接会话的工作目录与任务项目不一致。");
        }
      }
      sink.thread(thread.id as string);
      sink.event("thread_ready", { threadId: thread.id, model: response.model ?? task.model ?? null, sandbox: task.execution?.sandbox ?? "read-only" });
      const account = await readAccount(client, signal);
      if (JSON.stringify(account) !== JSON.stringify(quota.account)) throw new AppError("ACCOUNT_CHANGED", "额度查询后账户发生变化，本次指令未发送。");
      if (signal.aborted) return { status: signal.reason === "timeout" ? "failed" : "cancelled", output: "", error: signal.reason === "timeout" ? "EXECUTION_TIMEOUT: 提交前超时。" : null };
      return await runTurn(client, thread.id as string, run, signal, sink);
    } finally { await client.close(); }
  }
}
