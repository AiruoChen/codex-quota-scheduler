import { createHash } from "node:crypto";
import type { Clock } from "../domain/ports.js";
import type { ExecutionOrigin, ProcessInspector, RecoveryEvent, RecoveryIssue, RecoveryReport, RecoveryRepository, RecoveryTarget, RemoteRecoveryResult } from "../domain/recovery.js";
import type { TaskRun } from "../domain/task.js";
import { AppError } from "../shared/errors.js";
import { localProcesses } from "../shared/process.js";
import { redact } from "../shared/redact.js";
import { isRecord } from "../shared/validation.js";
import type { Database } from "./database.js";
import { readRun } from "./run-repository.js";

function invalid(): never { throw new AppError("STORAGE_INVALID", "异常恢复数据格式无效，请保留原文件并检查备份。"); }
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const date = (value: unknown) => typeof value === "string" && Number.isFinite(Date.parse(value));

export function readOrigin(value: unknown): ExecutionOrigin {
  try {
    const origin: unknown = JSON.parse(String(value));
    if (!isRecord(origin) || typeof origin.connectionKey !== "string" || !/^[a-f0-9]{64}$/.test(origin.connectionKey)
      || typeof origin.cliVersion !== "string" || !isRecord(origin.account) || origin.account.type !== "chatgpt"
      || ![origin.account.email, origin.account.planType, origin.account.workspaceId].every((item) => item === null || typeof item === "string")) invalid();
    return origin as unknown as ExecutionOrigin;
  } catch { return invalid(); }
}

export function pauseForRecovery(db: Database, clock: Clock): void {
  db.connection.prepare("INSERT INTO scheduler_control VALUES (1,1,'restart_recovery',?) ON CONFLICT(singleton) DO UPDATE SET paused=1,reason='restart_recovery',updated_at=excluded.updated_at")
    .run(clock.now().toISOString());
}
export function recoveryEvent(db: Database, clock: Clock, runId: string | null, type: string, data: RecoveryEvent["data"]): void {
  db.connection.prepare("INSERT INTO recovery_events(run_id,created_at,type,data_json) VALUES (?,?,?,?)").run(runId, clock.now().toISOString(), type, JSON.stringify(data));
}

/** Read local state only. An absent lease is not proof that the remote turn never started. */
export function scanRecovery(db: Database, clock: Clock, processes: ProcessInspector = localProcesses): RecoveryReport {
  const issues: RecoveryIssue[] = [];
  const owners: RecoveryReport["owners"] = [];
  const worker = db.connection.prepare("SELECT owner_pid FROM scheduler_worker").get();
  if (worker) {
    const pid = Number(worker.owner_pid); const state = processes.inspect(pid);
    owners.push({ kind: "scheduler", pid, state, runId: null });
    if (state !== "alive") issues.push({ code: `scheduler_owner_${state}`, runId: null, ownerPid: pid });
  }
  const lock = db.connection.prepare("SELECT run_id,owner_pid FROM execution_lock").get();
  if (lock) {
    const pid = Number(lock.owner_pid); const state = processes.inspect(pid); const runId = String(lock.run_id);
    owners.push({ kind: "execution", pid, state, runId });
    if (state !== "alive") issues.push({ code: `execution_owner_${state}`, runId, ownerPid: pid });
  }
  for (const row of db.connection.prepare("SELECT id,data_json FROM runs").all()) {
    const run = readRun(row.data_json);
    if (run.id !== row.id) invalid();
    if (run.status === "running" && lock?.run_id !== run.id) issues.push({ code: "orphan_running", runId: run.id, ownerPid: null });
    if (["queued", "waiting_quota"].includes(run.status) && (run.turnId || db.connection.prepare("SELECT sequence FROM execution_events WHERE run_id=? AND type='submission_started'").get(run.id))) {
      issues.push({ code: "submitted_pending", runId: run.id, ownerPid: lock?.run_id === run.id ? Number(lock.owner_pid) : null });
    }
    if (run.status === "needs_attention" && !db.connection.prepare("SELECT run_id FROM scheduler_attention_ack WHERE run_id=?").get(run.id)) {
      issues.push({ code: "needs_attention", runId: run.id, ownerPid: null });
    }
  }
  return { checkedAt: clock.now().toISOString(), issues, owners };
}

export function assertRecoveryClear(db: Database, clock: Clock, scope: "scheduler" | "execution"): void {
  const issues = scanRecovery(db, clock).issues.filter((issue) => scope === "scheduler" || !["needs_attention", "scheduler_owner_dead", "scheduler_owner_unknown"].includes(issue.code));
  if (issues.length) throw new AppError("RECOVERY_REQUIRED", "发现遗留或结果不明记录，请先 recovery status，再 repair / reconcile；不会自动释放任务执行权或重发。");
}

export class SqliteRecoveryRepository implements RecoveryRepository {
  constructor(private readonly db: Database, private readonly clock: Clock, private readonly processes: ProcessInspector = localProcesses) {}
  report(): RecoveryReport { return scanRecovery(this.db, this.clock, this.processes); }

  repair(): { report: RecoveryReport; actions: RecoveryIssue[] } {
    return this.db.transaction(() => {
      const before = this.report(); const actions: RecoveryIssue[] = [];
      if (before.issues.length) pauseForRecovery(this.db, this.clock);
      const scheduler = before.owners.find((owner) => owner.kind === "scheduler");
      if (scheduler?.state === "dead") {
        this.db.connection.prepare("DELETE FROM scheduler_worker WHERE owner_pid=?").run(scheduler.pid);
        actions.push({ code: "scheduler_released", runId: null, ownerPid: scheduler.pid });
        recoveryEvent(this.db, this.clock, null, "scheduler_released", { ownerPid: scheduler.pid });
      }
      const execution = before.owners.find((owner) => owner.kind === "execution");
      if (execution?.state === "dead" && execution.runId) {
        const run = this.target(execution.runId).run;
        if (run.status === "running") this.markAttention(run, "EXECUTION_OWNER_EXITED");
        this.db.connection.prepare("DELETE FROM execution_lock WHERE run_id=? AND owner_pid=?").run(run.id, execution.pid);
        actions.push({ code: "execution_released", runId: run.id, ownerPid: execution.pid });
        recoveryEvent(this.db, this.clock, run.id, "execution_released", { ownerPid: execution.pid, previousStatus: run.status, status: run.status === "running" ? "needs_attention" : run.status });
      }
      for (const issue of before.issues) if ((issue.code === "orphan_running" || issue.code === "submitted_pending") && issue.runId) {
        if (this.db.connection.prepare("SELECT run_id FROM execution_lock WHERE run_id=?").get(issue.runId)) continue;
        const run = this.target(issue.runId).run;
        if (run.status !== "needs_attention") { this.markAttention(run, issue.code.toUpperCase()); actions.push(issue); }
      }
      return { report: this.report(), actions };
    });
  }

  target(id: string): RecoveryTarget {
    const row = this.db.connection.prepare("SELECT data_json FROM runs WHERE id=?").get(id);
    if (!row) throw new AppError("RUN_NOT_FOUND", "运行记录不存在。");
    const run = readRun(row.data_json);
    if (run.id !== id) invalid();
    const context = this.db.connection.prepare("SELECT data_json FROM execution_origins WHERE run_id=?").get(id);
    const origin = context ? readOrigin(context.data_json) : null;
    return { run, origin, fingerprint: hash([run, origin]) };
  }

  beginReconcile(id: string): RecoveryTarget {
    return this.db.transaction(() => {
      const target = this.target(id);
      if (target.run.status !== "needs_attention") throw new AppError("RECOVERY_NOT_ATTENTION", "仅待核对记录可应用恢复结果；running 请先检查并 repair。");
      if (this.db.connection.prepare("SELECT run_id FROM execution_lock WHERE run_id=?").get(id)) throw new AppError("EXECUTION_BUSY", "此记录仍持有执行权，不能应用远端核对结果。");
      pauseForRecovery(this.db, this.clock);
      this.db.connection.prepare("DELETE FROM scheduler_attention_ack WHERE run_id=?").run(id);
      return target;
    });
  }

  apply(target: RecoveryTarget, result: RemoteRecoveryResult): TaskRun {
    return this.db.transaction(() => {
      const current = this.target(target.run.id);
      if (current.fingerprint !== target.fingerprint) throw new AppError("RECOVERY_CONFLICT", "核对期间本地记录发生变化，请重新读取，不覆盖已有结果。");
      const run = current.run;
      if (run.status !== "needs_attention") throw new AppError("RECOVERY_NOT_ATTENTION", "仅待核对记录可应用恢复结果；running 请先检查并 repair。");
      if (this.db.connection.prepare("SELECT run_id FROM execution_lock WHERE run_id=?").get(run.id)) throw new AppError("EXECUTION_BUSY", "此记录仍持有执行权，不能应用远端核对结果。");
      pauseForRecovery(this.db, this.clock);
      this.db.connection.prepare("DELETE FROM scheduler_attention_ack WHERE run_id=?").run(run.id);
      recoveryEvent(this.db, this.clock, run.id, "reconcile", { kind: result.kind, code: result.code });
      if (result.kind !== "terminal") return run;
      const timeout = this.db.connection.prepare("SELECT data_json FROM execution_events WHERE run_id=? AND type='interrupt_requested'").all(run.id)
        .some((row) => { try { return JSON.parse(String(row.data_json)).reason === "timeout"; } catch { return invalid(); } });
      const status = result.turnStatus === "completed" ? "succeeded" : result.turnStatus === "failed" || timeout ? "failed" : "cancelled";
      const next: TaskRun = { ...run, status, output: redact(result.output || run.output), completedAt: result.completedAt ?? this.clock.now().toISOString(),
        error: status === "succeeded" ? null : result.turnStatus === "failed" ? "CODEX_TURN_FAILED: 远端历史确认回合失败。"
          : timeout ? "EXECUTION_TIMEOUT: 远端历史确认超时回合已中断。" : null };
      readRun(JSON.stringify(next));
      this.db.connection.prepare("UPDATE runs SET data_json=? WHERE id=?").run(JSON.stringify(next), run.id);
      this.db.connection.prepare("INSERT INTO execution_events(run_id,created_at,type,data_json) VALUES (?,?,?,?)")
        .run(run.id, this.clock.now().toISOString(), "recovery_confirmed", JSON.stringify({ status, turnId: run.turnId, outputSource: result.output ? "history" : "existing_partial" }));
      return next;
    });
  }

  events(id?: string): RecoveryEvent[] {
    return this.db.connection.prepare("SELECT * FROM recovery_events WHERE (? IS NULL OR run_id=?) ORDER BY sequence DESC LIMIT 1000").all(id ?? null, id ?? null).reverse().map(readRecoveryEvent);
  }
  private markAttention(run: TaskRun, code: string): void {
    this.db.connection.prepare("UPDATE runs SET data_json=? WHERE id=?").run(JSON.stringify({ ...run, status: "needs_attention", error: `${code}: 请核对会话及文件变更；不会自动重发。` }), run.id);
    this.db.connection.prepare("DELETE FROM scheduler_attention_ack WHERE run_id=?").run(run.id);
    recoveryEvent(this.db, this.clock, run.id, "needs_attention", { code, previousStatus: run.status });
  }
}

function readRecoveryEvent(row: Record<string, unknown>): RecoveryEvent {
  try {
    const data: unknown = JSON.parse(String(row.data_json));
    if (!Number.isSafeInteger(row.sequence) || !date(row.created_at) || typeof row.type !== "string" || !isRecord(data)
      || !Object.values(data).every((value) => value === null || typeof value === "string" || typeof value === "number" && Number.isFinite(value))) invalid();
    return { sequence: Number(row.sequence), runId: row.run_id === null ? null : String(row.run_id), createdAt: String(row.created_at), type: row.type, data: data as RecoveryEvent["data"] };
  } catch { return invalid(); }
}
export function checkRecoveryStorage(db: Database): void {
  for (const row of db.connection.prepare("SELECT id,data_json FROM runs").all()) if (readRun(row.data_json).id !== row.id) invalid();
  for (const row of db.connection.prepare("SELECT data_json FROM execution_origins").all()) readOrigin(row.data_json);
  for (const row of db.connection.prepare("SELECT * FROM recovery_events").all()) readRecoveryEvent(row);
}
