import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import type { Clock, TaskRepository } from "../domain/ports.js";
import type { StoredTask, TaskDefinition, TaskRevision } from "../domain/task.js";
import { AppError } from "../shared/errors.js";
import { parseTask } from "../tasks/load.js";
import type { Database } from "./database.js";

export const promptHash = (prompt: string): string => createHash("sha256").update(prompt, "utf8").digest("hex");

export function definitionOf(task: TaskDefinition): TaskDefinition {
  return parseTask(task, ".");
}

export function readStoredTask(row: Record<string, unknown>): StoredTask {
  try {
    const definition = definitionOf(JSON.parse(String(row.definition_json)) as TaskDefinition);
    if (typeof row.prompt_snapshot !== "string" || promptHash(row.prompt_snapshot) !== row.prompt_hash
      || !Number.isInteger(row.revision) || Number(row.revision) < 1
      || definition.id !== (row.id ?? row.task_id) || !isAbsolute(definition.promptFile) || !isAbsolute(definition.projectDir)
      || !Number.isFinite(Date.parse(String(row.created_at))) || !Number.isFinite(Date.parse(String(row.updated_at)))) throw new Error("Invalid task row");
    return { ...definition, revision: Number(row.revision), promptSnapshot: row.prompt_snapshot,
      promptHash: String(row.prompt_hash), createdAt: String(row.created_at), updatedAt: String(row.updated_at) };
  } catch { throw new AppError("STORAGE_INVALID", "任务记录格式或指令校验和异常，请检查备份。"); }
}

export class SqliteTaskRepository implements TaskRepository {
  constructor(private readonly db: Database, private readonly clock: Clock) {}

  async list(): Promise<StoredTask[]> {
    return this.db.connection.prepare("SELECT * FROM tasks WHERE deleted_at IS NULL ORDER BY id").all().map(readStoredTask);
  }

  async get(id: string): Promise<StoredTask | null> {
    const row = this.db.connection.prepare("SELECT * FROM tasks WHERE id=? AND deleted_at IS NULL").get(id);
    return row ? readStoredTask(row) : null;
  }

  async create(task: TaskDefinition, prompt: string): Promise<StoredTask> {
    return this.db.transaction(() => this.insert(task, prompt));
  }

  /** Called only inside the store's transaction for atomic batch import. */
  insert(task: TaskDefinition, prompt: string): StoredTask {
    const definition = definitionOf(task);
    if (this.db.connection.prepare("SELECT id FROM tasks WHERE id=?").get(definition.id)) {
      throw new AppError("DUPLICATE_TASK", `任务 ID 已存在或已归档：${definition.id}`);
    }
    const now = this.clock.now().toISOString();
    const hash = promptHash(prompt);
    const json = JSON.stringify(definition);
    this.db.connection.prepare("INSERT INTO tasks VALUES (?, ?, ?, ?, 1, ?, ?, NULL)")
      .run(definition.id, json, prompt, hash, now, now);
    this.addVersion(definition.id, 1, json, prompt, hash, now);
    return { ...definition, revision: 1, promptSnapshot: prompt, promptHash: hash, createdAt: now, updatedAt: now };
  }

  async update(task: TaskDefinition, prompt: string, expectedRevision: number): Promise<StoredTask> {
    return this.db.transaction(() => {
      const definition = definitionOf(task);
      const now = this.clock.now().toISOString();
      const hash = promptHash(prompt);
      const json = JSON.stringify(definition);
      const result = this.db.connection.prepare(`UPDATE tasks SET definition_json=?, prompt_snapshot=?, prompt_hash=?,
        revision=revision+1, updated_at=? WHERE id=? AND revision=? AND deleted_at IS NULL`)
        .run(json, prompt, hash, now, definition.id, expectedRevision);
      if (Number(result.changes) !== 1) throw new AppError("TASK_CONFLICT", "任务不存在或版本已变化，请重新查询 revision 后重试。");
      this.addVersion(definition.id, expectedRevision + 1, json, prompt, hash, now);
      return readStoredTask(this.db.connection.prepare("SELECT * FROM tasks WHERE id=?").get(definition.id)!);
    });
  }

  async remove(id: string, expectedRevision: number): Promise<void> {
    this.db.transaction(() => {
      const changes = this.db.connection.prepare("UPDATE tasks SET deleted_at=? WHERE id=? AND revision=? AND deleted_at IS NULL")
        .run(this.clock.now().toISOString(), id, expectedRevision).changes;
      if (Number(changes) !== 1) throw new AppError("TASK_CONFLICT", "任务不存在或版本已变化，请重新查询后重试。");
    });
  }

  async revisions(id: string): Promise<TaskRevision[]> {
    return this.db.connection.prepare("SELECT *, created_at AS updated_at FROM task_versions WHERE task_id=? ORDER BY revision").all(id)
      .map((row) => {
        const task = readStoredTask(row);
        return { taskId: id, revision: task.revision, definition: definitionOf(task),
          promptSnapshot: task.promptSnapshot, promptHash: task.promptHash, createdAt: task.createdAt };
      });
  }

  private addVersion(id: string, revision: number, json: string, prompt: string, hash: string, time: string): void {
    this.db.connection.prepare("INSERT INTO task_versions VALUES (?, ?, ?, ?, ?, ?)").run(id, revision, json, prompt, hash, time);
  }
}
