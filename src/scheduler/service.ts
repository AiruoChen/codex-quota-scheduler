import type { ClaimedExecution, SchedulerEvent, SchedulerMonitor, SchedulerRepository } from "../domain/scheduler.js";
import { AppError } from "../shared/errors.js";

/** Serial orchestration; all queue decisions and leases live behind the domain repository port. */
export class SchedulerService {
  constructor(readonly repository: SchedulerRepository, private readonly monitor: SchedulerMonitor,
    private readonly execution: ClaimedExecution, private readonly options: { provider: "mock" | "codex"; persistent: boolean }) {}

  async run(signal: AbortSignal, emit: (event: SchedulerEvent) => void | Promise<void>, samples = Infinity): Promise<void> {
    if (this.options.provider !== "codex") throw new AppError("SCHEDULER_REQUIRES_CODEX", "自动调度需要 provider=codex，模拟模式不发送指令。");
    if (!this.options.persistent) throw new AppError("SCHEDULER_REQUIRES_STORAGE", "自动调度需要文件数据库。");
    const token = this.repository.acquire();
    let callbackFailure: unknown;
    try {
      await this.monitor.run(signal, async (update) => {
        try {
          if (signal.aborted) return;
          const decision = this.repository.claimNext(token, update);
          if (decision.action === "wait") { await emit({ event: "scheduler_wait", reason: decision.reason }); return; }
          const id = decision.run.id;
          await emit({ event: "scheduler_started", runId: id });
          await this.execution.executeClaimed(id, signal, undefined, decision.expectedAccount);
          const run = this.repository.complete(token, id);
          await emit({ event: "scheduler_finished", runId: id, status: run.status });
        } catch (error) { callbackFailure = error; throw error; }
      }, samples);
      // A monitor may suppress cancellation errors; persistence/dispatch failures remain fatal.
      if (callbackFailure !== undefined) throw callbackFailure;
    } catch (error) { this.repository.pause("scheduler_error"); throw error; }
    finally { this.repository.release(token); }
  }
}
