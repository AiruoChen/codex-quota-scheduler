import { spawn, type ChildProcess } from "node:child_process";
import { contactInstance, readInstance, type RuntimeRecord } from "../runtime/instance.js";
import { AppError } from "../shared/errors.js";
import { isRecord } from "../shared/validation.js";

export interface DesktopConnection { url: string; pid: number; owned: boolean }
export interface BackendLaunch { executable: string; entry: string; electron: boolean; timeoutMs?: number }

/** Uses the same executable in Node mode; inherited mode also supports npm Codex launchers. */
export function backendEnvironment(base: NodeJS.ProcessEnv, electron: boolean): NodeJS.ProcessEnv {
  const env = { ...base };
  delete env.NODE_OPTIONS; delete env.NODE_PATH;
  delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_NO_ASAR;
  if (electron) env.ELECTRON_RUN_AS_NODE = "1";
  return env;
}

export class DesktopBackend {
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
      const status = await contactInstance(existing);
      if (status.stopping || existing.state !== "ready") throw new AppError("RUNTIME_STOPPING", "已有服务尚未就绪或正在停止。");
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
      const status = await contactInstance(record);
      if (status.stopping) throw new AppError("RUNTIME_STOPPING", "后台已开始停止。");
      this.record = record;
      ready = true;
      return { url: record.url, pid: record.pid, owned: true };
    } catch (error) {
      // Disconnect is a graceful shutdown request, including after partial startup.
      if (child.connected) child.disconnect();
      await this.exited;
      throw error;
    }
  }

  close(): Promise<void> {
    return this.closing ??= (async () => {
      await this.starting?.catch(() => {});
      if (!this.child) return; // A service started outside this desktop remains independent.
      if (this.record && this.child.exitCode === null) {
        try { await contactInstance(this.record, true); }
        catch { if (this.child.connected) this.child.disconnect(); }
      } else if (this.child.connected) this.child.disconnect();
      await this.exited;
    })();
  }
}
