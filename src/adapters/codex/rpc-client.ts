import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { AppError } from "../../shared/errors.js";
import { isRecord } from "../../shared/validation.js";
import type { CodexLaunch, CodexOptions } from "./launcher.js";
import { createRpcError, rpcMethod } from "./rpc-errors.js";

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: AppError) => void;
  timer: NodeJS.Timeout;
  method: string;
  cleanup: () => void;
}

/** A single stdio JSON-RPC connection. It never logs raw stderr, results or errors. */
export class StdioRpcClient {
  private readonly notifications = new Set<(method: string, params: unknown) => void>();
  private readonly failures = new Set<(error: AppError) => void>();
  private serverRequest: ((method: string, params: unknown) => unknown) | undefined;
  private observer: ((phase: "request" | "response" | "error", method: string, id: number, value: unknown) => void) | undefined;
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly closed: Promise<void>;
  private exited = false;
  private failure: AppError | undefined;
  private buffer = "";
  private sequence = 0;
  private static readonly maxMessageBytes = 1024 * 1024;

  constructor(private readonly launch: CodexLaunch, private readonly options: CodexOptions) {
    this.child = spawn(launch.executable, [...launch.args, "app-server", "--listen", "stdio://"], {
      env: launch.env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, shell: false,
    });
    this.closed = new Promise((resolve) => {
      this.child.once("close", () => { this.exited = true; resolve(); });
    });
    this.child.once("error", () => this.fail(new AppError("CODEX_START_FAILED", "无法启动 Codex App Server，请检查可执行文件和权限。")));
    this.child.once("exit", (code) => this.fail(new AppError("CODEX_EXITED", `Codex App Server 提前退出（代码 ${code ?? "signal"}），请检查 CLI 配置。`)));
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.receive(chunk));
    this.child.stdout.once("end", () => this.fail(new AppError("CODEX_CONNECTION_CLOSED", "Codex App Server 已关闭输出连接。")));
    this.child.stdout.on("error", () => this.fail(new AppError("CODEX_CONNECTION_CLOSED", "无法读取 Codex App Server 响应。")));
    this.child.stdin.on("error", () => this.fail(new AppError("CODEX_CONNECTION_CLOSED", "无法写入 Codex App Server 连接。")));
    this.child.stderr.on("error", () => {});
    this.child.stderr.resume();
  }

  request(method: string, params?: unknown, signal?: AbortSignal): Promise<unknown> {
    if (this.failure) return Promise.reject(this.failure);
    if (signal?.aborted) return Promise.reject(new AppError("EXECUTION_CANCELLED", "执行已请求停止。"));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.fail(new AppError("CODEX_TIMEOUT", `Codex ${rpcMethod(method)} 请求超时，请检查网络、登录状态或调整 requestTimeoutMs。`));
      }, this.options.requestTimeoutMs);
      const abort = () => {
        this.pending.delete(id);
        clearTimeout(timer);
        cleanup();
        reject(new AppError("EXECUTION_CANCELLED", "执行已请求停止。"));
      };
      const cleanup = () => signal?.removeEventListener("abort", abort);
      signal?.addEventListener("abort", abort, { once: true });
      this.pending.set(id, { resolve, reject, timer, method, cleanup });
      if (!this.observe("request", method, id, params)) return;
      this.write({ id, method, ...(params === undefined ? {} : { params }) });
    });
  }

  notify(method: string): void {
    if (this.failure) throw this.failure;
    this.write({ method });
  }

  onNotification(listener: (method: string, params: unknown) => void): () => void {
    this.notifications.add(listener);
    return () => { this.notifications.delete(listener); };
  }

  onFailure(listener: (error: AppError) => void): () => void {
    this.failures.add(listener);
    if (this.failure) listener(this.failure);
    return () => { this.failures.delete(listener); };
  }

  handleServerRequests(handler: (method: string, params: unknown) => unknown): void {
    this.serverRequest = handler;
  }

  /** Internal control-plane projection hook. Consumers must never store raw values. */
  onObservation(listener: NonNullable<StdioRpcClient["observer"]>): void { this.observer = listener; }
  private observe(phase: "request" | "response" | "error", method: string, id: number, value: unknown): boolean {
    try { this.observer?.(phase, method, id, value); return true; }
    catch { this.fail(new AppError("STORAGE_WRITE_FAILED", "无法保存执行诊断，停止本次提交并保留核对状态。")); return false; }
  }

  private write(message: unknown): void {
    try {
      this.child.stdin.write(JSON.stringify(message) + "\n", (error) => {
        if (error) this.fail(new AppError("CODEX_CONNECTION_CLOSED", "Codex App Server 连接已断开。"));
      });
    } catch {
      this.fail(new AppError("CODEX_CONNECTION_CLOSED", "Codex App Server 连接已断开。"));
    }
  }

  private receive(chunk: string): void {
    if (this.failure) return;
    this.buffer += chunk;
    let newline: number;
    while ((newline = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (Buffer.byteLength(line) > StdioRpcClient.maxMessageBytes) return this.invalid();
      if (line.trim() === "") continue;
      let message: unknown;
      try { message = JSON.parse(line); } catch { return this.invalid(); }
      if (!isRecord(message)) return this.invalid();
      if (typeof message.method === "string") {
        if (message.id !== undefined) {
          try {
            const result = this.serverRequest?.(message.method, message.params);
            this.write(result === undefined
              ? { id: message.id, error: { code: -32601, message: "Unsupported client request" } }
              : { id: message.id, result });
          } catch { this.fail(new AppError("CODEX_CLIENT_ERROR", "处理 Codex 请求时发生错误。")); }
        } else {
          try { for (const listener of this.notifications) listener(message.method, message.params); }
          catch { this.fail(new AppError("CODEX_CLIENT_ERROR", "保存 Codex 执行事件失败。")); }
        }
        continue;
      }
      if (typeof message.id !== "number") return this.invalid();
      const request = this.pending.get(message.id);
      if (!request) continue;
      this.pending.delete(message.id);
      clearTimeout(request.timer);
      request.cleanup();
      if (message.error !== undefined) {
        const error = createRpcError(message.error, request.method, this.launch.version);
        this.observe("error", request.method, message.id, { code: error.code, rpcCode: error.diagnostic.rpcCode });
        request.reject(error);
      }
      else if (Object.hasOwn(message, "result")) {
        if (this.observe("response", request.method, message.id, message.result)) request.resolve(message.result);
        else request.reject(new AppError("STORAGE_WRITE_FAILED", "无法保存执行诊断，请核对当前会话状态。"));
      }
      else { request.reject(new AppError("CODEX_PROTOCOL_ERROR", "Codex 响应缺少 result 或 error。")); this.invalid(); }
    }
    if (Buffer.byteLength(this.buffer) > StdioRpcClient.maxMessageBytes) this.invalid();
  }

  private invalid(): void {
    this.fail(new AppError("CODEX_PROTOCOL_ERROR", "Codex 返回无效或过大的 JSON-RPC 消息，请检查 CLI 版本。"));
  }

  private fail(error: AppError): void {
    const first = this.failure === undefined;
    this.failure ??= error;
    for (const [id, request] of this.pending) {
      try { this.observer?.("error", request.method, id, { code: this.failure.code }); } catch { /* Preserve the original failure and never retry. */ }
      clearTimeout(request.timer);
      request.cleanup();
      request.reject(this.failure);
    }
    this.pending.clear();
    if (first) for (const listener of this.failures) listener(this.failure);
  }

  private async waitForClose(): Promise<boolean> {
    if (this.exited) return true;
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        this.closed.then(() => true),
        new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), this.options.shutdownTimeoutMs); }),
      ]);
    } finally { clearTimeout(timer); }
  }

  async close(): Promise<void> {
    this.fail(new AppError("CODEX_CONNECTION_CLOSED", "Codex 连接已关闭。"));
    this.child.stdin.end();
    if (!await this.waitForClose()) {
      this.child.kill();
      if (!await this.waitForClose()) {
        this.child.kill("SIGKILL");
        await this.waitForClose();
      }
    }
    this.child.stdin.destroy();
    this.child.stdout.destroy();
    this.child.stderr.destroy();
    this.child.unref();
  }
}
