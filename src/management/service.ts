import { dirname, resolve } from "node:path";
import { createApp } from "../app.js";
import type { AppConfig } from "../config/load.js";
import { ConfigManager } from "../config/manage.js";
import { systemClock, type Clock } from "../domain/ports.js";
import { AppError } from "../shared/errors.js";
import { isRecord, requireNumber, requireRecord, requireString } from "../shared/validation.js";
import { parseTask } from "../tasks/load.js";
import type { RuntimeActivity, ShutdownMode } from "../domain/lifecycle.js";
import type { SchedulerRepository } from "../domain/scheduler.js";
import type { ExecutionRepository } from "../storage/execution-repository.js";
import { setTimeout as delay } from "node:timers/promises";
import { quotaDisplay } from "./quota-display.js";
import { desktopEvents } from "../storage/desktop-feed.js";
import { digest } from "../monitor/recognize.js";
import type { FeedRequest, DesktopFeed } from "../domain/notifications.js";
import { readRpcDiagnostic } from "../adapters/codex/rpc-errors.js";
import { CodexCatalog } from "../adapters/codex/catalog.js";
import { resolveTaskTarget } from "./task-target.js";
import { ContinuationRepository } from "../storage/continuation-repository.js";
import { runDiagnostics } from "./run-diagnostics.js";

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
  viewScope(): string { return digest(this.configPath); }
  async preferences() {
    const db = (await this.app.storage()).database;
    const value = db.connection.prepare("SELECT value FROM metadata WHERE key=?").get(`ui.taskSort:${this.viewScope()}`)?.value;
    if (value !== undefined && value !== "created_asc" && value !== "created_desc") throw new AppError("STORAGE_INVALID", "任务排序偏好无效，请保留数据核对。");
    return { taskSort: value ?? "created_desc" };
  }
  async catalog(kind: string, params: URLSearchParams) {
    this.ensureOpen();
    if (this.config.provider !== "codex") return { source: "mock", scope: digest(["mock", this.configPath]), items: [], nextCursor: null };
    const catalog = new CodexCatalog(this.config.codex), cursor = params.get("cursor") ?? undefined;
    if (cursor && cursor.length > 4000) throw new AppError("INVALID_ARGUMENT", "目录分页标识过长。");
    if (kind === "models") return { source: "codex", ...await catalog.models(cursor) };
    if (kind === "projects") return { source: "codex", ...await catalog.projects(cursor) };
    if (kind === "threads") return { source: "codex", ...await catalog.threads(params.get("projectId") ?? undefined, cursor, params.get("scope") ?? undefined) };
    if (kind === "environment") return { source: "codex", ...await catalog.environment(requireString(params.get("threadId"), "threadId"), params.get("scope") ?? undefined) };
    throw new AppError("HTTP_NOT_FOUND", "目录接口不存在。");
  }
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

  async desktopFeed(request: FeedRequest): Promise<DesktopFeed> {
    const store = await this.app.storage(), monitor = await this.app.monitoring();
    return store.database.transaction(() => {
      const identity = store.database.connection.prepare("SELECT value FROM metadata WHERE key='database_identity'").get()?.value;
      if (typeof identity !== "string" || !/^[a-f0-9]{32}$/.test(identity)) throw new AppError("STORAGE_INVALID", "数据库来源标识无效，请保留原文件核对。");
      const scope = digest([identity, this.config]);
      const state = monitor.repository.status();
      const events = monitor.repository.events(), now = this.clock.now().getTime();
      const boundary = events.filter((event) => ["baseline", "identity_changed", "clock_changed"].includes(event.type)).at(-1)?.sequence ?? 0;
      const age = now - Date.parse(state?.snapshot?.fetchedAt ?? "");
      const fresh = !!state?.identity && !state.errorCode && age >= 0 && age <= this.config.quotaMaxAgeMs;
      return { provider: this.config.provider, ...desktopEvents(store.database, scope, request.scope === scope ? request.cursor : null, events,
        (event) => fresh && event.sequence > boundary && now >= Date.parse(event.createdAt) && now - Date.parse(event.createdAt) <= this.config.quotaMaxAgeMs),
        monitor: state ? { failures: state.failures, errorCode: state.errorCode } : null };
    });
  }

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

  async runDiagnostics(id: string) {
    const store = await this.app.storage(), target = (await this.recovery()).repository.target(id);
    return runDiagnostics(target.run, store.execution.events(id), this.clock.now(), store.execution.active()?.runId === id, target.origin !== null);
  }

  /** A deliberately small allowlist for user-exported diagnostics. Never serialize state, config or logs here. */
  async diagnostics() {
    const monitor = (await this.app.monitoring()).repository.status();
    const scheduler = (await this.app.scheduling()).repository.status();
    const recovery = (await this.recovery()).repository.report();
    const store = await this.app.storage();
    const rpcDiagnostics = store.database.connection.prepare("SELECT data_json FROM execution_events WHERE type='codex_rpc_error' ORDER BY sequence DESC LIMIT 10")
      .all().flatMap((row) => {
        try { const diagnostic = readRpcDiagnostic(JSON.parse(String(row.data_json))); return diagnostic ? [diagnostic] : []; }
        catch { return []; }
      });
    const count = (status: string) => scheduler.queue.filter((item) => item.status === status).length;
    const lastSample = monitor ? Date.parse(monitor.observedAt) : Number.NaN;
    const ageSeconds = Number.isFinite(lastSample) ? Math.round((this.clock.now().getTime() - lastSample) / 1000) : null;
    return {
      format: 1,
      createdAt: this.clock.now().toISOString(),
      environment: { platform: process.platform, arch: process.arch, nodeMajor: Number(process.versions.node.split(".")[0]) },
      provider: this.config.provider,
      service: { closing: this.closing, loop: this.loop?.job.state === "running" ? this.loop.job.kind : null,
        activeOperations: this.activity().activeOperations },
      quota: { status: monitor?.availability.status ?? "unknown", failures: monitor?.failures ?? 0, ageSeconds },
      scheduler: { paused: scheduler.paused, workerRecorded: scheduler.worker !== null,
        queue: { queued: count("queued"), waitingQuota: count("waiting_quota"), running: count("running"),
          succeeded: count("succeeded"), failed: count("failed"), cancelled: count("cancelled"),
          needsAttention: count("needs_attention") } },
      recovery: { issues: recovery.issues.length, owners: recovery.owners.length },
      codexRpcDiagnostics: rpcDiagnostics,
    };
  }

  async saveTask(input: unknown) {
    this.ensureOpen();
    const data = requireRecord(input, "任务");
    const definition = { ...requireRecord(data.definition, "definition") };
    const generated = definition.id === undefined || definition.id === "";
    const id = generated ? "generated-task" : requireString(definition.id, "id");
    const prompt = requireString(data.prompt, "指令");
    if (definition.environment !== undefined) throw new AppError("INVALID_ARGUMENT", "执行环境由后台读取，不能手填。");
    if (data.target !== undefined) {
      const execution = definition.execution === undefined ? {} : requireRecord(definition.execution, "execution");
      const resolved = await resolveTaskTarget(this.config, this.configPath, data.target, data.scope,
        generated ? requireString(data.requestId, "requestId") : id, execution.sandbox);
      definition.projectDir = resolved.environment.cwd;
      definition.environment = resolved.environment;
      definition.session = resolved.threadId ? { mode: "resume", threadId: resolved.threadId } : { mode: "new" };
    }
    // A UI prompt lives exclusively in SQLite. This provenance path is never read or written.
    const task = parseTask({ ...definition, id, promptFile: definition.promptFile ?? resolve(dirname(this.configPath), "../.local/ui-prompts", encodeURIComponent(id) + ".md") }, dirname(this.configPath));
    const store = await this.app.storage();
    this.ensureOpen();
    if (generated) {
      if (data.revision !== undefined) throw new AppError("INVALID_ARGUMENT", "编辑任务必须保留原任务 ID。");
      const { id: _id, ...fields } = task;
      return store.tasks.createGenerated(fields, prompt, requireString(data.requestId, "requestId"));
    }
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
    if (action === "task-sort-save") {
      if (data.sort !== "created_asc" && data.sort !== "created_desc") throw new AppError("INVALID_ARGUMENT", "任务排序方式无效。");
      store.database.transaction(() => store.database.connection.prepare("INSERT INTO metadata(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(`ui.taskSort:${this.viewScope()}`, String(data.sort)));
      return { taskSort: data.sort };
    }
    if (action === "quota-reserves-save") {
      const expected = requireString(data.revision, "revision");
      return new ConfigManager(this.configPath).set("quotaReserves", { fiveHour: requireNumber(data.fiveHour, "fiveHour", 0, 100), weekly: requireNumber(data.weekly, "weekly", 0, 100) }, expected);
    }
    if (action === "task-delete") { await store.tasks.remove(requireString(data.id, "id"), revision(data.revision)); return { archived: true }; }
    if (action === "enqueue") return scheduler.enqueue(requireString(data.id, "id"), data.revision === undefined ? undefined : revision(data.revision));
    if (action === "task-enable") {
      if (typeof data.enabled !== "boolean") throw new AppError("INVALID_ARGUMENT", "enabled 必须为布尔值。");
      const task = await store.tasks.get(requireString(data.id, "id"));
      if (!task) throw new AppError("TASK_NOT_FOUND", "任务不存在或已归档。");
      this.ensureOpen();
      return store.tasks.update({ ...task, enabled: data.enabled }, task.promptSnapshot, revision(data.revision));
    }
    if (action === "remove") return scheduler.remove(requireString(data.id, "id"), data.confirm === true);
    if (action === "continuation-stop") { new ContinuationRepository(store.database, this.clock).stop(requireString(data.id, "id")); return { stopped: true }; }
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
