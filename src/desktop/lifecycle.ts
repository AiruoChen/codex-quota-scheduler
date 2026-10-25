import type { BackendSession, LifecycleState, RuntimeActivity, ShutdownMode } from "../domain/lifecycle.js";
import { AppError } from "../shared/errors.js";

/** Framework-independent lifecycle coordination. UI decisions never bypass backend ownership or recovery checks. */
export class DesktopLifecycle {
  private state: LifecycleState = { phase: "idle", connection: null, activity: null, code: null, mode: null };
  private backend: BackendSession | undefined;
  private operation: Promise<void> | undefined;
  private checking: Promise<void> | undefined;

  constructor(private readonly factory: (exited: () => void) => BackendSession,
    private readonly changed: (state: LifecycleState) => void = () => {}) {}

  snapshot(): LifecycleState { return structuredClone(this.state); }
  private activity(status: RuntimeActivity): RuntimeActivity {
    return { activeOperations: status.activeOperations, activeRunId: status.activeRunId, paused: status.paused };
  }
  private update(patch: Partial<LifecycleState>): void { this.state = { ...this.state, ...patch }; this.changed(this.snapshot()); }
  private failure(error: unknown): void {
    this.update({ phase: "failed", code: error instanceof AppError ? error.code : "DESKTOP_OPERATION_FAILED" });
  }
  private exclusive(action: () => Promise<void>): Promise<void> {
    if (this.operation) throw new AppError("LIFECYCLE_BUSY", "后台状态正在切换，请等待完成。");
    this.operation = Promise.resolve().then(action).catch((error: unknown) => { this.failure(error); throw error; })
      .finally(() => { this.operation = undefined; });
    return this.operation;
  }
  private async launch(): Promise<void> {
    this.update({ phase: "starting", code: null, mode: null, connection: null, activity: null });
    const backend = this.factory(() => {
      if (this.backend === backend && this.state.phase !== "stopping") this.failure(new AppError("DESKTOP_BACKEND_EXITED", "后台已退出，请核对状态。"));
    });
    this.backend = backend;
    const connection = await backend.start();
    const activity = await backend.status();
    this.update({ phase: "running", connection, activity: this.activity(activity), code: null });
  }
  start(): Promise<void> {
    if (this.state.phase === "running") return Promise.resolve();
    if (this.state.phase === "disconnected" && this.state.connection?.owned) return this.check();
    return this.exclusive(async () => {
      await this.backend?.close("cancel");
      await this.launch();
    });
  }
  check(): Promise<void> {
    if (!this.backend || this.state.phase === "failed" && !this.state.connection || this.state.phase === "stopped" || this.state.phase === "starting") return Promise.resolve();
    return this.checking ??= (async () => {
      const backend = this.backend;
      try {
        const activity = await backend!.status();
        if (this.backend !== backend) return;
        if (this.state.phase === "stopping") this.update({ activity: this.activity(activity), mode: activity.shutdownMode ?? this.state.mode });
        else if (!this.operation) this.update({ phase: activity.stopping ? "disconnected" : "running", activity: this.activity(activity),
          code: activity.stopping ? "RUNTIME_STOPPING" : null });
      } catch (error) {
        if (this.backend === backend && !this.operation) this.update({ phase: "disconnected", code: error instanceof AppError ? error.code : "RUNTIME_UNREACHABLE", activity: null });
      }
    })().finally(() => { this.checking = undefined; });
  }
  stop(mode: ShutdownMode, external = false): Promise<void> {
    if (!this.state.connection?.owned && this.state.connection && !external) {
      throw new AppError("EXTERNAL_SERVICE", "此服务由其他进程启动，停止需要单独确认。");
    }
    return this.exclusive(async () => {
      this.update({ phase: "stopping", mode, code: null });
      await this.backend?.close(mode, external);
      this.update({ phase: "stopped", connection: null, activity: null, mode: null });
    });
  }
  restart(mode: ShutdownMode): Promise<void> {
    if (!this.state.connection?.owned) throw new AppError("EXTERNAL_SERVICE", "外部服务不能通过自有后台重启操作停止。");
    return this.exclusive(async () => {
      this.update({ phase: "stopping", mode, code: null });
      await this.backend?.close(mode);
      await this.launch();
    });
  }
  async escalate(): Promise<void> {
    if (this.state.phase !== "stopping") throw new AppError("INVALID_ARGUMENT", "后台当前不在停止状态。");
    await this.backend?.escalate();
    this.update({ mode: "cancel" });
  }
  async detach(): Promise<void> {
    await this.operation?.catch(() => {});
    await this.backend?.close("cancel");
  }
}
