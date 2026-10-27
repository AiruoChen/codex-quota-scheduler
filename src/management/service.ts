import { dirname, resolve } from "node:path";
import { createApp } from "../app.js";
import type { AppConfig } from "../config/load.js";
import { ConfigManager } from "../config/manage.js";
import { systemClock, type Clock } from "../domain/ports.js";
import { AppError } from "../shared/errors.js";
import { isRecord, requireRecord, requireString } from "../shared/validation.js";
import { parseTask } from "../tasks/load.js";
import type { RuntimeActivity, ShutdownMode } from "../domain/lifecycle.js";
import type { SchedulerRepository } from "../domain/scheduler.js";
import type { ExecutionRepository } from "../storage/execution-repository.js";
import { setTimeout as delay } from "node:timers/promises";
import { quotaDisplay } from "./quota-display.js";

export interface ManagementJob {
  id: number;
  kind: string;
  state: "running" | "succeeded" | "failed";
  runId: string | null;
  code: string | null;
  detail: string | null;
}
export type RuntimeLog = (event: string, code?: string) => void;
type Work = { job: ManagementJob; controller: AbortController; done: Promise<void> };

/** Owns long operations independently of browser connections. Domain services retain all execution rules. */
export class ManagementService {
  readonly app: ReturnType<typeof createApp>;
  private readonly works: Work[] = [];
  private loop: Work | undefined;
  private sequence = 0;
  private changingLoop = false;
  private closing = false;
  private closed = false;
  private closePromise: Promise<void> | undefined;
  private settlePromise: Promise<void> | undefined;
  private shutdownMode: ShutdownMode | null = null;
  private schedulerRepository: SchedulerRepository | undefined;
  private executionRepository: ExecutionRepository | undefined;
  private recoveryPromise: ReturnType<ReturnType<typeof createApp>["recovery"]> | undefined;
  private dispatch: { reason: string | null; event: string; observedAt: string } | null = null;

  constructor(readonly config: AppConfig, readonly configPath: string, private readonly log: RuntimeLog = () => {},
    private readonly clock: Clock = systemClock) { this.app = createApp(config, clock); }

  async initialize(): Promise<void> {
    await this.app.taskService();
    const recovery = await this.recovery();
    const scheduler = await this.app.scheduling();
    this.schedulerRepository = scheduler.repository;
    this.executionRepository = (await this.app.storage()).execution;
    // Never repair a stale owner or restart dispatch as a side effect of opening the UI.
    if (!scheduler.repository.status().worker) scheduler.repository.pause("management_started");
    recovery.repository.report();
    await this.loopAction("monitor-start");
  }

  recovery() { return this.recoveryPromise ??= this.app.recovery(); }

  private ensureOpen(): void {
    if (this.closing) throw new AppError("RUNTIME_STOPPING", "服务正在停止，请等待当前操作结束。");
  }

  async state() {
    const monitor = await this.app.monitoring();
    // The repository preserves identity, window-history and freshness safeguards.
    const saved = monitor.repository.status();
    const active = (await this.app.storage()).execution.active();
    const run = active ? await (await this.app.storage()).runs.get(active.runId) : null;
    return { provider: this.config.provider, closing: this.closing, now: this.clock.now().toISOString(),
      monitor: saved,
      dispatch: this.loop?.job.kind === "scheduler" && this.loop.job.state === "running" ? this.dispatch : null,
      quota: quotaDisplay(saved, this.config, this.clock.now()),
      currentRun: run ? { id: run.id, taskId: run.taskId, name: run.taskSnapshot.name, revision: run.taskRevision,
        status: run.status, startedAt: run.startedAt } : null,
      events: monitor.repository.events().slice(-30),
      scheduler: (await this.app.scheduling()).repository.status(),
      recovery: (await this.recovery()).repository.report(),
      jobs: this.works.map((work) => ({ ...work.job })), loop: this.loop?.job.state === "running" ? this.loop.job.kind : null };
  }

  async tasks() {
    return (await this.app.tasks()).map(({ promptSnapshot: _prompt, ...task }) => task);
  }

  async saveTask(input: unknown) {
    this.ensureOpen();
    const data = requireRecord(input, "任务");
    const definition = requireRecord(data.definition, "definition");
    const id = requireString(definition.id, "id");
    const prompt = requireString(data.prompt, "指令");
    // A UI prompt lives exclusively in SQLite. This provenance path is never read or written.
    const task = parseTask({ ...definition, promptFile: definition.promptFile ?? resolve(dirname(this.configPath), "../.local/ui-prompts", encodeURIComponent(id) + ".md") }, dirname(this.configPath));
    const store = await this.app.storage();
    this.ensureOpen();
    return data.revision === undefined ? store.tasks.create(task, prompt) : store.tasks.update(task, prompt, revision(data.revision));
  }

  private launch(kind: string, action: (signal: AbortSignal, started: (id: string) => void) => Promise<unknown>): Work {
    this.ensureOpen();
    // Check and register without an await between them: setup may have yielded to another request.
    const isManual = (operation: string) => operation !== "monitor" && operation !== "scheduler";
    if (isManual(kind) && this.works.some((work) => work.job.state === "running" && isManual(work.job.kind))) {
      throw new AppError("MANAGEMENT_BUSY", "已有手动操作正在进行，请等待完成。");
    }
    // Keep a bounded operation list. Running operations are never evicted.
    while (this.works.length >= 30) {
      const index = this.works.findIndex((work) => work.job.state !== "running");
      if (index < 0) throw new AppError("MANAGEMENT_BUSY", "活动操作过多，请稍后重试。");
      this.works.splice(index, 1);
    }
    const job: ManagementJob = { id: ++this.sequence, kind, state: "running", runId: null, code: null, detail: null };
    const controller = new AbortController();
    const work: Work = { job, controller, done: Promise.resolve() };
    this.works.push(work);
    this.log("job_started");
    // Schedule after the work is registered, including for synchronous validation failures.
    work.done = Promise.resolve().then(() => action(controller.signal, (id) => { job.runId = id; }))
      .then((result: unknown) => {
        job.state = "succeeded";
        if (isRecord(result)) {
          if (typeof result.status === "string") job.detail = result.status;
          if (isRecord(result.result) && result.result.kind === "terminal") job.detail = `TURN_CONFIRMED: ${String(result.result.turnStatus)}`;
        }
        this.log("job_finished");
      })
      .catch((error: unknown) => {
        job.state = "failed"; job.code = error instanceof AppError ? error.code : "OPERATION_FAILED";
        this.log("job_failed", job.code);
      });
    return work;
  }

  async loopAction(action: string) {
    this.ensureOpen();
    if (this.changingLoop) throw new AppError("MANAGEMENT_BUSY", "监控或调度正在切换，请稍后重试。");
    this.changingLoop = true;
    try {
      if (action === "sample") {
        if (this.loop?.job.state === "running") {
          (await this.app.monitoring()).requestSample();
          return { requested: true };
        }
        return await (await this.app.monitoring()).sample();
      }
      if (!["monitor-start", "monitor-stop", "scheduler-start", "scheduler-stop"].includes(action)) throw new AppError("INVALID_ARGUMENT", "未知监控操作。");
      if (action === "scheduler-start") {
        this.requireReal();
        if (this.loop?.job.kind !== "scheduler" && (await this.app.scheduling()).repository.status().worker) {
          throw new AppError("SCHEDULER_BUSY", "已有调度进程或遗留进程记录；请先核对状态，不会替换它。");
        }
      }
      const kind = action.startsWith("scheduler") ? "scheduler" : "monitor";
      const stopping = action.endsWith("stop");
      if (stopping && this.loop?.job.kind !== kind) return { stopped: false };
      if (!stopping && this.loop?.job.state === "running" && this.loop.job.kind === kind) return { ...this.loop.job };
      if (this.loop?.job.kind === "scheduler" && this.loop.job.state === "running") (await this.app.scheduling()).repository.pause("worker_stopping");
      this.loop?.controller.abort();
      await this.loop?.done;
      this.loop = undefined;
      if (stopping) return { stopped: true };
      this.ensureOpen();
      const monitor = await this.app.monitoring();
      const scheduler = await this.app.scheduling();
      if (kind === "scheduler") scheduler.repository.pause("worker_started");
      this.dispatch = null;
      this.loop = this.launch(kind, (signal) => kind === "monitor"
        ? monitor.run(signal, (update) => { if (update.events.length) this.log("quota_changed"); })
        : scheduler.run(signal, (event) => { this.dispatch = { reason: event.reason ?? null, event: event.event, observedAt: this.clock.now().toISOString() }; this.log(event.event); }));
      return { ...this.loop.job };
    } finally { this.changingLoop = false; }
  }

  private requireReal(): void {
    if (this.config.provider !== "codex" || this.config.storage.databasePath === ":memory:") {
      throw new AppError("EXECUTION_REQUIRES_CODEX", "真实执行需要 provider=codex 和文件数据库；模拟模式不发送指令。");
    }
  }

  async action(action: string, input: unknown) {
    this.ensureOpen();
    const data = requireRecord(input, "请求");
    const store = await this.app.storage();
    const scheduler = (await this.app.scheduling()).repository;
    this.ensureOpen();
    if (action === "task-save") return this.saveTask(data);
    if (action === "task-delete") { await store.tasks.remove(requireString(data.id, "id"), revision(data.revision)); return { archived: true }; }
    if (action === "enqueue") return scheduler.enqueue(requireString(data.id, "id"), data.revision === undefined ? undefined : revision(data.revision));
    if (action === "task-enable") {
      if (typeof data.enabled !== "boolean") throw new AppError("INVALID_ARGUMENT", "enabled 必须为布尔值。");
      const task = await store.tasks.get(requireString(data.id, "id"));
      if (!task) throw new AppError("TASK_NOT_FOUND", "任务不存在或已归档。");
      this.ensureOpen();
      return store.tasks.update({ ...task, enabled: data.enabled }, task.promptSnapshot, revision(data.revision));
    }
    if (action === "remove") return scheduler.remove(requireString(data.id, "id"));
    if (action === "pause") { scheduler.pause(); return scheduler.status(); }
    if (action === "resume") {
      this.requireReal();
      if (this.changingLoop || this.loop?.job.kind !== "scheduler" || this.loop.job.state !== "running") throw new AppError("SCHEDULER_NOT_STARTED", "请先启动调度进程，再恢复队列。");
      scheduler.resume(); return scheduler.status();
    }
    if (action === "acknowledge") {
      if (data.confirm !== true) throw new AppError("CONFIRM_REQUIRED", "请先人工核对已有会话和文件变更。");
      scheduler.acknowledge(requireString(data.id, "id")); return scheduler.status();
    }
    if (action === "cancel") return store.execution.cancel(requireString(data.id, "id"));
    if (["run", "run-start", "inspect", "reconcile"].includes(action)) {
      this.requireReal();
      const id = requireString(data.id, "id");
      const execution = await this.app.execution();
      const recovery = await this.recovery();
      return { ...this.launch(action, async (signal, started) => {
        if (action === "run") return execution.runTask(id, signal, started, data.revision === undefined ? undefined : revision(data.revision));
        if (action === "run-start") return execution.start(id, signal, started);
        started(id);
        const result = action === "inspect" ? await recovery.inspect(id, signal) : await recovery.reconcile(id, signal);
        // The durable run/events provide results; a pending/unknown read is not a confirmed recovery.
        if (result.result.kind !== "terminal") throw new AppError(result.result.code, "尚未确认远端终态。");
        return result;
      }).job };
    }
    if (action === "repair") {
      if (data.confirm !== true) throw new AppError("CONFIRM_REQUIRED", "修复需要明确确认。");
      const recovery = await this.recovery();
      this.ensureOpen();
      return recovery.repository.repair();
    }
    if (action === "config-set") {
      if (this.works.some((work) => work.job.state === "running" && work.job.kind !== "monitor")) throw new AppError("MANAGEMENT_BUSY", "请先停止调度并等待执行或核对结束，再修改配置。");
      const saved = await new ConfigManager(this.configPath).set(requireString(data.key, "key"), data.value);
      return { config: saved, restartRequired: true };
    }
    throw new AppError("INVALID_ARGUMENT", "未知管理操作。");
  }

  activity(): RuntimeActivity {
    const active = this.executionRepository?.active();
    const manual = this.works.filter((work) => work !== this.loop && work.job.state === "running");
    const ownRun = active?.ownerPid === process.pid ? active.runId : null;
    return { activeOperations: manual.length + (ownRun && !manual.some((work) => work.job.runId === ownRun) ? 1 : 0),
      activeRunId: ownRun, paused: this.schedulerRepository?.status().paused ?? true };
  }

  /** Admission and dispatch stop synchronously. Waiting never aborts an active turn. */
  beginShutdown(mode: ShutdownMode = "cancel"): void {
    if (this.closed) return;
    this.closing = true;
    if (this.shutdownMode !== "cancel") this.shutdownMode = mode;
    if (this.loop?.job.kind === "scheduler") this.schedulerRepository?.pause("runtime_stopping");
    if (this.shutdownMode === "cancel") for (const work of this.works) work.controller.abort();
  }

  prepareStop(mode: ShutdownMode = "cancel"): Promise<void> {
    this.beginShutdown(mode);
    return this.settlePromise ??= (async () => {
      await Promise.all(this.works.filter((work) => work !== this.loop).map((work) => work.done));
      while (this.loop?.job.kind === "scheduler" && this.loop.job.state === "running" && this.activity().activeRunId) await delay(50);
      for (const work of this.works) work.controller.abort();
      await Promise.all(this.works.map((work) => work.done));
    })();
  }

  close(mode: ShutdownMode = "cancel"): Promise<void> {
    this.beginShutdown(mode);
    this.closePromise ??= (async () => {
      try { await this.prepareStop(mode); }
      finally { try { await this.app.close(); } finally { this.closed = true; } }
    })();
    return this.closePromise;
  }
}

export function revision(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new AppError("INVALID_ARGUMENT", "revision 必须是正整数。");
  return Number(value);
}
