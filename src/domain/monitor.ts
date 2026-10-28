import type { QuotaSnapshot, QuotaWindow } from "./quota.js";
import type { QuotaAvailability } from "./quota-policy.js";

export interface TrackedWindow {
  bucketId: string;
  slot: QuotaWindow["slot"];
  durationMinutes: number;
  resetsAt: string | null;
}

export interface MonitorState {
  revision: number;
  observedAt: string;
  identity: string | null;
  snapshot: QuotaSnapshot | null;
  windows: TrackedWindow[];
  availability: QuotaAvailability;
  failures: number;
  errorCode: string | null;
  nextPollAt: string;
}

export interface MonitorEvent {
  sequence: number;
  key: string | null;
  createdAt: string;
  type: "baseline" | "identity_changed" | "clock_changed" | "quota_reset" | "availability_changed" | "read_error" | "read_recovered";
  data: Record<string, string | number | null>;
}

export interface MonitorUpdate { state: MonitorState; events: MonitorEvent[]; discontinuityAt?: string }
export type MonitorObservation = { snapshot: QuotaSnapshot } | { errorCode: string };
export interface MonitorRepository {
  record(observation: MonitorObservation): MonitorUpdate;
  status(): MonitorState | null;
  events(): MonitorEvent[];
}
