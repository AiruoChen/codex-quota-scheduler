import type { ExecutionQuotaGuard, TaskExecutor } from "../../domain/ports.js";
import type { Clock } from "../../domain/ports.js";
import type { ExecutionOutcome, ExecutionSink, TaskRun } from "../../domain/task.js";
import { AppError } from "../../shared/errors.js";
import { stat, realpath } from "node:fs/promises";
import type { AppConfig } from "../../config/load.js";
import { connectCodex, readAccount, readQuota } from "./session.js";
import { hasQuotaIdentity } from "../../domain/quota-policy.js";
import { isRecord } from "../../shared/validation.js";
import { runTurn } from "./turn-runner.js";
import type { QuotaSnapshot } from "../../domain/quota.js";
import { codexConnectionKey } from "./connection-key.js";
import type { StdioRpcClient } from "./rpc-client.js";

type VerifiedQuota = QuotaSnapshot & { account: NonNullable<QuotaSnapshot["account"]> };
const sameAccount = (a: NonNullable<QuotaSnapshot["account"]>, b: NonNullable<QuotaSnapshot["account"]>) =>
  (["type", "email", "planType", "workspaceId"] as const).every((key) => a[key] === b[key]);

export class CodexExecutor implements TaskExecutor {
  constructor(private readonly config: AppConfig, private readonly clock: Clock, private readonly quotaGuard: ExecutionQuotaGuard) {}

  private async verifiedQuota(client: StdioRpcClient, version: string, signal: AbortSignal, expected?: QuotaSnapshot["account"]): Promise<VerifiedQuota> {
    const quota = await readQuota(client, this.clock, version, signal);
    if (!hasQuotaIdentity(quota.account)) throw new AppError("ACCOUNT_UNKNOWN", "执行账户缺少可验证标识，不能发送任务。");
    if (expected && !sameAccount(quota.account, expected)) throw new AppError("ACCOUNT_CHANGED", "执行账户与已验证账户不一致，指令未发送。");
    const after = await readAccount(client, signal);
    if (!hasQuotaIdentity(after) || !sameAccount(after, quota.account)) throw new AppError("ACCOUNT_CHANGED", "额度查询期间账户发生变化，指令未发送。");
    return { ...quota, account: quota.account };
  }

  async execute(run: TaskRun, signal: AbortSignal, sink: ExecutionSink, expectedAccount?: QuotaSnapshot["account"]): Promise<ExecutionOutcome> {
    if (this.config.provider !== "codex") throw new AppError("EXECUTION_REQUIRES_CODEX", "手动执行必须使用 provider=codex，不能使用模拟额度。");
    if (!run.taskSnapshot.enabled) return { status: "waiting_quota", output: "", error: "QUOTA_WAIT: empty_queue" };
    if (!(await stat(run.taskSnapshot.projectDir)).isDirectory()) throw new AppError("PROJECT_NOT_FOUND", "任务工作目录不是有效目录。");
    if (!run.promptSnapshot.trim()) throw new AppError("EMPTY_PROMPT", "任务指令为空。");
    const { client, launch } = await connectCodex(this.config.codex, signal);
    try {
      let quota = await this.verifiedQuota(client, launch.version, signal, expectedAccount);
      const availability = this.quotaGuard.observe(quota);
      const decision = availability.status === "available" ? { action: "run", taskId: run.taskId } : { action: "wait", reason: availability.reason };
      sink.event("preflight", { source: quota.source, cliVersion: launch.version, planType: quota.account?.planType, decision });
      if (decision.action !== "run") return { status: "waiting_quota", output: "", error: `QUOTA_WAIT: ${decision.reason}` };
      sink.origin({ connectionKey: codexConnectionKey(this.config.codex), account: quota.account, cliVersion: launch.version });
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
      if (!hasQuotaIdentity(account) || !sameAccount(account, quota.account)) throw new AppError("ACCOUNT_CHANGED", "额度查询后账户发生变化，本次指令未发送。");
      if (signal.aborted) return { status: signal.reason === "timeout" ? "failed" : "cancelled", output: "", error: signal.reason === "timeout" ? "EXECUTION_TIMEOUT: 提交前超时。" : null };
      const final = this.quotaGuard.check(quota);
      if (final.status !== "available") {
        // Clock rollback cannot be repaired by relabelling this in-flight read with a new timestamp.
        if (this.clock.now().getTime() < Date.parse(quota.fetchedAt)) return { status: "waiting_quota", output: "", error: "QUOTA_WAIT: stale_quota" };
        quota = await this.verifiedQuota(client, launch.version, signal, quota.account);
        const refreshed = this.quotaGuard.observe(quota);
        sink.event("preflight_refreshed", { status: refreshed.status, reason: refreshed.reason });
        if (refreshed.status !== "available") return { status: "waiting_quota", output: "", error: `QUOTA_WAIT: ${refreshed.reason}` };
      }
      return await runTurn(client, thread.id as string, run, signal, sink, () => this.quotaGuard.check(quota));
    } finally { await client.close(); }
  }
}
