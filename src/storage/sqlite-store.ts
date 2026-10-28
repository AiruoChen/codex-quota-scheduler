import { systemClock, type Clock } from "../domain/ports.js";
import type { TaskDefinition } from "../domain/task.js";
import { Database } from "./database.js";
import { SqliteRunRepository } from "./run-repository.js";
import { readStoredTask, SqliteTaskRepository } from "./task-repository.js";
import { ExecutionRepository } from "./execution-repository.js";
import { AppError } from "../shared/errors.js";
import { isRecord } from "../shared/validation.js";
import { readMonitorEvent, readMonitorState } from "./monitor-repository.js";
import { checkSchedulerStorage } from "./scheduler-repository.js";
import { checkRecoveryStorage } from "./recovery-repository.js";
import { checkTimedStorage } from "./timed-check.js";

export interface TaskImport { task: TaskDefinition; prompt: string }

export class SqliteStore {
  readonly database: Database;
  readonly tasks: SqliteTaskRepository;
  readonly runs: SqliteRunRepository;
  readonly execution: ExecutionRepository;

  constructor(path: string, clock: Clock = systemClock) {
    this.database = new Database(path);
    this.tasks = new SqliteTaskRepository(this.database, clock);
    this.runs = new SqliteRunRepository(this.database, clock);
    this.execution = new ExecutionRepository(this.database, clock);
  }

  isSeeded(): boolean {
    return !!this.database.connection.prepare("SELECT value FROM metadata WHERE key='tasks_seeded'").get();
  }

  import(items: readonly TaskImport[], seedOnly = false): void {
    this.database.transaction(() => {
      if (seedOnly && this.isSeeded()) return;
      for (const item of items) this.tasks.insert(item.task, item.prompt);
      this.database.connection.prepare("INSERT OR IGNORE INTO metadata VALUES ('tasks_seeded', 'true')").run();
    });
  }

  async check(): Promise<{ ok: true; tasks: number; runs: number; versions: number }> {
    this.database.check();
    const tasks = this.database.connection.prepare("SELECT * FROM tasks").all().map(readStoredTask);
    let versions = 0;
    for (const task of tasks) versions += (await this.tasks.revisions(task.id)).length;
    const runs = this.database.connection.prepare("SELECT id FROM runs").all();
    for (const row of runs) await this.runs.get(String(row.id));
    for (const row of this.database.connection.prepare("SELECT * FROM execution_events").all()) {
      try {
        if (!isRecord(JSON.parse(String(row.data_json))) || !Number.isFinite(Date.parse(String(row.created_at)))) throw new Error("Invalid event");
      } catch { throw new AppError("STORAGE_INVALID", "执行事件格式异常，请检查备份。"); }
    }
    for (const row of this.database.connection.prepare("SELECT data_json FROM quota_monitor_state").all()) readMonitorState(String(row.data_json));
    for (const row of this.database.connection.prepare("SELECT * FROM quota_monitor_events").all()) readMonitorEvent(row);
    checkSchedulerStorage(this.database);
    checkRecoveryStorage(this.database);
    checkTimedStorage(this.database);
    return { ok: true, tasks: tasks.length, runs: runs.length, versions };
  }

  close(): void { this.database.close(); }
}
