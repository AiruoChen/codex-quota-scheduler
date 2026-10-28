import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { DataInspection } from "../domain/data-transfer.js";
import { AppError } from "../shared/errors.js";
import { localProcesses } from "../shared/process.js";
import { dispatchQueueView, removableDispatchQueueView, migrations } from "./database.js";

const names = new Set(["queue_removals", "metadata", "tasks", "runs", "task_versions", "execution_lock", "execution_events", "quota_monitor_state",
  "quota_monitor_events", "quota_monitor_reset_keys", "scheduler_control", "scheduler_queue", "scheduler_worker", "scheduler_streams",
  "scheduler_attention_ack", "execution_origins", "recovery_events", "task_create_requests", "continuation_chains", "continuation_plans", "queue_positions", "continuation_queue"]);

function openSource(path: string): DatabaseSync {
  try {
    const db = new DatabaseSync(path, { readOnly: true });
    db.exec("PRAGMA busy_timeout=1000; PRAGMA trusted_schema=OFF;");
    return db;
  } catch { throw new AppError("MIGRATION_DATABASE", "无法只读打开源数据库；不会创建空库。"); }
}

function inspect(db: DatabaseSync): DataInspection {
  const schema = Number(db.prepare("PRAGMA user_version").get()!.user_version);
  const app = Number(db.prepare("PRAGMA application_id").get()!.application_id);
  if (schema > migrations.length) throw new AppError("STORAGE_VERSION", "源数据库版本较新，请使用匹配的客户端。");
  const tables = db.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
  const objects = db.prepare("SELECT type,name,sql FROM sqlite_master WHERE type IN ('trigger','view') ORDER BY name").all();
  const normalize = (sql: string) => sql.replace(/\s+/g, " ").trim();
  if (schema < 1 || (app !== 0 && app !== 0x43515343) || !["metadata", "tasks", "runs"].every((name) => tables.some((row) => row.name === name))
    || tables.some((row) => !names.has(String(row.name))) || objects.some(row => row.type !== "view" || row.name !== "dispatch_queue" || normalize(String(row.sql)) !== normalize(schema >= 10 ? removableDispatchQueueView : dispatchQueueView))) {
    throw new AppError("STORAGE_FOREIGN", "源文件不是可识别的项目数据库，或含有不支持的对象。");
  }
  const checks = db.prepare("PRAGMA quick_check").all();
  if (checks.length !== 1 || Object.values(checks[0]!)[0] !== "ok" || db.prepare("PRAGMA foreign_key_check").all().length) {
    throw new AppError("STORAGE_INVALID", "源数据库完整性检查失败，原文件保持不变。");
  }
  const hash = createHash("sha256").update(String(schema));
  hash.update(JSON.stringify(objects));
  for (const row of tables) {
    // Table names come exclusively from the fixed schema whitelist above.
    hash.update(JSON.stringify(row));
    for (const data of db.prepare(`SELECT * FROM ${row.name} ORDER BY rowid`).all()) hash.update(JSON.stringify(data));
  }
  if (schema >= 3) hash.update(JSON.stringify(db.prepare("SELECT name,seq FROM sqlite_sequence ORDER BY name").all()));
  const count = (table: string) => Number(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n);
  return { schema, tasks: count("tasks"), runs: count("runs"), versions: schema >= 2 ? count("task_versions") : count("tasks"),
    seeded: !!db.prepare("SELECT value FROM metadata WHERE key='tasks_seeded'").get(),
    attention: Number(db.prepare("SELECT count(*) AS n FROM runs WHERE json_extract(data_json,'$.status') IN ('running','needs_attention')").get()!.n),
    fingerprint: hash.digest("hex") };
}

function owners(db: DatabaseSync, schema: number): number[] {
  return [schema >= 3 ? db.prepare("SELECT owner_pid FROM execution_lock").all() : [],
    schema >= 5 ? db.prepare("SELECT owner_pid FROM scheduler_worker").all() : []].flat().map((row) => Number(row.owner_pid));
}
function inactive(pids: number[]) {
  if (pids.some((pid) => localProcesses.inspect(pid) !== "dead")) throw new AppError("MIGRATION_SOURCE_ACTIVE", "源数据库仍有活动或无法确认退出的执行/调度进程；请先安全停止。");
}

export function inspectProfileDatabase(path: string, allowActive = false): DataInspection {
  const db = openSource(path);
  try {
    db.exec("BEGIN");
    const result = inspect(db), pids = owners(db, result.schema);
    db.exec("ROLLBACK"); if (!allowActive) inactive(pids); return result;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError("STORAGE_INVALID", "无法核对源数据库，原文件保持不变。");
  } finally { db.close(); }
}

/** Both connections are read-only. A reserved write lock excludes writers while VACUUM INTO snapshots committed WAL data. */
export function snapshotProfileDatabase(path: string, target: string, expected: string): DataInspection {
  const lease = openSource(path), source = openSource(path);
  let locked = false;
  try {
    lease.exec("BEGIN IMMEDIATE"); locked = true;
    const result = inspect(lease), pids = owners(lease, result.schema);
    if (result.fingerprint !== expected) throw new AppError("MIGRATION_CHANGED", "预览后源数据库已变化，请重新预检。");
    // Only synchronous SQLite operations occur while holding the transaction.
    source.prepare("VACUUM INTO ?").run(target);
    lease.exec("ROLLBACK"); locked = false;
    inactive(pids); return result;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError("MIGRATION_SNAPSHOT", "一致性备份失败，请检查锁、磁盘空间与目录权限；不会覆盖源库。");
  } finally { if (locked) lease.exec("ROLLBACK"); source.close(); lease.close(); }
}
