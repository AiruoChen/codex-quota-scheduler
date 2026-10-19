export type TaskStatus =
  | "queued"
  | "waiting_quota"
  | "running"
  | "succeeded"
  | "failed"
  | "needs_attention"
  | "cancelled";

export interface TaskDefinition {
  id: string;
  name: string;
  enabled: boolean;
  projectDir: string;
  promptFile: string;
  priority: number;
  model?: string;
  session: { mode: "new" } | { mode: "resume"; threadId: string };
}

export interface TaskRun {
  id: string;
  taskId: string;
  taskRevision: number;
  taskSnapshot: TaskDefinition;
  promptHash: string;
  status: TaskStatus;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  threadId: string | null;
  promptSnapshot: string;
  output: string;
  error: string | null;
}

export interface StoredTask extends TaskDefinition {
  revision: number;
  promptSnapshot: string;
  promptHash: string;
  createdAt: string;
  updatedAt: string;
}

export interface TaskRevision {
  taskId: string;
  revision: number;
  definition: TaskDefinition;
  promptSnapshot: string;
  promptHash: string;
  createdAt: string;
}

export interface RunUpdate {
  status: TaskStatus;
  startedAt?: string | null;
  completedAt?: string | null;
  threadId?: string | null;
  output?: string;
  error?: string | null;
}
