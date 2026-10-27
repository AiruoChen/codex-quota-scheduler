import type { ExecutionOutcome, ExecutionSink, RunUpdate, StoredTask, TaskDefinition, TaskRevision, TaskRun, TaskStatus, TaskQuery, TaskPage } from "./task.js";
import type { QuotaSnapshot } from "./quota.js";

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

export interface TaskRepository {
  list(): Promise<StoredTask[]>;
  query(query: TaskQuery): Promise<TaskPage>;
  get(id: string): Promise<StoredTask | null>;
  create(task: TaskDefinition, prompt: string): Promise<StoredTask>;
  update(task: TaskDefinition, prompt: string, expectedRevision: number): Promise<StoredTask>;
  remove(id: string, expectedRevision: number): Promise<void>;
  revisions(id: string): Promise<TaskRevision[]>;
}

export interface RunRepository {
  create(taskId: string): Promise<TaskRun>;
  get(id: string): Promise<TaskRun | null>;
  update(id: string, update: RunUpdate, expectedStatus: TaskStatus): Promise<TaskRun>;
  listByTask(taskId: string): Promise<TaskRun[]>;
}

export interface TaskExecutor {
  execute(run: TaskRun, signal: AbortSignal, sink: ExecutionSink, expectedAccount?: QuotaSnapshot["account"]): Promise<ExecutionOutcome>;
}

export interface Notifier {
  notify(message: string): Promise<void>;
}
