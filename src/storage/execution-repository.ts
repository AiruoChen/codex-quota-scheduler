import type { Clock } from "../domain/ports.js";
import type { ExecutionEvent, TaskRun } from "../domain/task.js";
import { AppError } from "../shared/errors.js";
import type { Database } from "./database.js";
import { readRun, SqliteRunRepository } from "./run-repository.js";
import type { ExecutionOrigin } from "../domain/recovery.js";
import { assertRecoveryClear, pauseForRecovery, recoveryEvent, readOrigin } from "./recovery-repository.js";

export class ExecutionRepository {
  constructor(private readonly db: Database, private readonly clock: Clock) {}

  claim(id: string): TaskRun {
    return this.db.transaction(() => this.claimInside(id));
  }

  claimNew(taskId: string): TaskRun {
    return this.db.transaction(() => this.claimInside(new SqliteRunRepository(this.db, this.clock).insert(taskId).id));
  }

  /** Only call inside a synchronous database transaction. */
  claimInside(id: string): TaskRun {
    assertRecoveryClear(this.db, this.clock, "execution");
    const run = this.get(id);
    if (!["queued", "waiting_quota"].includes(run.status)) throw new AppError("RUN_ALREADY_STARTED", "此记录已启动或已结束，不能重复提交。");
    const task = this.db.connection.prepare("SELECT definition_json FROM tasks WHERE id=? AND deleted_at IS NULL").get(run.taskId);
    if (!task || (JSON.parse(String(task.definition_json)) as { enabled: boolean }).enabled !== true) throw new AppError("TASK_DISABLED", "任务不存在、已归档或已停用。");
    if (this.db.connection.prepare("SELECT run_id FROM execution_lock").get()) throw new AppError("EXECUTION_BUSY", "当前数据库已有活动执行；请先结束它或核对遗留记录。");
    this.db.connection.prepare("INSERT INTO execution_lock(singleton,run_id,owner_pid) VALUES(1,?,?)").run(id, process.pid);
    const next = { ...run, status: "running" as const, startedAt: this.clock.now().toISOString(), error: null };
    this.write(next);
    return next;
  }

  cancel(id: string): { run: TaskRun; cancelRequested: boolean } {
    return this.db.transaction(() => {
      const run = this.get(id);
      if (run.status === "queued" || run.status === "waiting_quota") {
        const next = { ...run, status: "cancelled" as const, completedAt: this.clock.now().toISOString() };
        this.write(next);
        return { run: next, cancelRequested: false };
      }
      if (run.status !== "running") return { run, cancelRequested: false };
      const changed = this.db.connection.prepare("UPDATE execution_lock SET cancel_requested=1 WHERE run_id=?").run(id).changes;
      if (Number(changed) !== 1) throw new AppError("RUN_OWNER_UNKNOWN", "运行记录没有活动执行权，请先人工核对状态。");
      return { run, cancelRequested: true };
    });
  }

  cancelled(id: string): boolean {
    return this.db.connection.prepare("SELECT cancel_requested FROM execution_lock WHERE run_id=?").get(id)?.cancel_requested === 1;
  }

  origin(id: string, origin: ExecutionOrigin): void {
    this.db.transaction(() => {
      readOrigin(JSON.stringify(origin));
      if (this.get(id).status !== "running" || this.db.connection.prepare("SELECT owner_pid FROM execution_lock WHERE run_id=?").get(id)?.owner_pid !== process.pid) {
        throw new AppError("RUN_CONFLICT", "保存执行来源时执行权已变化。");
      }
      if (this.db.connection.prepare("SELECT sequence FROM execution_events WHERE run_id=? AND type='submission_started'").get(id)) throw new AppError("RUN_ALREADY_STARTED", "提交后不能改写执行来源。");
      this.db.connection.prepare("INSERT INTO execution_origins VALUES (?,?) ON CONFLICT(run_id) DO UPDATE SET data_json=excluded.data_json").run(id, JSON.stringify(origin));
    });
  }

  takeClaim(id: string): TaskRun {
    return this.db.transaction(() => {
      const lock = this.db.connection.prepare("SELECT owner_pid,dispatch_started FROM execution_lock WHERE run_id=?").get(id);
      if (!lock || lock.owner_pid !== process.pid || lock.dispatch_started !== 0) throw new AppError("RUN_ALREADY_STARTED", "此执行权不属于当前进程或已经用于执行。");
      const run = this.get(id);
      if (run.status !== "running") throw new AppError("RUN_CONFLICT", "执行权对应记录不在 running 状态。");
      if (run.turnId || this.db.connection.prepare("SELECT sequence FROM execution_events WHERE run_id=? AND type='submission_started'").get(id)) throw new AppError("RUN_ALREADY_STARTED", "此记录已有提交证据，请先核对会话，不能重新发送。");
      this.db.connection.prepare("UPDATE execution_lock SET dispatch_started=1 WHERE run_id=?").run(id);
      return run;
    });
  }

  release(id: string): void { this.db.connection.prepare("DELETE FROM execution_lock WHERE run_id=? AND owner_pid=?").run(id, process.pid); }

  progress(id: string, patch: { threadId?: string; turnId?: string; output?: string }): void {
    const run = this.get(id);
    if (run.status !== "running") throw new AppError("RUN_CONFLICT", "运行状态已变化，不能继续保存执行进度。");
    this.write({ ...run, ...patch });
  }

  recover(id: string): TaskRun {
    return this.db.transaction(() => {
      const lock = this.db.connection.prepare("SELECT owner_pid FROM execution_lock WHERE run_id=?").get(id);
      if (!lock) throw new AppError("RUN_OWNER_UNKNOWN", "没有需要恢复的执行权记录。");
      let alive = true;
      try { process.kill(Number(lock.owner_pid), 0); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") alive = false; }
      if (alive) throw new AppError("EXECUTION_BUSY", "执行进程仍存在，不能释放它的执行权。");
      const run = this.get(id);
      const next = run.status === "running"
        ? { ...run, status: "needs_attention" as const, error: "EXECUTION_OWNER_EXITED: 请核对已有会话及文件变更；不会自动重发。" } : run;
      this.write(next);
      this.db.connection.prepare("DELETE FROM execution_lock WHERE run_id=?").run(id);
      pauseForRecovery(this.db, this.clock);
      recoveryEvent(this.db, this.clock, id, "execution_released", { ownerPid: Number(lock.owner_pid), status: next.status });
      return next;
    });
  }

  event(runId: string, type: string, data: Record<string, unknown>): void {
    this.db.connection.prepare("INSERT INTO execution_events(run_id,created_at,type,data_json) VALUES(?,?,?,?)")
      .run(runId, this.clock.now().toISOString(), type, JSON.stringify(data));
  }

  events(runId: string): ExecutionEvent[] {
    return this.db.connection.prepare("SELECT * FROM execution_events WHERE run_id=? ORDER BY sequence").all(runId).map((row) => ({
      sequence: Number(row.sequence), runId: String(row.run_id), createdAt: String(row.created_at), type: String(row.type),
      data: JSON.parse(String(row.data_json)) as Record<string, unknown>,
    }));
  }

  private get(id: string): TaskRun {
    const row = this.db.connection.prepare("SELECT data_json FROM runs WHERE id=?").get(id);
    if (!row) throw new AppError("RUN_NOT_FOUND", "运行记录不存在。");
    return readRun(row.data_json);
  }
  private write(run: TaskRun): void { this.db.connection.prepare("UPDATE runs SET data_json=? WHERE id=?").run(JSON.stringify(run), run.id); }
}
