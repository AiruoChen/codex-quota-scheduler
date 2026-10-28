import type { DesktopFeed, FeedCursor, NoticeEvent, NoticeKind } from "../domain/notifications.js";
import type { MonitorEvent } from "../domain/monitor.js";
import type { Database } from "./database.js";
import { readRun } from "./run-repository.js";
import { digest } from "../monitor/recognize.js";

const outcomes: Record<string, NoticeKind> = { succeeded: "task_succeeded", failed: "task_failed", cancelled: "task_cancelled", needs_attention: "needs_attention" };

/** Read inside the caller's synchronous transaction. Existing durable events remain authoritative. */
export function desktopEvents(db: Database, scope: string, requested: FeedCursor | null, quota: MonitorEvent[], resetAllowed: (event: MonitorEvent) => boolean) {
  const maximum: FeedCursor = {
    execution: Number(db.connection.prepare("SELECT coalesce(max(sequence),0) AS n FROM execution_events").get()!.n),
    recovery: Number(db.connection.prepare("SELECT coalesce(max(sequence),0) AS n FROM recovery_events").get()!.n),
    quota: quota.at(-1)?.sequence ?? 0,
  };
  const baseline = !requested || Object.entries(maximum).some(([key, value]) => requested[key as keyof FeedCursor] > value);
  const cursor = baseline ? { ...maximum } : { ...requested! }, events: NoticeEvent[] = [];
  if (baseline) {
    // execution_finished is saved before its run update. Do not skip an in-progress finalization at first connect.
    const pending = db.connection.prepare(`SELECT min(e.sequence) AS n FROM execution_events e JOIN runs r ON r.id=e.run_id
      WHERE e.type='execution_finished' AND json_extract(e.data_json,'$.status') IN ('succeeded','failed','cancelled','needs_attention')
        AND json_extract(r.data_json,'$.status')='running'`).get()!.n;
    if (pending !== null) cursor.execution = Math.min(cursor.execution, Number(pending) - 1);
  } else {
    for (const stream of ["execution", "recovery"] as const) {
      const table = stream === "execution" ? "execution_events" : "recovery_events";
      const rows = db.connection.prepare(`SELECT e.sequence,e.created_at,e.type,e.data_json AS event_json,r.data_json FROM ${table} e LEFT JOIN runs r ON r.id=e.run_id
        WHERE e.sequence>? ORDER BY e.sequence LIMIT 128`).all(cursor[stream]);
      for (const row of rows) {
        if (stream === "recovery" && ["timed_missed", "timed_attention", "timed_ready"].includes(String(row.type))) {
          events.push({ key: digest([scope, "timed", row.sequence]), kind: String(row.type) as NoticeKind, runId: null, target: "schedules", createdAt: String(row.created_at) });
        }
        if (row.data_json && ["execution_finished", "recovery_confirmed", "needs_attention", "execution_released"].includes(String(row.type))) {
          const run = readRun(row.data_json);
          const meta = JSON.parse(String(row.event_json)) as { status?: string };
          if (row.type === "execution_finished" && run.status === "running" && outcomes[meta.status ?? ""]) break;
          const kind = outcomes[run.status];
          const canonical = db.connection.prepare(`SELECT min(sequence) AS n FROM execution_events WHERE run_id=?
            AND type IN ('execution_finished','recovery_confirmed') AND json_extract(data_json,'$.status')=?`).get(run.id, run.status)!.n;
          const recoveryFirst = stream === "recovery" && run.status === "needs_attention" && canonical === null
            ? db.connection.prepare("SELECT min(sequence) AS n FROM recovery_events WHERE run_id=? AND (type='needs_attention' OR type='execution_released' AND json_extract(data_json,'$.status')='needs_attention')").get(run.id)!.n : null;
          // One canonical durable source per run/status; a later repair cannot re-notify an old outcome.
          const matches = stream === "execution" ? Number(row.sequence) === canonical && meta.status === run.status
            : Number(row.sequence) === recoveryFirst;
          if (kind && matches) events.push({ key: digest([scope, run.id, run.status]), kind, runId: run.id, target: "runs", createdAt: String(row.created_at) });
        }
        cursor[stream] = Number(row.sequence);
      }
    }
    for (const event of quota.filter((event) => event.sequence > cursor.quota).slice(0, 128)) {
      if (event.type === "quota_reset" && event.key && resetAllowed(event)) events.push({ key: digest([scope, event.key]), kind: "quota_reset", runId: null, target: "overview", createdAt: event.createdAt });
      cursor.quota = event.sequence;
    }
  }
  const pendingAttention = !!db.connection.prepare("SELECT id FROM runs WHERE json_extract(data_json,'$.status')='needs_attention' LIMIT 1").get();
  return { scope, cursor, baseline, pendingAttention, events } satisfies Omit<DesktopFeed, "monitor" | "provider">;
}
