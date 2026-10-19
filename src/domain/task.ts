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
  status: TaskStatus;
  startedAt: string;
  completedAt: string | null;
  threadId: string | null;
  promptSnapshot: string;
  output: string;
}
