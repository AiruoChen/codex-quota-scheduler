import { createHash, randomUUID } from "node:crypto";
import type { Clock } from "../domain/ports.js";
import { continuationSuffix, isQuotaInterruption, type QuotaInterruption } from "../domain/continuation.js";
import type { TaskRun } from "../domain/task.js";
import type { Database } from "./database.js";
import { readRun } from "./run-repository.js";
import { promptHash } from "./task-repository.js";
import { ExecutionRepository } from "./execution-repository.js";
import { AppError } from "../shared/errors.js";
import { insertQueuePosition } from "./queue-position.js";

export function readInterruption(value: unknown): QuotaInterruption {
  try {
    const item: unknown = JSON.parse(String(value));
    if (!isQuotaInterruption(item)) throw new Error("Invalid evidence");
    return item;
  } catch { throw new AppError("STORAGE_INVALID", "额度中断证据格式无效，请保留原数据核对。"); }
}

export class ContinuationRepository {
  constructor(private readonly db: Database, private readonly clock: Clock) {}

  /** Caller owns the transaction which also saves the terminal result. Unique parent IDs deduplicate plans. */
  planInside(parent: TaskRun, evidence: QuotaInterruption): TaskRun | null {
    readInterruption(JSON.stringify(evidence));
    const existing = this.db.connection.prepare("SELECT child_run_id FROM continuation_plans WHERE parent_run_id=?").get(parent.id);
    if (existing) return this.get(String(existing.child_run_id));
    const root = this.get(parent.continuation?.rootRunId ?? parent.id), policy = root.taskSnapshot.quotaContinuation;
    const attempt = (parent.continuation?.attempt ?? 0) + 1;
    if (parent.status !== "failed" || !policy?.enabled || attempt > policy.maxAttempts || parent.threadId !== evidence.threadId || parent.turnId !== evidence.turnId) return null;
    const originRow = this.db.connection.prepare("SELECT data_json FROM execution_origins WHERE run_id=?").get(parent.id);
    if (!originRow) return null;
    const origin = JSON.parse(String(originRow.data_json)) as { connectionKey: string; account: unknown };
    if (origin.connectionKey !== evidence.connectionKey || createHash("sha256").update(JSON.stringify([origin.connectionKey, origin.account])).digest("hex") !== evidence.accountScope) return null;
    // Pin the model actually selected for the original run; no silent switch to a later default.
    const selected = this.db.connection.prepare("SELECT data_json FROM execution_events WHERE run_id=? AND type='thread_ready' ORDER BY sequence DESC LIMIT 1").get(parent.id);
    const model: unknown = selected ? (JSON.parse(String(selected.data_json)) as Record<string, unknown>).model : null;
    if (typeof model !== "string" || !model.trim()) return null;
    this.db.connection.prepare("INSERT OR IGNORE INTO continuation_chains(root_run_id) VALUES (?)").run(root.id);
    if (this.db.connection.prepare("SELECT stopped FROM continuation_chains WHERE root_run_id=?").get(root.id)?.stopped !== 0) return null;
    const prompt = root.promptSnapshot + continuationSuffix;
    const child: TaskRun = { id: randomUUID(), taskId: parent.taskId, taskRevision: root.taskRevision,
      taskSnapshot: { ...root.taskSnapshot, model, session: { mode: "resume", threadId: evidence.threadId } },
      promptSnapshot: prompt, promptHash: promptHash(prompt), status: "waiting_quota", createdAt: this.clock.now().toISOString(),
      startedAt: null, completedAt: null, threadId: null, turnId: null, output: "", error: "QUOTA_WAIT: awaiting_confirmed_reset",
      ...(root.timed ? { timed: { ...root.timed, continuation: true } } : {}),
      continuation: { rootRunId: root.id, parentRunId: parent.id, parentTurnId: evidence.turnId, attempt, connectionKey: evidence.connectionKey, accountScope: evidence.accountScope, evidence } };
    readRun(JSON.stringify(child));
    this.db.connection.prepare("INSERT INTO runs VALUES (?,?,?)").run(child.id, child.taskId, JSON.stringify(child));
    this.db.connection.prepare("INSERT INTO continuation_plans VALUES (?,?,?,?)").run(parent.id, root.id, child.id, JSON.stringify(evidence));
    this.db.connection.prepare("INSERT INTO continuation_queue VALUES (?,?,?,?)").run(child.id, parent.id, child.taskId, child.taskRevision);
    insertQueuePosition(this.db, child.id);
    new ExecutionRepository(this.db, this.clock).event(parent.id, "quota_continuation_planned", { childRunId: child.id, rootRunId: root.id, attempt });
    return child;
  }

  stop(id: string): void {
    this.db.transaction(() => this.stopInside(id));
  }
  /** Caller owns the transaction, also used when cancelling a timed plan's future work. */
  stopInside(id: string): void {
    const run = this.get(id), rootId = run.continuation?.rootRunId ?? run.id;
    this.db.connection.prepare("INSERT INTO continuation_chains VALUES (?,1) ON CONFLICT(root_run_id) DO UPDATE SET stopped=1").run(rootId);
    for (const row of this.db.connection.prepare("SELECT child_run_id FROM continuation_plans WHERE root_run_id=?").all(rootId)) {
      const child = this.get(String(row.child_run_id));
      if (["queued", "waiting_quota"].includes(child.status)) this.db.connection.prepare("UPDATE runs SET data_json=? WHERE id=?")
        .run(JSON.stringify({ ...child, status: "cancelled", completedAt: this.clock.now().toISOString() }), child.id);
    }
    new ExecutionRepository(this.db, this.clock).event(id, "quota_continuation_stopped", {});
  }

  private get(id: string): TaskRun {
    const row = this.db.connection.prepare("SELECT data_json FROM runs WHERE id=?").get(id);
    if (!row) throw new AppError("RUN_NOT_FOUND", "运行记录不存在。");
    return readRun(row.data_json);
  }
}
