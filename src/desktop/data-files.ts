import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink, lstat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { AppError } from "../shared/errors.js";

export async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}
export async function atomicDataFile(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, "wx", 0o600);
    try { await handle.writeFile(content); await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, path);
  } finally { await unlink(temporary).catch(() => {}); }
}
export async function dataLock<T>(path: string, action: () => Promise<T>): Promise<T> {
  await mkdir(dirname(path), { recursive: true });
  let handle;
  try { handle = await open(path, "wx", 0o600); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new AppError("MIGRATION_BUSY", "数据操作已锁定，请等待；异常锁须确认进程退出后人工处理。"); throw error; }
  try { await handle.writeFile(JSON.stringify({ pid: process.pid })); return await action(); }
  finally { await handle.close(); await unlink(path); }
}
export async function saveDataJson(path: string, value: unknown): Promise<void> { await atomicDataFile(path, JSON.stringify(value, null, 2) + "\n"); }

/** Reject redirections in all existing ancestors before writing private managed data. */
export async function assertDataPath(path: string): Promise<void> {
  let cursor = resolve(path);
  for (;;) {
    try { if ((await lstat(cursor)).isSymbolicLink()) throw new AppError("MIGRATION_PATH", "数据目录不能通过符号链接或目录联接重定向。"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const parent = dirname(cursor); if (parent === cursor) break; cursor = parent;
  }
}
export async function managedDirectory(path: string): Promise<void> {
  await assertDataPath(path);
  await mkdir(resolve(path), { recursive: true, mode: 0o700 });
  await assertDataPath(path);
}
export async function previousJson(path: string): Promise<unknown | null> {
  if (!await exists(path)) return null;
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch { throw new AppError("MIGRATION_STATE_INVALID", "数据管理记录损坏，请保留原文件核对有效备份。"); }
}
