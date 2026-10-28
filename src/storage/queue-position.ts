import type { Database } from "./database.js";

/** Caller holds a synchronous transaction. Reservations also order due timed instances before a run exists. */
export function reserveQueuePosition(db: Database): number {
  const row = db.connection.prepare(`UPDATE queue_order SET last_sequence=max(last_sequence,
    (SELECT coalesce(max(sequence),0) FROM queue_positions))+1 WHERE singleton=1 RETURNING last_sequence`).get()!;
  return Number(row.last_sequence);
}
export function insertQueuePosition(db: Database, runId: string, sequence = reserveQueuePosition(db)): void {
  db.connection.prepare("INSERT INTO queue_positions(sequence,run_id) VALUES (?,?)").run(sequence, runId);
}
