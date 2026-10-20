import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { AppError } from "../shared/errors.js";
import { requireNumber, requireRecord, requireString } from "../shared/validation.js";
import { defaultCodexOptions, type CodexOptions } from "../adapters/codex/launcher.js";

export interface AppConfig {
  schemaVersion: 1;
  provider: "mock" | "codex";
  pollIntervalMs: number;
  quotaMaxAgeMs: number;
  reservePercent: number;
  limitId: string;
  tasksFile: string;
  codex: CodexOptions;
  storage: { databasePath: string };
  scheduler?: { trigger: "available" | "refresh" };
}

function loadCodexOptions(value: unknown, base: string): CodexOptions {
  const data = value === undefined ? {} : requireRecord(value, "codex");
  const executable = data.executable === undefined ? "codex" : requireString(data.executable, "codex.executable");
  const args = data.args ?? [];
  if (!Array.isArray(args) || !args.every((arg: unknown) => typeof arg === "string" && !arg.includes("\0"))) {
    throw new AppError("INVALID_CONFIG", "codex.args 必须是字符串数组，且不能包含空字符");
  }
  const options: CodexOptions = {
    ...defaultCodexOptions,
    executable: /[\\/]/.test(executable) ? resolve(base, executable) : executable,
    args: [...args] as string[],
    requestTimeoutMs: data.requestTimeoutMs === undefined ? defaultCodexOptions.requestTimeoutMs
      : requireNumber(data.requestTimeoutMs, "codex.requestTimeoutMs", 100, 120000),
    shutdownTimeoutMs: data.shutdownTimeoutMs === undefined ? defaultCodexOptions.shutdownTimeoutMs
      : requireNumber(data.shutdownTimeoutMs, "codex.shutdownTimeoutMs", 100, 10000),
  };
  if (data.home !== undefined) options.home = resolve(base, requireString(data.home, "codex.home"));
  return options;
}

export async function loadConfig(path: string): Promise<AppConfig> {
  const configPath = resolve(path);
  return parseConfig(JSON.parse(await readFile(configPath, "utf8")), configPath);
}

export function parseConfig(input: unknown, path: string): AppConfig {
  const configPath = resolve(path);
  const data = requireRecord(input, "配置");
  if (data.schemaVersion !== 1) throw new AppError("CONFIG_VERSION", "仅支持 schemaVersion=1");
  if (data.provider !== "mock" && data.provider !== "codex") {
    throw new AppError("INVALID_CONFIG", "provider 必须是 mock 或 codex");
  }
  const storage = data.storage === undefined ? {} : requireRecord(data.storage, "storage");
  const databasePath = storage.databasePath === undefined ? "../.runtime/state.sqlite" : requireString(storage.databasePath, "storage.databasePath");
  const scheduler = data.scheduler === undefined ? {} : requireRecord(data.scheduler, "scheduler");
  const trigger = scheduler.trigger === undefined ? "available" : scheduler.trigger;
  if (trigger !== "available" && trigger !== "refresh") throw new AppError("INVALID_CONFIG", "scheduler.trigger 必须是 available 或 refresh。");
  return {
    schemaVersion: 1,
    provider: data.provider,
    pollIntervalMs: requireNumber(data.pollIntervalMs, "pollIntervalMs", 1000, 86400000),
    quotaMaxAgeMs: requireNumber(data.quotaMaxAgeMs, "quotaMaxAgeMs", 1000, 86400000),
    reservePercent: requireNumber(data.reservePercent, "reservePercent", 0, 100),
    limitId: requireString(data.limitId, "limitId"),
    tasksFile: resolve(dirname(configPath), requireString(data.tasksFile, "tasksFile")),
    codex: loadCodexOptions(data.codex, dirname(configPath)),
    storage: { databasePath: databasePath === ":memory:" ? databasePath : resolve(dirname(configPath), databasePath) },
    scheduler: { trigger },
  };
}
