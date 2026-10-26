import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { AppError } from "../shared/errors.js";
import { localProcesses } from "../shared/process.js";

export const migrations = [
  `CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
   CREATE TABLE tasks (
     id TEXT PRIMARY KEY, definition_json TEXT NOT NULL, prompt_snapshot TEXT NOT NULL,
     prompt_hash TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision > 0),
     created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT
   ) STRICT;
   CREATE TABLE runs (
     id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), data_json TEXT NOT NULL
   ) STRICT;`,
  `CREATE TABLE task_versions (
     task_id TEXT NOT NULL REFERENCES tasks(id), revision INTEGER NOT NULL,
     definition_json TEXT NOT NULL, prompt_snapshot TEXT NOT NULL, prompt_hash TEXT NOT NULL,
     created_at TEXT NOT NULL, PRIMARY KEY(task_id, revision)
   ) STRICT;
   INSERT INTO task_versions SELECT id, revision, definition_json, prompt_snapshot, prompt_hash, updated_at FROM tasks;
   CREATE INDEX runs_by_task ON runs(task_id);`,
  `CREATE TABLE execution_lock (
     singleton INTEGER PRIMARY KEY CHECK(singleton=1), run_id TEXT NOT NULL UNIQUE REFERENCES runs(id),
     owner_pid INTEGER NOT NULL, cancel_requested INTEGER NOT NULL DEFAULT 0
   ) STRICT;
   CREATE TABLE execution_events (
     sequence INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL REFERENCES runs(id),
     created_at TEXT NOT NULL, type TEXT NOT NULL, data_json TEXT NOT NULL
   ) STRICT;
   CREATE INDEX events_by_run ON execution_events(run_id, sequence);`,
  `CREATE TABLE quota_monitor_state (stream_key TEXT PRIMARY KEY, data_json TEXT NOT NULL) STRICT;
   CREATE TABLE quota_monitor_events (
     sequence INTEGER PRIMARY KEY AUTOINCREMENT, stream_key TEXT NOT NULL,
     event_key TEXT, created_at TEXT NOT NULL, type TEXT NOT NULL, data_json TEXT NOT NULL,
     UNIQUE(stream_key, event_key)
   ) STRICT;
   CREATE INDEX quota_events_by_stream ON quota_monitor_events(stream_key, sequence);
   CREATE TABLE quota_monitor_reset_keys (stream_key TEXT NOT NULL, event_key TEXT NOT NULL, PRIMARY KEY(stream_key, event_key)) STRICT;`,
  `ALTER TABLE execution_lock ADD COLUMN dispatch_started INTEGER NOT NULL DEFAULT 0 CHECK(dispatch_started IN (0,1));
   CREATE TABLE scheduler_control (singleton INTEGER PRIMARY KEY CHECK(singleton=1), paused INTEGER NOT NULL CHECK(paused IN (0,1)), reason TEXT, updated_at TEXT NOT NULL) STRICT;
   CREATE TABLE scheduler_queue (sequence INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL UNIQUE REFERENCES runs(id), task_id TEXT NOT NULL REFERENCES tasks(id), task_revision INTEGER NOT NULL, UNIQUE(task_id, task_revision)) STRICT;
   CREATE TABLE scheduler_worker (singleton INTEGER PRIMARY KEY CHECK(singleton=1), token TEXT NOT NULL UNIQUE, owner_pid INTEGER NOT NULL, started_at TEXT NOT NULL, stream_key TEXT NOT NULL, trigger_mode TEXT NOT NULL CHECK(trigger_mode IN ('available','refresh'))) STRICT;
   CREATE TABLE scheduler_streams (context_key TEXT PRIMARY KEY, cursor INTEGER NOT NULL, identity TEXT, grant_key TEXT, run_id TEXT REFERENCES runs(id)) STRICT;
   CREATE TABLE scheduler_attention_ack (run_id TEXT PRIMARY KEY REFERENCES runs(id), acknowledged_at TEXT NOT NULL) STRICT;`,
  `CREATE TABLE execution_origins (run_id TEXT PRIMARY KEY REFERENCES runs(id), data_json TEXT NOT NULL) STRICT;
   CREATE TABLE recovery_events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT REFERENCES runs(id), created_at TEXT NOT NULL, type TEXT NOT NULL, data_json TEXT NOT NULL) STRICT;
   CREATE INDEX recovery_events_by_run ON recovery_events(run_id, sequence);`,
  `INSERT OR IGNORE INTO metadata VALUES ('database_identity',lower(hex(randomblob(16))));`,
];

export class Database {
  readonly connection: DatabaseSync;
  private closed = false;

  constructor(readonly path: string) {
    if (path !== ":memory:") mkdirSync(dirname(resolve(path)), { recursive: true });
    try { this.connection = new DatabaseSync(path); }
    catch { throw new AppError("STORAGE_OPEN_FAILED", "无法打开任务数据库，请检查路径、权限或备份。"); }
    try {
      this.connection.exec("PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;");
      const version = Number(this.connection.prepare("PRAGMA user_version").get()?.user_version);
      const appId = Number(this.connection.prepare("PRAGMA application_id").get()?.application_id);
      const tables = this.connection.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
      const knownLegacy = ["metadata", "tasks", "runs"].every((name) => tables.some((table) => table.name === name));
      if ((appId !== 0 && appId !== 0x43515343) || (appId === 0 && tables.length > 0 && !(version > 0 && knownLegacy))) {
        throw new AppError("STORAGE_FOREIGN", "此文件是其他应用的数据库，请指定新的任务数据库路径。");
      }
      if (version > migrations.length) throw new AppError("STORAGE_VERSION", "数据库版本较新，请使用匹配的程序版本。");
      this.transaction(() => {
        // Re-read under the write lock so concurrent initializers cannot run a migration twice.
        const current = Number(this.connection.prepare("PRAGMA user_version").get()?.user_version);
        if (current > 0 && current < migrations.length) {
          const owners = [current >= 3 ? this.connection.prepare("SELECT owner_pid FROM execution_lock").all() : [],
            current >= 5 ? this.connection.prepare("SELECT owner_pid FROM scheduler_worker").all() : []].flat();
          if (owners.some((owner) => localProcesses.inspect(Number(owner.owner_pid)) !== "dead")) {
            throw new AppError("STORAGE_BUSY", "数据库模式升级前须安全停止活动进程；无法确认退出时保留原状态。");
          }
        }
        for (let index = current; index < migrations.length; index++) {
          this.connection.exec(migrations[index]!);
          this.connection.exec(`PRAGMA user_version=${index + 1}`);
        }
        this.connection.exec("PRAGMA application_id=1129403203");
      });
      this.connection.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
      this.check();
    } catch (error) {
      this.connection.close();
      this.closed = true;
      if (error instanceof AppError) throw error;
      throw new AppError("STORAGE_INVALID", "数据库无法读取或迁移，原文件已保留。请检查其他运行实例或切换到有效备份。");
    }
  }

  transaction<T>(action: () => T): T {
    try { this.connection.exec("BEGIN IMMEDIATE"); }
    catch { throw new AppError("STORAGE_BUSY", "无法取得数据库写锁，请检查其他运行实例后重试。"); }
    try {
      const value = action();
      this.connection.exec("COMMIT");
      return value;
    } catch (error) {
      try { this.connection.exec("ROLLBACK"); } catch { /* SQLite may already have rolled back an I/O failure. */ }
      throw error;
    }
  }

  check(): void {
    const rows = this.connection.prepare("PRAGMA quick_check").all();
    if (rows.length !== 1 || Object.values(rows[0]!)[0] !== "ok") {
      throw new AppError("STORAGE_INVALID", "数据库完整性检查失败，请保留原文件并切换到有效备份。");
    }
    if (this.connection.prepare("PRAGMA foreign_key_check").all().length > 0) {
      throw new AppError("STORAGE_INVALID", "数据库关联完整性检查失败，请检查备份。");
    }
  }

  backup(path: string): string {
    const target = resolve(path);
    mkdirSync(dirname(target), { recursive: true });
    try { this.connection.prepare("VACUUM INTO ?").run(target); }
    catch { throw new AppError("BACKUP_FAILED", "备份失败：目标必须是新文件，且目录可写。"); }
    return target;
  }

  close(): void {
    if (!this.closed) { this.connection.close(); this.closed = true; }
  }
}
