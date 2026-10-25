export type ShutdownMode = "wait" | "cancel";
export interface RuntimeActivity { activeOperations: number; activeRunId: string | null; paused: boolean }
export interface RuntimeControlStatus extends RuntimeActivity {
  instance: string; pid: number; stopping: boolean; shutdownMode: ShutdownMode | null;
}
export interface DesktopConnection { url: string; pid: number; owned: boolean }
export interface BackendSession {
  start(): Promise<DesktopConnection>;
  status(): Promise<RuntimeControlStatus>;
  close(mode?: ShutdownMode, stopExternal?: boolean): Promise<void>;
  escalate(): Promise<void>;
  desktopFeed?(request: import("./notifications.js").FeedRequest): Promise<import("./notifications.js").DesktopFeed>;
  pauseDispatch?(): Promise<void>;
}
export interface LifecycleState {
  phase: "idle" | "starting" | "running" | "stopping" | "stopped" | "failed" | "disconnected";
  connection: DesktopConnection | null;
  activity: RuntimeActivity | null;
  code: string | null;
  mode: ShutdownMode | null;
}
export type LifecycleIntent = "exit" | "stop" | "restart" | "stop-external" | "recover";
export const lifecycleCommands = ["start", "status", "restart", "stop", "stop-external", "recover", "exit", "wait", "cancel", "keep-open", "hide", "show", "pause", "notifications-toggle", "quota-notifications-toggle"] as const;
export type LifecycleCommand = typeof lifecycleCommands[number];
export interface LifecycleView extends LifecycleState { intent: LifecycleIntent | null; desktop?: import("./desktop.js").DesktopStatus }
