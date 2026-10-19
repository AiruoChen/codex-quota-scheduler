import type { RunUpdate, StoredTask, TaskDefinition, TaskRevision, TaskRun, TaskStatus } from "./task.js";

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

export interface TaskRepository {
  list(): Promise<StoredTask[]>;
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
  execute(task: TaskDefinition, prompt: string, signal: AbortSignal): Promise<TaskRun>;
}

export interface Notifier {
  notify(message: string): Promise<void>;
}
