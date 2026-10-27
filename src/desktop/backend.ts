import { spawn, type ChildProcess } from "node:child_process";
import { contactInstance, inspectRuntime, readInstance, type RuntimeRecord } from "../runtime/instance.js";
import { AppError } from "../shared/errors.js";
import { isRecord } from "../shared/validation.js";
import { localProcesses } from "../shared/process.js";
import { setTimeout as delay } from "node:timers/promises";
import type { BackendSession, DesktopConnection, RuntimeControlStatus, ShutdownMode } from "../domain/lifecycle.js";
import { desktopRequest } from "../adapters/http/desktop-protocol.js";
import type { FeedRequest, DesktopFeed } from "../domain/notifications.js";

export type { DesktopConnection } from "../domain/lifecycle.js";
export interface BackendLaunch { executable: string; entry: string; electron: boolean; timeoutMs?: number }

/** Uses the same executable in Node mode; inherited mode also supports npm Codex launchers. */
export function backendEnvironment(base: NodeJS.ProcessEnv, electron: boolean): NodeJS.ProcessEnv {
  const env = { ...base };
  for (const key of Object.keys(env)) if (/^(NODE_OPTIONS|NODE_PATH|ELECTRON_RUN_AS_NODE|ELECTRON_NO_ASAR)$/i.test(key)) delete env[key];
  if (electron) env.ELECTRON_RUN_AS_NODE = "1";
  return env;
}

export class DesktopBackend implements BackendSession {
  private child: ChildProcess | undefined;
  private exited: Promise<void> | undefined;
  private record: RuntimeRecord | undefined;
  private starting: Promise<DesktopConnection> | undefined;
  private closing: Promise<void> | undefined;

  constructor(private readonly configPath: string, private readonly launch: BackendLaunch,
    private readonly onExit: () => void = () => {}) {}

  start(): Promise<DesktopConnection> { return this.starting ??= this.connect(); }

  private async connect(): Promise<DesktopConnection> {
    const existing = await readInstance(this.configPath);
    if (existing) {
      if (localProcesses.inspect(existing.pid) === "dead") throw new AppError("RUNTIME_STALE", "服务进程已退出，请先显式核对服务记录。");
      const status = await inspectRuntime(existing);
      if (status.stopping || existing.state !== "ready") throw new AppError("RUNTIME_STOPPING", "已有服务尚未就绪或正在停止。");
      this.record = existing;
      return { url: existing.url!, pid: existing.pid, owned: false };
    }
    const child = spawn(this.launch.executable, ["--experimental-sqlite", this.launch.entry, this.configPath], {
      // A separate Windows process group lets IPC loss trigger cleanup instead of console teardown killing the backend.
      detached: true, windowsHide: true, stdio: ["ignore", "ignore", "ignore", "ipc"], env: backendEnvironment(process.env, this.launch.electron),
    });
    this.child = child;
    this.exited = new Promise<void>((done) => { child.once("error", () => done()); child.once("exit", () => done()); });
    let ready = false;
    child.once("exit", () => { if (ready && !this.closing) this.onExit(); });
    try {
      await new Promise<void>((done, reject) => {
        const cleanup = () => { clearTimeout(timer); child.removeListener("message", message); child.removeListener("exit", exit); child.removeListener("error", failed); };
        const failed = () => { cleanup(); reject(new AppError("DESKTOP_BACKEND_FAILED", "后台启动失败，请检查配置与运行记录。")); };
        const exit = () => failed();
        const message = (value: unknown) => {
          if (!isRecord(value)) return;
          if (value.event === "runtime_failed") {
            cleanup(); reject(new AppError(typeof value.code === "string" && /^[A-Z_]+$/.test(value.code) ? value.code : "DESKTOP_BACKEND_FAILED", "后台启动失败，请检查配置与遗留运行状态。"));
          } else if (value.event === "runtime_ready") { cleanup(); done(); }
        };
        const timer = setTimeout(() => { cleanup(); reject(new AppError("DESKTOP_START_TIMEOUT", "后台尚未在限定时间就绪，请核对本地状态。")); }, this.launch.timeoutMs ?? 15000);
        child.once("error", failed); child.once("exit", exit); child.on("message", message);
      });
      const record = await readInstance(this.configPath);
      if (!record || record.pid !== child.pid || record.state !== "ready" || !record.url) throw new AppError("RUNTIME_UNREACHABLE", "后台身份与启动进程不匹配。");
      const status = await inspectRuntime(record);
      if (status.stopping) throw new AppError("RUNTIME_STOPPING", "后台已开始停止。");
      this.record = record;
      ready = true;
      return { url: record.url, pid: record.pid, owned: true };
    } catch (error) {
      // Disconnect is a graceful shutdown request, including after partial startup.
      if (child.connected) child.disconnect();
      throw error;
    }
  }

  private async current(): Promise<RuntimeRecord> {
    const current = await readInstance(this.configPath);
    if (!this.record || !current || current.instance !== this.record.instance || current.pid !== this.record.pid || current.url !== this.record.url) {
      throw new AppError("RUNTIME_INSTANCE_CHANGED", "后台实例已变化，请重新核对连接，不会控制其他服务。");
    }
    if (localProcesses.inspect(current.pid) === "dead") throw new AppError("RUNTIME_STALE", "服务进程已退出，请核对遗留记录。");
    return current;
  }

  async status(): Promise<RuntimeControlStatus> { return inspectRuntime(await this.current()); }

  async desktopFeed(request: FeedRequest): Promise<DesktopFeed> {
    const result = await desktopRequest(await this.current(), "feed", request);
    return result!;
  }
  async pauseDispatch(): Promise<void> {
    const record = await this.current(); await inspectRuntime(record);
    await desktopRequest(await this.current(), "pause");
  }

  async escalate(): Promise<void> {
    try { await contactInstance(await this.current(), "cancel"); }
    catch (error) {
      if (error instanceof AppError && error.code === "RUNTIME_INSTANCE_CHANGED") throw error;
      if (this.child?.connected) this.child.disconnect(); else throw error;
    }
  }

  close(mode: ShutdownMode = "cancel", stopExternal = false): Promise<void> {
    return this.closing ??= (async () => {
      await this.starting?.catch(() => {});
      if (this.child && this.child.pid === undefined) return;
      if (!this.child && !stopExternal) return;
      if (!this.child) {
        const record = await this.current();
        await contactInstance(record, mode);
        for (;;) {
          const next = await readInstance(this.configPath);
          if (!next) return;
          if (next.instance !== record.instance) throw new AppError("RUNTIME_INSTANCE_CHANGED", "停止期间出现其他实例，不会继续控制它。");
          if (localProcesses.inspect(record.pid) === "dead") throw new AppError("RUNTIME_STALE", "进程已退出但服务记录仍在，请显式核对遗留状态。");
          await delay(100);
        }
      }
      if (this.child.exitCode !== null || this.child.signalCode !== null) return;
      if (this.record && this.child.exitCode === null) {
        try { await contactInstance(await this.current(), mode); }
        catch (error) {
          if (mode === "wait" || error instanceof AppError && error.code === "RUNTIME_INSTANCE_CHANGED") throw error;
          if (this.child.connected) this.child.disconnect();
        }
      } else if (this.child.connected) this.child.disconnect();
      await this.exited;
      if (this.child.exitCode !== 0) throw new AppError("DESKTOP_SHUTDOWN_FAILED", "后台异常退出，保留状态供下次核对。");
    })().catch((error: unknown) => { this.closing = undefined; throw error; });
  }
}
