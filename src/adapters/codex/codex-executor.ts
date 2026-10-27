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
import { catalogScope } from "./catalog.js";
import { continuationReady, quotaInterruption } from "../../domain/continuation.js";
import { validateModel } from "./model-validation.js";

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
    const environment = run.taskSnapshot.environment;
    if (environment && !environment.permissionsVerified) throw new AppError("CODEX_ENVIRONMENT_UNVERIFIED", "执行环境权限信息不完整，不能发送任务。");
    const { client, launch } = await connectCodex(this.config.codex, signal, !!environment);
    try {
      let quota = await this.verifiedQuota(client, launch.version, signal, expectedAccount);
      const continuation = run.continuation;
      if (continuation && (continuation.connectionKey !== codexConnectionKey(this.config.codex) || continuation.accountScope !== catalogScope(this.config.codex, quota.account))) throw new AppError("CONTINUATION_SCOPE_CHANGED", "续接链的账户或来源发生变化，请人工核对。");
      if (continuation && !continuationReady(continuation.evidence, quota, this.config, this.clock.now())) return { status: "waiting_quota", output: "", error: "QUOTA_WAIT: awaiting_confirmed_reset" };
      if (environment && (environment.connectionKey !== codexConnectionKey(this.config.codex) || environment.scope !== catalogScope(this.config.codex, quota.account))) throw new AppError("CATALOG_SCOPE_CHANGED", "任务环境与当前账户或来源不一致。");
      if (environment?.projectId) {
        const project = await client.request("project/read", { projectId: environment.projectId }, signal);
        if (!isRecord(project) || !isRecord(project.project) || !Array.isArray(project.project.roots)) throw new AppError("CODEX_ENVIRONMENT_UNVERIFIED", "项目文件夹信息不可用。");
        const paths = await Promise.all(project.project.roots.map(async (root: unknown) => {
          if (!isRecord(root) || typeof root.path !== "string") throw new AppError("CODEX_ENVIRONMENT_UNVERIFIED", "项目目录响应无效。");
          return realpath(root.path);
        }));
        if (JSON.stringify(paths.slice().sort()) !== JSON.stringify(environment.roots.slice().sort())) throw new AppError("PROJECT_CHANGED", "项目关联文件夹已变化，请重新核对任务环境。");
      }
      const availability = this.quotaGuard.observe(quota);
      const decision = availability.status === "available" ? { action: "run", taskId: run.taskId } : { action: "wait", reason: availability.reason };
      sink.event("preflight", { source: quota.source, cliVersion: launch.version, planType: quota.account?.planType, decision });
      if (decision.action !== "run") return { status: "waiting_quota", output: "", error: `QUOTA_WAIT: ${decision.reason}` };
      sink.origin({ connectionKey: codexConnectionKey(this.config.codex), account: quota.account, cliVersion: launch.version });
      const task = run.taskSnapshot;
      await validateModel(client, task, signal);
      if (task.session.mode === "resume") {
        const stored = await client.request("thread/read", { threadId: task.session.threadId, includeTurns: false }, signal);
        if (!isRecord(stored) || !isRecord(stored.thread) || typeof stored.thread.cwd !== "string"
          || await realpath(stored.thread.cwd) !== await realpath(task.projectDir)) throw new AppError("THREAD_PROJECT_MISMATCH", "续接会话的工作目录与任务项目不一致。");
        if (isRecord(stored.thread.status) && stored.thread.status.type === "active") throw new AppError("THREAD_BUSY", "目标会话已有活动回合。");
        if (continuation) {
          // This read detects conflicting later activity; it never selects a replacement recovery target.
          const latest = await client.request("thread/turns/list", { threadId: task.session.threadId, limit: 1, itemsView: "notLoaded", sortDirection: "desc" }, signal);
          if (!isRecord(latest) || !Array.isArray(latest.data) || latest.data.length !== 1 || !isRecord(latest.data[0])
            || latest.data[0].id !== continuation.parentTurnId || latest.data[0].status !== "failed") throw new AppError("CONTINUATION_HISTORY_CONFLICT", "会话已有其他回合或无法确认准确父回合，请人工核对。");
        }
      }
      const response = await client.request(task.session.mode === "new" ? "thread/start" : "thread/resume", {
        ...(task.session.mode === "resume" ? { threadId: task.session.threadId, excludeTurns: true } : {}),
        ...(environment ? { runtimeWorkspaceRoots: environment.roots.length ? environment.roots : [environment.cwd],
          ...(task.session.mode === "new" && environment.projectKnown ? { projectId: environment.projectId } : {}) } : {}),
        cwd: task.projectDir, approvalPolicy: "on-request", approvalsReviewer: "user", sandbox: task.execution?.sandbox ?? "read-only",
        ...(task.model ? { model: task.model } : {}),
      }, signal);
      if (!isRecord(response) || !isRecord(response.thread) || typeof response.thread.id !== "string") throw new AppError("CODEX_PROTOCOL_ERROR", "会话响应缺少 thread.id。");
      const thread = response.thread;
      if (environment?.projectKnown && thread.projectId !== environment.projectId) throw new AppError("PROJECT_CHANGED", "服务端返回的项目归属与任务快照不一致。");
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
      const result = await runTurn(client, thread.id as string, run, signal, sink, () => continuation && !continuationReady(continuation.evidence, quota, this.config, this.clock.now())
        ? { status: "unknown", reason: "unknown_quota" } : this.quotaGuard.check(quota));
      if (result.quotaFailure && task.quotaContinuation?.enabled && !signal.aborted) {
        try {
          const fresh = await this.verifiedQuota(client, launch.version, signal, quota.account);
          this.quotaGuard.observe(fresh);
          const previousWindows = quota.buckets.find(bucket => bucket.id === this.config.limitId)?.windows ?? [];
          const complete = previousWindows.every(previous => fresh.buckets.find(bucket => bucket.id === this.config.limitId)?.windows.some(window => window.slot === previous.slot && window.durationMinutes === previous.durationMinutes));
          const evidence = complete && quotaInterruption(fresh, this.config, this.clock.now(), { ...result.quotaFailure,
            connectionKey: codexConnectionKey(this.config.codex), accountScope: catalogScope(this.config.codex, fresh.account) });
          if (evidence) result.quotaInterruption = evidence;
          else sink.event("quota_continuation_blocked", { reason: "quota_evidence_incomplete" });
        } catch { sink.event("quota_continuation_blocked", { reason: "quota_read_unverified" }); }
      }
      return result;
    } finally { await client.close(); }
  }
}
