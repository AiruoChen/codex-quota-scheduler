import type { ManagementService } from "./service.js";
import type { TaskRun, ExecutionEvent } from "../domain/task.js";
import type { RecoveryEvent } from "../domain/recovery.js";
import type { AppConfig } from "../config/load.js";

// Type-only HTTP contracts. Browser modules never import backend code at runtime.
export type ManagementState = Awaited<ReturnType<ManagementService["state"]>>;
export type TimedPage = Awaited<ReturnType<ManagementService["timedPlans"]>>;
export type { RunSummary } from "../domain/task.js";
export interface RunDetail { run: TaskRun; events: ExecutionEvent[]; recovery: RecoveryEvent[];
  origin: { account: string; cliVersion: string } | null; cancelRequested: boolean; queued?: boolean }
export interface ConfigDetail { active: AppConfig; saved: AppConfig; revision: string }
