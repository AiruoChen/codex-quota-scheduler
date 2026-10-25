import type { ManagementService } from "./service.js";
import type { TaskRun, ExecutionEvent } from "../domain/task.js";
import type { RecoveryEvent } from "../domain/recovery.js";
import type { AppConfig } from "../config/load.js";

// Type-only HTTP contracts. Browser modules never import backend code at runtime.
export type ManagementState = Awaited<ReturnType<ManagementService["state"]>>;
export type RunSummary = Omit<TaskRun, "promptSnapshot" | "output" | "taskSnapshot"> & { name: string };
export interface RunDetail { run: TaskRun; events: ExecutionEvent[]; recovery: RecoveryEvent[] }
export interface ConfigDetail { active: AppConfig; saved: AppConfig }
