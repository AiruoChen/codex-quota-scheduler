import { randomUUID } from "node:crypto";
import type { Clock } from "../domain/ports.js";
import type { MonitorUpdate } from "../domain/monitor.js";
import type { DispatchDecision, SchedulerRepository, SchedulerStatus, SchedulerTrigger } from "../domain/scheduler.js";
import type { TaskRun } from "../domain/task.js";
import type { QuotaSnapshot } from "../domain/quota.js";
import { evaluateQuota, hasQuotaIdentity } from "../domain/quota-policy.js";
import { digest, type MonitorOptions } from "../monitor/recognize.js";
import { AppError } from "../shared/errors.js";
import type { Database } from "./database.js";
import { ExecutionRepository } from "./execution-repository.js";
import { readMonitorEvent, readMonitorState } from "./monitor-repository.js";
import { readRun, SqliteRunRepository } from "./run-repository.js";
import { readStoredTask } from "./task-repository.js";
import { assertRecoveryClear, recoveryEvent } from "./recovery-repository.js";
import { continuationReady } from "../domain/continuation.js";
import { readInterruption } from "./continuation-repository.js";

export class SqliteSchedulerRepository implements SchedulerRepository {
  private readonly context: string;
  private readonly execution: ExecutionRepository;
  constructor(private readonly db: Database, private readonly streamKey: string, private readonly trigger: SchedulerTrigger,
    private readonly policy: MonitorOptions, private readonly clock: Clock) {
    this.context = digest([streamKey, trigger]);
    this.execution = new ExecutionRepository(db, clock);
    this.db.transaction(() => { this.db.connection.prepare("INSERT OR IGNORE INTO scheduler_control VALUES (1,1,'not_enabled',?)").run(clock.now().toISOString()); });
  }

  enqueue(taskId: string, expectedRevision?: number): TaskRun {
    return this.db.transaction(() => {
      const row = this.db.connection.prepare("SELECT * FROM tasks WHERE id=? AND deleted_at IS NULL").get(taskId);
      if (!row) throw new AppError("TASK_NOT_FOUND", "任务不存在或已归档。");
      const task = readStoredTask(row);
      if (expectedRevision !== undefined && task.revision !== expectedRevision) throw new AppError("TASK_CONFLICT", "预览后任务版本已变化，请重新预览再入队。");
      const existing = this.db.connection.prepare("SELECT run_id FROM scheduler_queue WHERE task_id=? AND task_revision=?").get(taskId, task.revision);
      if (existing) return this.run(String(existing.run_id));
      if (!task.enabled) throw new AppError("TASK_DISABLED", "停用任务不能加入自动队列。");
      const run = new SqliteRunRepository(this.db, this.clock).insert(taskId);
      this.db.connection.prepare("INSERT INTO scheduler_queue(run_id,task_id,task_revision) VALUES (?,?,?)").run(run.id, taskId, task.revision);
      this.db.connection.prepare("INSERT INTO queue_positions(run_id) VALUES (?)").run(run.id);
      this.execution.event(run.id, "scheduler_enqueued", { revision: task.revision });
      return run;
    });
  }

  remove(id: string, confirmAttention = false): TaskRun {
    return this.db.transaction(() => {
      if (!this.db.connection.prepare("SELECT run_id FROM dispatch_queue WHERE run_id=?").get(id)) throw new AppError("QUEUE_NOT_FOUND", "运行记录不属于自动队列。");
      const run = this.run(id);
      if (run.status === "running" || this.db.connection.prepare("SELECT run_id FROM execution_lock WHERE run_id=?").get(id)) throw new AppError("EXECUTION_BUSY", "运行仍活动或持有执行权；请先请求取消并等待终态，或显式核对遗留执行权。");
      const pending = ["queued", "waiting_quota"].includes(run.status);
      if (pending && (run.turnId || this.db.connection.prepare("SELECT sequence FROM execution_events WHERE run_id=? AND type='submission_started'").get(id))) throw new AppError("RECOVERY_REQUIRED", "记录已有提交证据，需先核对结果，不能按未执行任务删除。");
      if (run.status === "needs_attention") {
        if (confirmAttention !== true) throw new AppError("CONFIRM_REQUIRED", "请确认已人工核对；移除仅解除本地队列阻塞，未知结果与历史保留，不会取消或重发远端任务。");
        this.db.connection.prepare("INSERT OR IGNORE INTO scheduler_attention_ack VALUES (?,?)").run(id, this.clock.now().toISOString());
        this.pause("attention_removed");
        recoveryEvent(this.db, this.clock, id, "queue_attention_removed", { previousStatus: run.status });
      }
      const next = pending ? { ...run, status: "cancelled" as const, completedAt: this.clock.now().toISOString() } : run;
      this.db.connection.prepare("UPDATE runs SET data_json=? WHERE id=?").run(JSON.stringify(next), id);
      // The tombstone hides membership while preserving positions, version deduplication and history.
      this.db.connection.prepare("INSERT INTO queue_removals VALUES (?,?,?)").run(id, this.clock.now().toISOString(), run.status);
      this.execution.event(id, "scheduler_removed", { previousStatus: run.status, attentionAcknowledged: run.status === "needs_attention" });
      return next;
    });
  }

  private attention(): string[] {
    return this.db.connection.prepare("SELECT r.data_json FROM runs r LEFT JOIN scheduler_attention_ack a ON a.run_id=r.id WHERE a.run_id IS NULL")
      .all().map((row) => readRun(row.data_json)).filter((run) => run.status === "needs_attention").map((run) => run.id);
  }

  status(): SchedulerStatus {
    const control = this.db.connection.prepare("SELECT * FROM scheduler_control WHERE singleton=1").get()!;
    const worker = this.db.connection.prepare("SELECT * FROM scheduler_worker WHERE singleton=1").get();
    return { paused: control.paused === 1, reason: control.reason === null ? null : String(control.reason),
      worker: worker ? { pid: Number(worker.owner_pid), startedAt: String(worker.started_at), trigger: worker.trigger_mode as SchedulerTrigger } : null,
      attention: this.attention(), queue: this.db.connection.prepare(`SELECT r.data_json,q.sequence,t.definition_json,t.deleted_at
        FROM dispatch_queue q JOIN runs r ON r.id=q.run_id LEFT JOIN tasks t ON t.id=q.task_id ORDER BY q.sequence`).all().map((row) => {
        const run = readRun(row.data_json);
        return { runId: run.id, taskId: run.taskId, revision: run.taskRevision, status: run.status, priority: run.taskSnapshot.priority,
          name: run.taskSnapshot.name, projectDir: run.taskSnapshot.projectDir, createdAt: run.createdAt, sequence: Number(row.sequence), ...(run.continuation ? { continuation: run.continuation } : {}),
          enabled: row.definition_json && row.deleted_at === null ? (JSON.parse(String(row.definition_json)) as { enabled: boolean }).enabled : null };
      }) };
  }

  pause(reason = "user_paused"): void {
    this.db.connection.prepare("UPDATE scheduler_control SET paused=1,reason=?,updated_at=? WHERE singleton=1").run(reason, this.clock.now().toISOString());
  }

  resume(): void {
    this.db.transaction(() => {
      if (this.attention().length > 0) throw new AppError("SCHEDULER_NEEDS_ATTENTION", "存在未核对的执行记录，请检查会话并使用 scheduler acknowledge 后再恢复。");
      this.db.connection.prepare("UPDATE scheduler_control SET paused=0,reason=NULL,updated_at=? WHERE singleton=1").run(this.clock.now().toISOString());
    });
  }

  acknowledge(id: string): void {
    this.db.transaction(() => {
      if (this.run(id).status !== "needs_attention") throw new AppError("RUN_NOT_ATTENTION", "此记录不是待核对状态。");
      if (this.db.connection.prepare("SELECT run_id FROM execution_lock WHERE run_id=?").get(id)) throw new AppError("EXECUTION_BUSY", "此记录仍持有执行权；请先核对并处理遗留执行权。");
      this.db.connection.prepare("INSERT OR IGNORE INTO scheduler_attention_ack VALUES (?,?)").run(id, this.clock.now().toISOString());
    });
  }

  acquire(): string {
    return this.db.transaction(() => {
      assertRecoveryClear(this.db, this.clock, "scheduler");
      if (this.db.connection.prepare("SELECT token FROM scheduler_worker").get()) throw new AppError("SCHEDULER_BUSY", "数据库已有调度进程；若它已退出，请先 scheduler recover。");
      const token = randomUUID();
      this.db.connection.prepare("INSERT INTO scheduler_worker VALUES (1,?,?,?,?,?)").run(token, process.pid, this.clock.now().toISOString(), this.streamKey, this.trigger);
      // A first start ignores historical reset events. Subsequent starts retain their cursor and grant.
      const last = Number(this.db.connection.prepare("SELECT COALESCE(MAX(sequence),0) AS n FROM quota_monitor_events WHERE stream_key=?").get(this.streamKey)!.n);
      this.db.connection.prepare("INSERT OR IGNORE INTO scheduler_streams VALUES (?,?,NULL,NULL,NULL)").run(this.context, last);
      return token;
    });
  }

  recover(): void {
    this.db.transaction(() => {
      const worker = this.db.connection.prepare("SELECT owner_pid FROM scheduler_worker").get();
      if (!worker) throw new AppError("SCHEDULER_NO_WORKER", "没有遗留调度进程记录。");
      let dead = false;
      try { process.kill(Number(worker.owner_pid), 0); }
      catch (error) { dead = (error as NodeJS.ErrnoException).code === "ESRCH"; }
      if (!dead) throw new AppError("SCHEDULER_BUSY", "调度进程仍存在或无法确认退出，不能释放执行权。");
      this.db.connection.prepare("DELETE FROM scheduler_worker").run();
      this.pause("worker_recovered");
      recoveryEvent(this.db, this.clock, null, "scheduler_released", { ownerPid: Number(worker.owner_pid) });
    });
  }

  release(token: string): void { this.db.connection.prepare("DELETE FROM scheduler_worker WHERE token=? AND owner_pid=?").run(token, process.pid); }

  claimNext(token: string, update: MonitorUpdate): DispatchDecision {
    return this.db.transaction(() => {
      this.assertWorker(token);
      const cached = this.db.connection.prepare("SELECT data_json FROM quota_monitor_state WHERE stream_key=?").get(this.streamKey);
      if (!cached) return { action: "wait", reason: "unknown_quota" };
      const state = readMonitorState(String(cached.data_json));
      if (state.revision !== update.state.revision) return { action: "wait", reason: "snapshot_changed" };
      const stream = this.db.connection.prepare("SELECT * FROM scheduler_streams WHERE context_key=?").get(this.context)!;
      let grant = stream.grant_key === null ? null : String(stream.grant_key);
      let assigned = stream.run_id === null ? null : String(stream.run_id);
      if (stream.identity !== state.identity) { grant = null; assigned = null; }
      const events = this.db.connection.prepare("SELECT * FROM quota_monitor_events WHERE stream_key=? AND sequence>? ORDER BY sequence").all(this.streamKey, Number(stream.cursor)).map(readMonitorEvent);
      let cursor = Number(stream.cursor);
      for (const event of events) {
        cursor = event.sequence;
        if (["baseline", "identity_changed", "clock_changed"].includes(event.type)) { grant = null; assigned = null; }
        const age = this.clock.now().getTime() - Date.parse(event.createdAt);
        if (event.type === "quota_reset" && event.data.bucketId === this.policy.limitId && event.key && age >= 0 && age <= this.policy.quotaMaxAgeMs) {
          grant = event.key; assigned = null;
        }
      }
      this.db.connection.prepare("UPDATE scheduler_streams SET cursor=?,identity=?,grant_key=?,run_id=? WHERE context_key=?")
        .run(cursor, state.identity, grant, assigned, this.context);
      if (this.status().paused) return { action: "wait", reason: "paused" };
      if (this.attention().length > 0) { this.pause("needs_attention"); return { action: "wait", reason: "needs_attention" }; }
      if (this.db.connection.prepare("SELECT run_id FROM execution_lock").get()) return { action: "wait", reason: "busy" };
      const snapshot = state.snapshot;
      if (!snapshot || snapshot.source !== "codex") return { action: "wait", reason: "requires_real_quota" };
      if (state.errorCode || state.availability.status !== "available") return { action: "wait", reason: state.availability.reason };
      const eligibility = evaluateQuota(snapshot, this.policy, this.clock.now());
      if (eligibility.status !== "available") return { action: "wait", reason: eligibility.reason };
      if (!state.identity || !hasQuotaIdentity(snapshot.account)) return { action: "wait", reason: "identity_unknown" };
      if (this.trigger === "refresh" && !grant) return { action: "wait", reason: "awaiting_refresh" };
      const candidates = this.queued().filter((run) => ["queued", "waiting_quota"].includes(run.status))
        .sort((a, b) => b.taskSnapshot.priority - a.taskSnapshot.priority);
      for (const run of candidates) {
        if (this.trigger === "refresh" && assigned !== null && assigned !== run.id) continue;
        const row = this.db.connection.prepare("SELECT * FROM tasks WHERE id=? AND deleted_at IS NULL").get(run.taskId);
        if (!row || !readStoredTask(row).enabled || !run.taskSnapshot.enabled) continue;
        if (run.continuation) {
          const plan = this.db.connection.prepare("SELECT evidence_json FROM continuation_plans WHERE child_run_id=?").get(run.id);
          if (!plan || this.db.connection.prepare("SELECT stopped FROM continuation_chains WHERE root_run_id=?").get(run.continuation.rootRunId)?.stopped !== 0) continue;
          const evidence = readInterruption(plan.evidence_json);
          const origin = this.db.connection.prepare("SELECT data_json FROM execution_origins WHERE run_id=?").get(run.continuation.parentRunId);
          const account = origin ? (JSON.parse(String(origin.data_json)) as { account: QuotaSnapshot["account"] }).account : null;
          if (!account || !(["type", "email", "planType", "workspaceId"] as const).every(key => account[key] === snapshot.account![key])) {
            this.pause("continuation_account_changed"); return { action: "wait", reason: "identity_unknown" };
          }
          if (!continuationReady(evidence, snapshot, this.policy, this.clock.now())) continue;
        }
        if (run.turnId || this.db.connection.prepare("SELECT sequence FROM execution_events WHERE run_id=? AND type='submission_started'").get(run.id)) {
          this.db.connection.prepare("UPDATE runs SET data_json=? WHERE id=?").run(JSON.stringify({ ...run, status: "needs_attention", error: "SUBMISSION_STATE_UNKNOWN: 请核对提交记录，不会自动重发。" }), run.id);
          this.pause("needs_attention"); return { action: "wait", reason: "needs_attention" };
        }
        const claimed = this.execution.claimInside(run.id, true);
        if (this.trigger === "refresh") this.db.connection.prepare("UPDATE scheduler_streams SET run_id=? WHERE context_key=?").run(run.id, this.context);
        this.execution.event(run.id, "scheduler_claimed", { trigger: this.trigger, grantKey: this.trigger === "refresh" ? grant : null });
        return { action: "run", run: claimed, expectedAccount: snapshot.account };
      }
      return { action: "wait", reason: this.trigger === "refresh" && assigned !== null ? "refresh_consumed" : "empty_queue" };
    });
  }

  complete(token: string, id: string): TaskRun {
    return this.db.transaction(() => {
      this.assertWorker(token);
      const run = this.run(id);
      const planned = run.status === "failed" && this.db.connection.prepare("SELECT child_run_id FROM continuation_plans WHERE parent_run_id=?").get(id);
      if (run.status !== "succeeded" && run.status !== "waiting_quota" && !planned) this.pause(`run_${run.status}`);
      return run;
    });
  }

  private assertWorker(token: string): void {
    const worker = this.db.connection.prepare("SELECT * FROM scheduler_worker WHERE token=? AND owner_pid=?").get(token, process.pid);
    if (!worker || worker.stream_key !== this.streamKey || worker.trigger_mode !== this.trigger) throw new AppError("SCHEDULER_OWNER_CHANGED", "调度执行权已变化，停止本次操作。");
  }
  private run(id: string): TaskRun {
    const row = this.db.connection.prepare("SELECT data_json FROM runs WHERE id=?").get(id);
    if (!row) throw new AppError("RUN_NOT_FOUND", "运行记录不存在。");
    return readRun(row.data_json);
  }
  private queued(): TaskRun[] {
    return this.db.connection.prepare("SELECT r.data_json FROM dispatch_queue q JOIN runs r ON r.id=q.run_id ORDER BY q.sequence").all().map((row) => readRun(row.data_json));
  }
}

export function checkSchedulerStorage(db: Database): void {
  const validDate = (value: unknown) => typeof value === "string" && Number.isFinite(Date.parse(value));
  const nullableText = (value: unknown) => value === null || typeof value === "string";
  const invalid = () => { throw new AppError("STORAGE_INVALID", "自动调度数据格式或关联异常，请检查备份。"); };
  for (const row of db.connection.prepare("SELECT * FROM scheduler_control").all()) {
    if (![0, 1].includes(Number(row.paused)) || !nullableText(row.reason) || !validDate(row.updated_at)) invalid();
  }
  for (const row of db.connection.prepare("SELECT * FROM scheduler_worker").all()) {
    if (!Number.isSafeInteger(row.owner_pid) || Number(row.owner_pid) <= 0 || typeof row.token !== "string" || !row.token
      || typeof row.stream_key !== "string" || !validDate(row.started_at) || !["available", "refresh"].includes(String(row.trigger_mode))) invalid();
  }
  for (const row of db.connection.prepare("SELECT q.*,r.data_json FROM dispatch_queue q JOIN runs r ON r.id=q.run_id").all()) {
    const run = readRun(row.data_json);
    if (row.task_id !== run.taskId || row.task_revision !== run.taskRevision) invalid();
  }
  const count = (table: string) => Number(db.connection.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n);
  const membershipCount = count("scheduler_queue") + count("continuation_queue");
  if (count("queue_positions") !== membershipCount || count("dispatch_queue") + count("queue_removals") !== membershipCount) invalid();
  for (const row of db.connection.prepare("SELECT * FROM queue_removals").all()) {
    if (!validDate(row.removed_at) || !["queued", "waiting_quota", "needs_attention", "succeeded", "failed", "cancelled"].includes(String(row.previous_status))
      || !db.connection.prepare("SELECT run_id FROM scheduler_queue WHERE run_id=? UNION ALL SELECT run_id FROM continuation_queue WHERE run_id=?").get(row.run_id!, row.run_id!)) invalid();
  }
  for (const row of db.connection.prepare("SELECT * FROM continuation_plans").all()) {
    const evidence = readInterruption(row.evidence_json), child = db.connection.prepare("SELECT data_json FROM runs WHERE id=?").get(row.child_run_id!);
    const run = child ? readRun(child.data_json) : null;
    if (!run?.continuation || run.continuation.parentRunId !== row.parent_run_id || run.continuation.rootRunId !== row.root_run_id
      || JSON.stringify(run.continuation.evidence) !== JSON.stringify(evidence)) invalid();
  }
  for (const row of db.connection.prepare("SELECT * FROM scheduler_streams").all()) {
    if (!Number.isSafeInteger(row.cursor) || Number(row.cursor) < 0 || !nullableText(row.identity) || !nullableText(row.grant_key)
      || !nullableText(row.run_id) || row.run_id !== null && row.grant_key === null) invalid();
  }
  for (const row of db.connection.prepare("SELECT * FROM scheduler_attention_ack").all()) if (!validDate(row.acknowledged_at)) invalid();
}
