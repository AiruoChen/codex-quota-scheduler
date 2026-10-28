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
  environment?: import("./catalog.js").ExecutionEnvironment;
  quotaContinuation?: { enabled: boolean; maxAttempts: number };
  execution?: {
    sandbox: "read-only" | "workspace-write";
    timeoutMs: number;
    effort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
  };
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
  turnId?: string | null;
  promptSnapshot: string;
  output: string;
  error: string | null;
  continuation?: import("./continuation.js").ContinuationLink;
  timed?: import("./timed-plan.js").TimedRunLink;
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

export interface TaskQuery { search: string; enabled: "all" | "enabled" | "disabled"; offset: number; limit: number; sort?: "created_desc" | "created_asc" }
export interface TaskPage { items: Omit<StoredTask, "promptSnapshot">[]; total: number; offset: number; limit: number }
export type RunSummary = Omit<TaskRun, "promptSnapshot" | "output" | "taskSnapshot"> & { name: string; projectDir: string };
export interface RunQuery { search: string; status: "all" | TaskStatus; offset: number; limit: number }
export interface RunPage { items: RunSummary[]; total: number; offset: number; limit: number }

export interface RunUpdate {
  status: TaskStatus;
  startedAt?: string | null;
  completedAt?: string | null;
  threadId?: string | null;
  turnId?: string | null;
  output?: string;
  error?: string | null;
}

export interface ExecutionEvent {
  sequence: number;
  runId: string;
  createdAt: string;
  type: string;
  data: Record<string, unknown>;
}

export interface ExecutionOutcome {
  status: "succeeded" | "failed" | "cancelled" | "needs_attention" | "waiting_quota";
  output: string;
  error: string | null;
  quotaFailure?: { threadId: string; turnId: string };
  quotaInterruption?: import("./continuation.js").QuotaInterruption;
}

export interface ExecutionSink {
  admit?(): void;
  origin(origin: import("./recovery.js").ExecutionOrigin): void;
  event(type: string, data: Record<string, unknown>): void;
  thread(threadId: string): void;
  submitted(): void;
  turn(turnId: string): void;
  output(text: string): void;
}
