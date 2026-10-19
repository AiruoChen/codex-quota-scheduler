import { systemClock, type Clock } from "../domain/ports.js";
import type { TaskDefinition } from "../domain/task.js";
import { Database } from "./database.js";
import { SqliteRunRepository } from "./run-repository.js";
import { readStoredTask, SqliteTaskRepository } from "./task-repository.js";

export interface TaskImport { task: TaskDefinition; prompt: string }

export class SqliteStore {
  readonly database: Database;
  readonly tasks: SqliteTaskRepository;
  readonly runs: SqliteRunRepository;

  constructor(path: string, clock: Clock = systemClock) {
    this.database = new Database(path);
    this.tasks = new SqliteTaskRepository(this.database, clock);
    this.runs = new SqliteRunRepository(this.database, clock);
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
    return { ok: true, tasks: tasks.length, runs: runs.length, versions };
  }

  close(): void { this.database.close(); }
}
