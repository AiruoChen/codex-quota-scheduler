import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { AppError } from "../shared/errors.js";
import { isRecord, requireRecord } from "../shared/validation.js";
import { loadConfig, parseConfig, type AppConfig } from "./load.js";

/** Same-directory replacement: readers see either the previous or the complete new JSON. */
async function atomicWrite(path: string, content: string): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, "wx", 0o600);
    try { await file.writeFile(content, "utf8"); await file.sync(); }
    finally { await file.close(); }
    await rename(temporary, path);
  } finally { await unlink(temporary).catch(() => {}); }
}

const allowed = new Set([
  "provider", "pollIntervalMs", "quotaMaxAgeMs", "reservePercent", "limitId", "tasksFile",
  "codex.executable", "codex.args", "codex.home", "codex.requestTimeoutMs", "codex.shutdownTimeoutMs",
  "storage.databasePath",
]);

export class ConfigManager {
  readonly path: string;
  constructor(path: string) { this.path = resolve(path); }

  show(): Promise<AppConfig> { return loadConfig(this.path); }

  async init(source: string): Promise<AppConfig> {
    const config = await loadConfig(source);
    return this.lock(async () => {
      try { await readFile(this.path); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        await atomicWrite(this.path, JSON.stringify(config, null, 2) + "\n");
        return config;
      }
      throw new AppError("CONFIG_EXISTS", "配置已存在，init 不会覆盖；请使用 config set。");
    });
  }

  async set(key: string, value: unknown): Promise<AppConfig> {
    if (!allowed.has(key)) throw new AppError("INVALID_CONFIG_KEY", "配置键不受支持。");
    return this.lock(async () => {
      const previous = await readFile(this.path, "utf8");
      const data = requireRecord(JSON.parse(previous), "配置");
      parseConfig(data, this.path);
      const keys = key.split(".");
      if (keys.length === 1) data[key] = value;
      else {
        const parent = keys[0]!;
        if (data[parent] === undefined) data[parent] = {};
        if (!isRecord(data[parent])) throw new AppError("INVALID_CONFIG", "配置段必须是对象。");
        (data[parent] as Record<string, unknown>)[keys[1]!] = value;
      }
      const config = parseConfig(data, this.path);
      await atomicWrite(this.path + ".bak", previous);
      await atomicWrite(this.path, JSON.stringify(data, null, 2) + "\n");
      return config;
    });
  }

  async restore(): Promise<AppConfig> {
    return this.lock(async () => {
      const backup = await readFile(this.path + ".bak", "utf8");
      const config = parseConfig(JSON.parse(backup), this.path);
      await atomicWrite(this.path, backup);
      return config;
    });
  }

  private async lock<T>(action: () => Promise<T>): Promise<T> {
    await mkdir(dirname(this.path), { recursive: true });
    let handle;
    try { handle = await open(this.path + ".lock", "wx", 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new AppError("CONFIG_BUSY", "配置正被另一写入操作锁定；若上次进程崩溃，请确认进程已退出后清理 .lock 文件。");
      throw error;
    }
    try { await handle.writeFile(JSON.stringify({ pid: process.pid })); return await action(); }
    finally { await handle.close(); await unlink(this.path + ".lock"); }
  }
}
