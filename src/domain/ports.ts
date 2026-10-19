import type { TaskDefinition, TaskRun } from "./task.js";

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

export interface TaskRepository {
  list(): Promise<TaskDefinition[]>;
  save(task: TaskDefinition): Promise<void>;
  remove(id: string): Promise<void>;
}

export interface RunRepository {
  save(run: TaskRun): Promise<void>;
  listByTask(taskId: string): Promise<TaskRun[]>;
}

export interface TaskExecutor {
  execute(task: TaskDefinition, prompt: string, signal: AbortSignal): Promise<TaskRun>;
}

export interface Notifier {
  notify(message: string): Promise<void>;
}
