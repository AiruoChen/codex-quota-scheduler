import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { delimiter, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { AppError } from "../../shared/errors.js";

export interface CodexOptions {
  executable: string;
  /** Arguments preceding --version / app-server, e.g. a Node-based launcher. */
  args: string[];
  home?: string;
  requestTimeoutMs: number;
  shutdownTimeoutMs: number;
}

export interface CodexLaunch {
  executable: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  version: string;
}

export const defaultCodexOptions: CodexOptions = {
  executable: "codex",
  args: [],
  requestTimeoutMs: 15000,
  shutdownTimeoutMs: 1000,
};

async function runnable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/** Resolve PATH without involving a shell, including the standard npm Windows shim. */
export async function resolveCodexExecutable(command: string): Promise<{ executable: string; args: string[] }> {
  const hasPath = isAbsolute(command) || /[\\/]/.test(command);
  const extensions = process.platform === "win32" && extname(command) === "" ? [".exe", ".cmd", ".ps1", ""] : [""];
  const dirs = hasPath ? [""] : (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  let unsupportedShim = false;
  for (const dir of dirs) {
    for (const extension of extensions) {
      const candidate = hasPath ? resolve(command + extension) : resolve(dir, command + extension);
      if (!await runnable(candidate)) continue;
      if (/\.(cmd|bat|ps1)$/i.test(candidate)) {
        // The official npm shim has this sibling entry. Never execute arbitrary shell text.
        const entry = join(dirname(candidate), "node_modules", "@openai", "codex", "bin", "codex.js");
        if (await runnable(entry)) return { executable: process.execPath, args: [entry] };
        unsupportedShim = true;
        continue;
      }
      return { executable: candidate, args: [] };
    }
  }
  throw new AppError(unsupportedShim ? "CODEX_LAUNCHER_UNSUPPORTED" : "CODEX_NOT_FOUND", unsupportedShim
    ? "无法解析此脚本启动器。请在 codex.executable 指定原生 Codex 可执行文件或标准 npm 安装入口。"
    : "找不到 Codex CLI。请安装 Codex 并加入 PATH，或设置 codex.executable。");
}

export async function detectCodex(options: CodexOptions): Promise<CodexLaunch> {
  const resolved = await resolveCodexExecutable(options.executable);
  const args = [...resolved.args, ...options.args];
  const env = { ...process.env, ...(options.home === undefined ? {} : { CODEX_HOME: options.home }) };
  let stdout: string;
  try {
    ({ stdout } = await promisify(execFile)(resolved.executable, [...args, "--version"], {
      env, timeout: options.requestTimeoutMs, windowsHide: true, maxBuffer: 65536, encoding: "utf8",
    }));
  } catch (error: unknown) {
    const info = error as NodeJS.ErrnoException & { killed?: boolean };
    if (info.killed) throw new AppError("CODEX_TIMEOUT", "Codex 版本检查超时，请检查启动器或调整 requestTimeoutMs。");
    throw new AppError("CODEX_START_FAILED", "Codex 版本检查失败，请检查可执行文件及运行权限。");
  }
  const version = /^codex-cli\s+(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)/m.exec(stdout)?.[1];
  if (!version) throw new AppError("CODEX_INCOMPATIBLE", "启动器未返回可识别的 codex-cli 版本。");
  return { executable: resolved.executable, args, env, version };
}
