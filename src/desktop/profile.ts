import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { loadConfig } from "../config/load.js";
import { ConfigManager } from "../config/manage.js";
import { AppError } from "../shared/errors.js";

export interface DesktopOptions { dataDir: string; configPath: string; debugging: boolean }

export function desktopOptions(args: readonly string[], defaultDataDir: string): DesktopOptions {
  let dataDir = resolve(defaultDataDir);
  let configPath: string | undefined;
  let debugging = false;
  const seen = new Set<string>();
  for (let index = 0; index < args.length; index++) {
    const option = args[index]!;
    // Chromium's ephemeral loopback debugging endpoint is used by packaged smoke tests.
    if (option === "--remote-debugging-port=0" && !debugging) { debugging = true; continue; }
    const value = args[++index];
    if (!["--data-dir", "--config"].includes(option) || seen.has(option) || !value || value.startsWith("--") || value.includes("\0")) {
      throw new AppError("INVALID_ARGUMENT", "桌面参数仅支持 --data-dir 目录和 --config 已有配置文件。");
    }
    seen.add(option);
    if (option === "--data-dir") dataDir = resolve(value); else configPath = resolve(value);
  }
  return { dataDir, configPath: configPath ?? join(dataDir, "config/local.json"), debugging };
}

export async function initializeDesktopProfile(options: DesktopOptions): Promise<void> {
  try { await readFile(options.configPath); await loadConfig(options.configPath); return; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (options.configPath !== join(options.dataDir, "config/local.json")) {
    throw new AppError("CONFIG_NOT_FOUND", "指定的配置不存在，请选择已有配置文件。");
  }
  const databasePath = join(options.dataDir, "data/state.sqlite");
  try { await stat(databasePath); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await mkdir(options.dataDir, { recursive: true });
    try { await writeFile(join(options.dataDir, "tasks.json"), "[]\n", { flag: "wx", mode: 0o600 }); }
    catch (writeError) { if ((writeError as NodeJS.ErrnoException).code !== "EEXIST") throw writeError; }
    await new ConfigManager(options.configPath).create({ schemaVersion: 1, provider: "mock", pollIntervalMs: 60000,
      quotaMaxAgeMs: 120000, reservePercent: 10, limitId: "codex", tasksFile: "../tasks.json",
      storage: { databasePath: "../data/state.sqlite" }, scheduler: { trigger: "available" } });
    return;
  }
  throw new AppError("CONFIG_MISSING_WITH_DATA", "检测到已有数据库但缺少配置，请先恢复原配置，不会自动初始化。");
}
