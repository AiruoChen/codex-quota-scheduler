import type { QuotaSnapshot } from "./quota.js";
import type { TaskRun } from "./task.js";

export type ProcessState = "alive" | "dead" | "unknown";
export interface ProcessInspector { inspect(pid: number): ProcessState }
export interface ExecutionOrigin {
  connectionKey: string;
  account: NonNullable<QuotaSnapshot["account"]>;
  cliVersion: string;
}
export interface RecoveryIssue { code: string; runId: string | null; ownerPid: number | null }
export interface RecoveryReport {
  checkedAt: string;
  issues: RecoveryIssue[];
  owners: { kind: "scheduler" | "execution"; pid: number; state: ProcessState; runId: string | null }[];
}
export interface RecoveryTarget { run: TaskRun; origin: ExecutionOrigin | null; fingerprint: string }
export type RemoteRecoveryResult =
  | { kind: "terminal"; code: "TURN_CONFIRMED"; turnStatus: "completed" | "failed" | "interrupted"; output: string; completedAt: string | null }
  | { kind: "pending" | "unknown"; code: string };
export interface RecoveryEvent { sequence: number; runId: string | null; createdAt: string; type: string; data: Record<string, string | number | null> }
export interface RecoveryRepository {
  report(): RecoveryReport;
  repair(): { report: RecoveryReport; actions: RecoveryIssue[] };
  target(id: string): RecoveryTarget;
  beginReconcile(id: string): RecoveryTarget;
  apply(target: RecoveryTarget, result: RemoteRecoveryResult): TaskRun;
  events(id?: string): RecoveryEvent[];
}
export interface RecoveryReader { read(target: RecoveryTarget, signal?: AbortSignal): Promise<RemoteRecoveryResult> }
