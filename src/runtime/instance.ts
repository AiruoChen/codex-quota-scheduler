import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { localProcesses } from "../shared/process.js";
import { AppError } from "../shared/errors.js";
import { isRecord } from "../shared/validation.js";

export interface RuntimeRecord {
  version: 1;
  instance: string;
  pid: number;
  configPath: string;
  startedAt: string;
  state: "starting" | "ready" | "stopping";
  url: string | null;
  token: string;
}
export function runtimePaths(configPath: string) {
  const config = resolve(configPath);
  const key = createHash("sha256").update(process.platform === "win32" ? config.toLowerCase() : config).digest("hex").slice(0, 16);
  const directory = resolve(dirname(config), "../.runtime", key);
  return { directory, record: join(directory, "instance.json"), log: join(directory, "runtime.log") };
}

export async function readInstance(configPath: string): Promise<RuntimeRecord | null> {
  try {
    const record = JSON.parse(await readFile(runtimePaths(configPath).record, "utf8")) as RuntimeRecord;
    if (record.version !== 1 || typeof record.instance !== "string" || !/^[\da-f-]{36}$/.test(record.instance)
      || !Number.isSafeInteger(record.pid) || record.pid < 1 || record.configPath !== resolve(configPath)
      || typeof record.token !== "string" || !/^[\da-f]{64}$/.test(record.token)
      || !Number.isFinite(Date.parse(record.startedAt))
      || !["starting", "ready", "stopping"].includes(record.state)
      || record.url !== null && (typeof record.url !== "string" || !/^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(record.url))) throw new Error("Invalid instance");
    return record;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new AppError("RUNTIME_RECORD_INVALID", "运行记录损坏；请核对进程，保留记录后人工处理。");
  }
}

export async function claimInstance(configPath: string) {
  return mutateInstance(configPath, () => claimUnlocked(configPath));
}

/** Serialize every cooperating writer, including recovery's check-and-delete sequence. */
async function mutateInstance<T>(configPath: string, action: () => Promise<T>): Promise<T> {
  const paths = runtimePaths(configPath);
  await mkdir(paths.directory, { recursive: true });
  const lockPath = paths.record + ".lock";
  let lock;
  try { lock = await open(lockPath, "wx", 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new AppError("RUNTIME_BUSY", "实例记录正在变更；若进程异常退出，请确认所有相关进程已退出后人工清理 instance.json.lock。");
    }
    throw error;
  }
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid }));
    return await action();
  } finally { await lock.close(); await unlink(lockPath); }
}

async function claimUnlocked(configPath: string) {
  const paths = runtimePaths(configPath);
  await mkdir(paths.directory, { recursive: true });
  let handle: Awaited<ReturnType<typeof open>>;
  try { handle = await open(paths.record, "wx", 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new AppError("RUNTIME_BUSY", "此配置已有运行记录；请 service status，异常退出后显式 service recover。");
    throw error;
  }
  const record: RuntimeRecord = { version: 1, instance: randomUUID(), pid: process.pid, configPath: resolve(configPath),
    startedAt: new Date().toISOString(), state: "starting", url: null, token: randomBytes(32).toString("hex") };
  try { await handle.writeFile(JSON.stringify(record)); await handle.sync(); }
  catch (error) { await handle.close(); await unlink(paths.record); throw error; }
  await handle.close();
  async function save() {
    return mutateInstance(configPath, async () => {
      const current = await readInstance(configPath);
      if (current?.instance !== record.instance) throw new AppError("RUNTIME_BUSY", "实例记录已变化，不会覆盖其他服务。");
      const temporary = `${paths.record}.${record.instance}.tmp`;
      const file = await open(temporary, "wx", 0o600);
      try {
        try { await file.writeFile(JSON.stringify(record)); await file.sync(); } finally { await file.close(); }
        await rename(temporary, paths.record);
      } finally { await unlink(temporary).catch(() => {}); }
    });
  }
  return { record, async ready(url: string) { record.url = url; record.state = "ready"; await save(); },
    async stopping() { record.state = "stopping"; await save(); }, async release() {
    await mutateInstance(configPath, async () => {
      const current = await readInstance(configPath);
      if (current?.instance === record.instance) await unlink(paths.record);
    });
  } };
}

export async function recoverInstance(configPath: string) {
  return mutateInstance(configPath, () => recoverUnlocked(configPath));
}

async function recoverUnlocked(configPath: string) {
  const record = await readInstance(configPath);
  if (!record) return { recovered: false };
  if (localProcesses.inspect(record.pid) !== "dead") throw new AppError("RUNTIME_BUSY", "进程仍存在或无法确认退出，不会删除运行记录。");
  // Re-read immediately before removal; never kill a process by an unverified PID.
  const current = await readInstance(configPath);
  if (current?.instance !== record.instance || localProcesses.inspect(record.pid) !== "dead") throw new AppError("RUNTIME_BUSY", "运行状态已变化，请重试。");
  await unlink(runtimePaths(configPath).record);
  return { recovered: true, note: "只清理服务运行记录；数据库执行权仍需 recovery 显式核对。" };
}

export async function contactInstance(record: RuntimeRecord, stop = false) {
  if (!record.url) throw new AppError("RUNTIME_STARTING", "服务尚未就绪，请稍后查询状态。");
  // Verify the responder before submitting a stop to a potentially reused local port.
  if (stop) await contactInstance(record);
  const response = await fetch(record.url + (stop ? "/api/runtime/stop" : "/api/runtime"), {
    method: stop ? "POST" : "GET", signal: AbortSignal.timeout(3000), redirect: "error",
    headers: { Authorization: `Bearer ${record.token}`, "X-Runtime-Instance": record.instance },
  });
  if (!response.ok) throw new AppError("RUNTIME_UNREACHABLE", "无法验证此运行实例，不会向未知进程发送停止命令。");
  const result: unknown = await response.json();
  if (!isRecord(result) || result.instance !== record.instance || result.pid !== record.pid || typeof result.stopping !== "boolean") {
    throw new AppError("RUNTIME_UNREACHABLE", "响应身份与运行记录不匹配，不会信任该服务状态。");
  }
  return result;
}
