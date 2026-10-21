import { randomUUID } from "node:crypto";
import type { Clock, RunRepository } from "../domain/ports.js";
import type { RunUpdate, TaskRun, TaskStatus } from "../domain/task.js";
import { AppError } from "../shared/errors.js";
import type { Database } from "./database.js";
import { definitionOf, promptHash, readStoredTask } from "./task-repository.js";

const transitions: Record<TaskStatus, readonly TaskStatus[]> = {
  queued: ["queued", "waiting_quota", "running", "cancelled", "needs_attention"],
  waiting_quota: ["waiting_quota", "running", "cancelled", "needs_attention"],
  running: ["running", "succeeded", "failed", "cancelled", "needs_attention", "waiting_quota"],
  needs_attention: ["needs_attention", "cancelled"],
  succeeded: [], failed: [], cancelled: [],
};

export function readRun(value: unknown): TaskRun {
  try {
    const run = JSON.parse(String(value)) as TaskRun;
    if (!run || typeof run.id !== "string" || typeof run.promptSnapshot !== "string"
      || promptHash(run.promptSnapshot) !== run.promptHash || !Object.hasOwn(transitions, run.status)
      || run.taskSnapshot.id !== run.taskId || !Number.isInteger(run.taskRevision) || run.taskRevision < 1
      || typeof run.output !== "string" || !(run.error === null || typeof run.error === "string")
      || !(run.threadId === null || typeof run.threadId === "string")
      || !(run.turnId === undefined || run.turnId === null || typeof run.turnId === "string")
      || !Number.isFinite(Date.parse(run.createdAt))
      || ![run.startedAt, run.completedAt].every((time) => time === null || typeof time === "string" && Number.isFinite(Date.parse(time)))) throw new Error("Invalid run");
    definitionOf(run.taskSnapshot);
    return run;
  } catch { throw new AppError("STORAGE_INVALID", "运行记录格式或指令校验和异常，请检查备份。"); }
}

export class SqliteRunRepository implements RunRepository {
  constructor(private readonly db: Database, private readonly clock: Clock) {}

  async create(taskId: string): Promise<TaskRun> {
    return this.db.transaction(() => this.insert(taskId));
  }

  /** Used by the execution repository inside its atomic create-and-claim transaction. */
  insert(taskId: string): TaskRun {
    const row = this.db.connection.prepare("SELECT * FROM tasks WHERE id=? AND deleted_at IS NULL").get(taskId);
    if (!row) throw new AppError("TASK_NOT_FOUND", "任务不存在或已归档。");
    const task = readStoredTask(row);
    const run: TaskRun = {
      id: randomUUID(), taskId, taskRevision: task.revision, taskSnapshot: definitionOf(task),
      promptSnapshot: task.promptSnapshot, promptHash: task.promptHash,
      status: "queued", createdAt: this.clock.now().toISOString(), startedAt: null, completedAt: null,
      threadId: null, output: "", error: null,
    };
    this.db.connection.prepare("INSERT INTO runs VALUES (?, ?, ?)").run(run.id, taskId, JSON.stringify(run));
    return run;
  }

  async get(id: string): Promise<TaskRun | null> {
    const row = this.db.connection.prepare("SELECT data_json FROM runs WHERE id=?").get(id);
    return row ? readRun(row.data_json) : null;
  }

  async listByTask(taskId: string): Promise<TaskRun[]> {
    return this.db.connection.prepare("SELECT data_json FROM runs WHERE task_id=? ORDER BY rowid").all(taskId)
      .map((row) => readRun(row.data_json));
  }

  async recent(limit = 50, offset = 0): Promise<TaskRun[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(offset) || offset < 0) {
      throw new AppError("INVALID_ARGUMENT", "运行分页参数无效。");
    }
    return this.db.connection.prepare("SELECT data_json FROM runs ORDER BY rowid DESC LIMIT ? OFFSET ?")
      .all(limit, offset).map((row) => readRun(row.data_json));
  }

  async update(id: string, update: RunUpdate, expectedStatus: TaskStatus): Promise<TaskRun> {
    return this.db.transaction(() => {
      const row = this.db.connection.prepare("SELECT data_json FROM runs WHERE id=?").get(id);
      if (!row) throw new AppError("RUN_NOT_FOUND", "运行记录不存在。");
      const run = readRun(row.data_json);
      if (run.status !== expectedStatus) throw new AppError("RUN_CONFLICT", "运行状态已变化，请重新读取后重试。");
      if (!transitions[run.status].includes(update.status)) throw new AppError("RUN_TRANSITION", "不允许此运行状态转换。");
      // Copy only mutable fields; task and prompt snapshots are immutable.
      const next: TaskRun = { ...run, status: update.status };
      for (const key of ["startedAt", "completedAt", "threadId", "turnId", "output", "error"] as const) {
        if (update[key] !== undefined) Object.assign(next, { [key]: update[key] });
      }
      if (next.status === "running" && next.startedAt === null) next.startedAt = this.clock.now().toISOString();
      if (["succeeded", "failed", "cancelled"].includes(next.status) && next.completedAt === null) next.completedAt = this.clock.now().toISOString();
      try { readRun(JSON.stringify(next)); }
      catch { throw new AppError("RUN_INVALID", "运行状态更新包含无效数据。"); }
      this.db.connection.prepare("UPDATE runs SET data_json=? WHERE id=?").run(JSON.stringify(next), id);
      return next;
    });
  }
}
