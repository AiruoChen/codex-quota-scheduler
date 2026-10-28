import type { AppConfig } from "../config/load.js";
import type { Clock, TaskExecutor } from "../domain/ports.js";
import { systemClock } from "../domain/ports.js";
import type { ExecutionOutcome, ExecutionSink, TaskRun } from "../domain/task.js";
import { AppError, systemErrorCode } from "../shared/errors.js";
import type { SqliteStore } from "../storage/sqlite-store.js";
import { CodexExecutor } from "../adapters/codex/codex-executor.js";
import type { QuotaSnapshot } from "../domain/quota.js";
import { redact } from "../shared/redact.js";
import { quotaStreamKey } from "../monitor/context.js";
import { SqliteMonitorRepository } from "../storage/monitor-repository.js";
import { MonitoredExecutionQuota } from "./quota-guard.js";
import { rpcDiagnostic } from "../adapters/codex/rpc-errors.js";
import { ContinuationRepository } from "../storage/continuation-repository.js";

export class ManualExecutionService {
  private readonly executor: TaskExecutor;
  constructor(private readonly config: AppConfig, private readonly store: SqliteStore, private readonly clock: Clock = systemClock, executor?: TaskExecutor) {
    this.executor = executor ?? new CodexExecutor(config, clock, new MonitoredExecutionQuota(
      new SqliteMonitorRepository(store.database, quotaStreamKey(config), config, clock), config, clock));
  }

  async runTask(taskId: string, signal: AbortSignal, started?: (id: string) => void, expectedRevision?: number): Promise<TaskRun> {
    this.requireReal();
    return this.executeClaimed(this.store.execution.claimNew(taskId, expectedRevision).id, signal, started);
  }

  async start(id: string, signal: AbortSignal, started?: (id: string) => void): Promise<TaskRun> {
    this.requireReal();
    return this.executeClaimed(this.store.execution.claim(id).id, signal, started);
  }

  async executeClaimed(id: string, signal: AbortSignal, started?: (id: string) => void, expectedAccount?: QuotaSnapshot["account"]): Promise<TaskRun> {
    this.requireReal();
    const run = this.store.execution.takeClaim(id);
    let finalized = false;
    const controller = new AbortController();
    const abort = () => controller.abort("cancelled");
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    let output = run.output;
    let changed = false;
    let submissionStarted = false;
    let persistenceError: unknown;
    const timer = setTimeout(() => controller.abort("timeout"), run.taskSnapshot.execution?.timeoutMs ?? 900000);
    const poll = setInterval(() => {
      try {
        if (this.store.execution.cancelled(id)) controller.abort("cancelled");
        if (changed) { this.store.execution.progress(id, { output: redact(output) }); changed = false; }
      } catch (error) { persistenceError = error; controller.abort("storage_error"); }
    }, 200);
    const sink: ExecutionSink = {
      origin: (origin) => this.store.execution.origin(id, origin),
      event: (type, data) => this.store.execution.event(id, type, data),
      thread: (threadId) => this.store.execution.progress(id, { threadId }),
      submitted: () => { this.store.execution.event(id, "submission_started", {}); submissionStarted = true; },
      turn: (turnId) => this.store.execution.progress(id, { turnId }),
      output: (text) => { output = text; changed = true; },
    };
    try {
      started?.(id);
      let result: ExecutionOutcome;
      try { result = await this.executor.execute(run, controller.signal, sink, expectedAccount); }
      catch (error) {
        const diagnostic = rpcDiagnostic(error);
        if (diagnostic) sink.event("codex_rpc_error", { ...diagnostic });
        const failure = error instanceof AppError ? error : new AppError("EXECUTION_FAILED", "手动执行未完成，请检查项目目录、CLI 和网络。");
        sink.event("execution_exception", { code: failure.code, systemCode: systemErrorCode(error) });
        result = {
          status: submissionStarted ? "needs_attention" : controller.signal.aborted && controller.signal.reason !== "timeout" ? "cancelled" : "failed",
          output, error: controller.signal.reason === "timeout" ? "EXECUTION_TIMEOUT: 提交前超时。"
            : !submissionStarted && controller.signal.reason === "cancelled" ? null : `${failure.code}: ${failure.message}`,
        };
      }
      if (persistenceError) result = { status: "needs_attention", output, error: "STORAGE_WRITE_FAILED: 保存执行进度失败，请核对会话状态。" };
      const saved = this.store.database.transaction(() => {
        this.store.execution.event(id, "execution_finished", { status: result.status });
        const next = this.store.runs.updateInside(id, { status: result.status, output: redact(result.output), error: result.error }, "running");
        if (result.quotaInterruption) new ContinuationRepository(this.store.database, this.clock).planInside(next, result.quotaInterruption);
        return next;
      });
      finalized = true;
      return saved;
    } finally {
      clearInterval(poll); clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      if (finalized) this.store.execution.release(id);
    }
  }

  private requireReal(): void {
    if (this.config.provider !== "codex") throw new AppError("EXECUTION_REQUIRES_CODEX", "手动执行需要 provider=codex；模拟模式不发送指令。");
    if (this.config.storage.databasePath === ":memory:") throw new AppError("EXECUTION_REQUIRES_STORAGE", "真实执行需要文件数据库以保存状态。");
  }
}
