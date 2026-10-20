import type { MonitorEvent, MonitorObservation, MonitorRepository, MonitorState, MonitorUpdate } from "../domain/monitor.js";
import { systemClock, type Clock } from "../domain/ports.js";
import { recognize, type MonitorOptions } from "../monitor/recognize.js";
import { AppError } from "../shared/errors.js";
import { isRecord } from "../shared/validation.js";
import type { Database } from "./database.js";
import { evaluateQuota } from "../domain/quota-policy.js";

function corrupt(): never { throw new AppError("STORAGE_INVALID", "额度监控数据格式异常，请保留原文件并检查备份。"); }
const date = (value: unknown) => typeof value === "string" && Number.isFinite(Date.parse(value));
const nullableText = (value: unknown) => value === null || typeof value === "string";

export function readMonitorState(json: string): MonitorState {
  try {
    const state: unknown = JSON.parse(json);
    if (!isRecord(state) || !Number.isSafeInteger(state.revision) || Number(state.revision) < 1 || !date(state.observedAt) || !date(state.nextPollAt)
      || !Number.isSafeInteger(state.failures) || Number(state.failures) < 0 || state.identity !== null && typeof state.identity !== "string"
      || state.errorCode !== null && typeof state.errorCode !== "string" || !Array.isArray(state.windows)
      || !isRecord(state.availability) || !["available", "blocked", "unknown"].includes(String(state.availability.status))
      || !["quota_available", "quota_exhausted", "reserve_reached", "unknown_quota", "stale_quota", "read_failed", "identity_unknown", "missing_window"].includes(String(state.availability.reason))) corrupt();
    const reason = state.availability.reason;
    if (state.availability.status === "available" ? reason !== "quota_available"
      : state.availability.status === "blocked" ? reason !== "quota_exhausted" && reason !== "reserve_reached"
      : ["quota_available", "quota_exhausted", "reserve_reached"].includes(String(reason))) corrupt();
    for (const window of state.windows) if (!isRecord(window) || typeof window.bucketId !== "string"
      || !["primary", "secondary"].includes(String(window.slot)) || typeof window.durationMinutes !== "number" || !Number.isFinite(window.durationMinutes)
      || window.durationMinutes <= 0 || window.resetsAt !== null && !date(window.resetsAt)) corrupt();
    if (state.snapshot !== null) {
      const snapshot = state.snapshot;
      if (!isRecord(snapshot) || !["codex", "mock"].includes(String(snapshot.source)) || !date(snapshot.fetchedAt) || !Array.isArray(snapshot.buckets)) corrupt();
      if (snapshot.account !== undefined && (!isRecord(snapshot.account) || snapshot.account.type !== "chatgpt"
        || ![snapshot.account.email, snapshot.account.planType, snapshot.account.workspaceId].every(nullableText))) corrupt();
      if (snapshot.cli !== undefined && (!isRecord(snapshot.cli) || typeof snapshot.cli.version !== "string")) corrupt();
      for (const bucket of snapshot.buckets) {
        if (!isRecord(bucket) || typeof bucket.id !== "string" || !Array.isArray(bucket.windows)
          || ![bucket.name, bucket.planType, bucket.reachedType].every(nullableText)) corrupt();
        for (const window of bucket.windows) if (!isRecord(window) || !["primary", "secondary"].includes(String(window.slot))
          || ["durationMinutes", "usedPercent", "remainingPercent"].some((key) => window[key] !== null && (typeof window[key] !== "number" || !Number.isFinite(window[key])))
          || window.resetsAt !== null && !date(window.resetsAt)) corrupt();
      }
    }
    return state as unknown as MonitorState;
  } catch { return corrupt(); }
}

export function readMonitorEvent(row: Record<string, unknown>): MonitorEvent {
  try {
    const data: unknown = JSON.parse(String(row.data_json));
    if (!isRecord(data) || !Object.values(data).every((value) => value === null || typeof value === "string" || typeof value === "number" && Number.isFinite(value))
      || !date(row.created_at) || !nullableText(row.event_key) || !Number.isSafeInteger(row.sequence) || Number(row.sequence) < 1
      || !["baseline", "identity_changed", "clock_changed", "quota_reset", "availability_changed", "read_error", "read_recovered"].includes(String(row.type))) corrupt();
    return { sequence: Number(row.sequence), key: row.event_key === null ? null : String(row.event_key), createdAt: String(row.created_at), type: row.type as MonitorEvent["type"], data: data as MonitorEvent["data"] };
  } catch { return corrupt(); }
}

export class SqliteMonitorRepository implements MonitorRepository {
  constructor(private readonly database: Database, private readonly streamKey: string, private readonly options: MonitorOptions, private readonly clock: Clock = systemClock) {}

  private read(): MonitorState | null {
    const row = this.database.connection.prepare("SELECT data_json FROM quota_monitor_state WHERE stream_key=?").get(this.streamKey);
    return row ? readMonitorState(String(row.data_json)) : null;
  }

  status(): MonitorState | null {
    const state = this.read();
    if (state?.snapshot) {
      const age = this.clock.now().getTime() - Date.parse(state.snapshot.fetchedAt);
      if (age < 0 || age > this.options.quotaMaxAgeMs) state.availability = { status: "unknown", reason: "stale_quota" };
      else if (!state.errorCode) {
        const current = evaluateQuota(state.snapshot, this.options, this.clock.now());
        if (current.status !== "available") state.availability = current;
      }
    }
    return state;
  }

  record(observation: MonitorObservation): MonitorUpdate {
    return this.database.transaction(() => {
      const transition = recognize(this.read(), observation, this.options, this.clock.now());
      const events: MonitorEvent[] = [];
      for (const event of transition.events) {
        if (event.key !== null) {
          const dedupe = this.database.connection.prepare("INSERT OR IGNORE INTO quota_monitor_reset_keys VALUES (?,?)").run(this.streamKey, event.key);
          if (dedupe.changes === 0) continue;
        }
        const result = this.database.connection.prepare("INSERT OR IGNORE INTO quota_monitor_events(stream_key, event_key, created_at, type, data_json) VALUES (?,?,?,?,?)")
          .run(this.streamKey, event.key, event.createdAt, event.type, JSON.stringify(event.data));
        if (result.changes > 0) events.push({ ...event, sequence: Number(result.lastInsertRowid) });
      }
      this.database.connection.prepare("INSERT INTO quota_monitor_state VALUES (?,?) ON CONFLICT(stream_key) DO UPDATE SET data_json=excluded.data_json")
        .run(this.streamKey, JSON.stringify(transition.state));
      this.database.connection.prepare("DELETE FROM quota_monitor_events WHERE stream_key=? AND sequence NOT IN (SELECT sequence FROM quota_monitor_events WHERE stream_key=? ORDER BY sequence DESC LIMIT 1000)")
        .run(this.streamKey, this.streamKey);
      return { state: transition.state, events };
    });
  }

  events(): MonitorEvent[] {
    return this.database.connection.prepare("SELECT * FROM quota_monitor_events WHERE stream_key=? ORDER BY sequence").all(this.streamKey).map(readMonitorEvent);
  }
}
