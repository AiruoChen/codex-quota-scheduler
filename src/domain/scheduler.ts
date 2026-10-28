import type { MonitorUpdate } from "./monitor.js";
import type { TaskRun } from "./task.js";
import type { QuotaSnapshot } from "./quota.js";

export type SchedulerTrigger = "available" | "refresh";
export interface SchedulerStatus {
  paused: boolean;
  reason: string | null;
  worker: { pid: number; startedAt: string; trigger: SchedulerTrigger } | null;
  attention: string[];
  queue: { runId: string; taskId: string; revision: number; status: TaskRun["status"]; priority: number;
    name: string; projectDir: string; createdAt: string; sequence: number; enabled: boolean | null;
    continuation?: import("./continuation.js").ContinuationLink }[];
}
export type DispatchDecision = { action: "wait"; reason: string }
  | { action: "run"; run: TaskRun; expectedAccount: NonNullable<QuotaSnapshot["account"]> };

export interface SchedulerRepository {
  enqueue(taskId: string, expectedRevision?: number): TaskRun;
  remove(runId: string, confirmAttention?: boolean): TaskRun;
  status(): SchedulerStatus;
  pause(reason?: string): void;
  resume(): void;
  acknowledge(runId: string): void;
  acquire(): string;
  recover(): void;
  release(token: string): void;
  claimNext(token: string, update: MonitorUpdate): DispatchDecision;
  complete(token: string, runId: string): TaskRun;
}
export interface SchedulerMonitor {
  run(signal: AbortSignal, onUpdate: (update: MonitorUpdate) => void | Promise<void>, samples?: number): Promise<void>;
}
export interface ClaimedExecution {
  executeClaimed(id: string, signal: AbortSignal, started?: (id: string) => void, expectedAccount?: QuotaSnapshot["account"]): Promise<TaskRun>;
}
export interface SchedulerEvent {
  event: "scheduler_wait" | "scheduler_started" | "scheduler_finished";
  reason?: string;
  runId?: string;
  status?: TaskRun["status"];
}
