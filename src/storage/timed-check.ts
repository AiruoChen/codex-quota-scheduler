import type { Database } from "./database.js";
import { getTimedPlan, invalidTimedStorage, readTimedOccurrence, readTimedPlan } from "./timed-records.js";
import { readRun } from "./run-repository.js";

export function checkTimedStorage(db: Database): void {
  for (const row of db.connection.prepare("SELECT * FROM timed_plans").all()) if (readTimedPlan(row.data_json).id !== row.id) invalidTimedStorage();
  for (const row of db.connection.prepare("SELECT * FROM timed_occurrences").all()) {
    const o = readTimedOccurrence(row.data_json), p = getTimedPlan(db, o.planId);
    if (o.id !== row.id || o.planId !== row.plan_id || o.date !== row.target_date || o.planRevision > p.revision) invalidTimedStorage();
    if (o.runId) {
      const link = db.connection.prepare("SELECT * FROM timed_queue WHERE run_id=?").get(o.runId);
      const r = db.connection.prepare("SELECT data_json FROM runs WHERE id=?").get(o.runId);
      if (!link || !r || link.occurrence_id !== o.id) invalidTimedStorage();
      const run = readRun(r.data_json);
      if (run.timed?.occurrenceId !== o.id || run.timed.planId !== o.planId || run.timed.continuation || link.task_id !== run.taskId || link.task_revision !== run.taskRevision) invalidTimedStorage();
    }
  }
  const order = db.connection.prepare("SELECT last_sequence FROM queue_order WHERE singleton=1").get();
  if (!order || !Number.isSafeInteger(order.last_sequence) || Number(order.last_sequence) < 0) invalidTimedStorage();
  for (const row of db.connection.prepare("SELECT run_id FROM timed_queue").all()) {
    const o = db.connection.prepare("SELECT data_json FROM timed_occurrences WHERE id=(SELECT occurrence_id FROM timed_queue WHERE run_id=?)").get(row.run_id!);
    if (!o || readTimedOccurrence(o.data_json).runId !== row.run_id) invalidTimedStorage();
  }
  for (const row of db.connection.prepare("SELECT data_json FROM runs WHERE json_type(data_json,'$.timed') IS NOT NULL").all()) {
    const run = readRun(row.data_json);
    const oRow = db.connection.prepare("SELECT data_json FROM timed_occurrences WHERE id=?").get(run.timed!.occurrenceId);
    const o = oRow ? readTimedOccurrence(oRow.data_json) : null;
    if (!o || run.timed!.planId !== o.planId || run.timed!.dueAt !== o.dueAt || run.timed!.deadlineAt !== o.deadlineAt
      || run.timed!.continuation !== !!run.continuation || !run.continuation && o.runId !== run.id) invalidTimedStorage();
  }
  const reservations = db.connection.prepare("SELECT data_json FROM timed_occurrences WHERE json_extract(data_json,'$.sequence') IS NOT NULL").all().map(r => readTimedOccurrence(r.data_json));
  if (new Set(reservations.map(o => o.sequence)).size !== reservations.length || reservations.some(o => o.sequence! > Number(order.last_sequence))) invalidTimedStorage();
}
