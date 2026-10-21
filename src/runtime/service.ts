import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { loadConfig } from "../config/load.js";
import { ManagementService } from "../management/service.js";
import { serveManagement } from "../adapters/http/management-server.js";
import { AppError } from "../shared/errors.js";
import { localProcesses } from "../shared/process.js";
import { claimInstance, contactInstance, readInstance, runtimePaths } from "./instance.js";
import { RuntimeLogger } from "./log.js";

export async function runForeground(configPath: string, port: number): Promise<void> {
  const config = await loadConfig(configPath);
  const lease = await claimInstance(configPath);
  let service: ManagementService | undefined;
  let server: Awaited<ReturnType<typeof serveManagement>> | undefined;
  let stop!: () => void;
  const stopped = new Promise<void>((resolveStop) => { stop = resolveStop; });
  process.on("SIGINT", stop); process.on("SIGTERM", stop);
  try {
    const logger = new RuntimeLogger(runtimePaths(configPath).log);
    service = new ManagementService(config, resolve(configPath), logger.write);
    await service.initialize();
    server = await serveManagement(service, { port, instance: lease.record.instance, controlToken: lease.record.token, logger, onStop: stop });
    await lease.ready(server.url);
    logger.write("runtime_started");
    console.log(JSON.stringify({ event: "runtime_ready", url: server.url, pid: process.pid }));
    if (process.connected) { process.send?.({ event: "runtime_ready", url: server.url }); process.disconnect?.(); }
    await stopped;
    logger.write("runtime_stopping");
    await lease.stopping();
    await server.close(); server = undefined; service = undefined;
    logger.write("runtime_stopped");
  } finally {
    process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop);
    try { if (server) await server.close(); else await service?.close(); }
    finally { await lease.release(); }
  }
}

export async function startBackground(configPath: string, port: number) {
  const existing = await readInstance(configPath);
  if (existing) {
    await contactInstance(existing);
    return { running: true, url: existing.url, pid: existing.pid };
  }
  await loadConfig(configPath);
  const child = spawn(process.execPath, ["--experimental-sqlite", fileURLToPath(new URL("../cli.js", import.meta.url)), "ui", "--config", resolve(configPath), "--port", String(port)], {
    detached: true, windowsHide: true, stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  try {
    return await new Promise<{ running: true; url: string; pid: number | undefined }>((resolveReady, reject) => {
      const timer = setTimeout(() => { reject(new AppError("RUNTIME_START_TIMEOUT", "后台启动未在 15 秒内就绪；服务可能仍在初始化，请 service status。")); }, 15000);
      child.once("error", (error) => { clearTimeout(timer); reject(error); });
      child.once("exit", () => { clearTimeout(timer); reject(new AppError("RUNTIME_START_FAILED", "后台服务未能启动；请运行 ui 查看错误。")); });
      child.on("message", (message: unknown) => {
        if (message && typeof message === "object" && "event" in message && message.event === "runtime_ready" && "url" in message && typeof message.url === "string") {
          clearTimeout(timer); resolveReady({ running: true, url: message.url, pid: child.pid });
        }
      });
    });
  } finally {
    if (child.connected) child.disconnect();
    child.unref();
  }
}

export async function runtimeStatus(configPath: string) {
  const record = await readInstance(configPath);
  if (!record) return { running: false, state: "stopped" };
  try {
    const info = await contactInstance(record) as { stopping: boolean };
    return { running: true, state: info.stopping ? "stopping" : "ready", url: record.url, pid: record.pid, startedAt: record.startedAt };
  } catch {
    const dead = localProcesses.inspect(record.pid) === "dead";
    return { running: !dead && record.state === "stopping", state: dead ? "stale" : record.state === "ready" ? "unreachable" : record.state, pid: record.pid,
      note: "不自动清理。确认进程退出后使用 service recover；数据库恢复独立处理。" };
  }
}

export async function stopBackground(configPath: string) {
  const record = await readInstance(configPath);
  if (!record) return { stopped: true };
  try { await contactInstance(record, true); }
  catch (error) { if (record.state !== "stopping") throw error; }
  // A bounded wait is only a status report; never kill or claim cancellation on timeout.
  for (let index = 0; index < 30; index++) {
    if (!(await readInstance(configPath))) return { stopped: true };
    await delay(100);
  }
  return { stopped: false, stopping: true, note: "已请求停止，正在等待执行终态落盘。请稍后 service status。" };
}
