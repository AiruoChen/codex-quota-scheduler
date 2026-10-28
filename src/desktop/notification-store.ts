import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { emptyCheckpoint, noticeKinds, type NotificationCheckpoint, type NoticeEvent } from "../domain/notifications.js";
import { AppError } from "../shared/errors.js";
import { isRecord } from "../shared/validation.js";

export type Delivery = "disabled" | "attempted" | "unsupported" | "failed" | "local";
export interface StoredNotice extends NoticeEvent { id: string; scope: string | null; delivery: Delivery; provider: "mock" | "codex" | null }
export interface DesktopState {
  version: 1; revision: number; settings: { enabled: boolean; quotaReset: boolean; closeExplained: boolean };
  checkpoint: NotificationCheckpoint; history: StoredNotice[];
  provider: "mock" | "codex" | null;
}
const count = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0;
const scope = (value: unknown) => value === null || typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
export function readDesktopState(input: unknown): DesktopState {
  function invalid(): never { throw new AppError("DESKTOP_STATE_INVALID", "桌面通知状态损坏，请保留原文件并检查有效备份。"); }
  if (!isRecord(input) || input.version !== 1 || ![null, "mock", "codex"].includes(input.provider as null) || !count(input.revision) || !isRecord(input.settings) || !isRecord(input.checkpoint)
    || !Array.isArray(input.history) || input.history.length > 50) invalid();
  const settings = input.settings, checkpoint = input.checkpoint;
  if (![settings.enabled, settings.quotaReset, settings.closeExplained].every((item) => typeof item === "boolean")
    || !scope(checkpoint.scope) || !(checkpoint.cursor === null || isRecord(checkpoint.cursor)
      && [checkpoint.cursor.execution, checkpoint.cursor.recovery, checkpoint.cursor.quota].every(count))
    || !Array.isArray(checkpoint.seen) || checkpoint.seen.length > 512 || !checkpoint.seen.every((key) => typeof key === "string" && key.length <= 256)
    || !count(checkpoint.serviceFailures) || Number(checkpoint.serviceFailures) > 3 || typeof checkpoint.serviceAlerted !== "boolean"
    || ![null, "auth", "query"].includes(checkpoint.monitorFault as null) || !count(checkpoint.cycle)) invalid();
  for (const event of input.history) {
    if (!isRecord(event) || typeof event.id !== "string" || !/^[a-f0-9-]{36}$/.test(event.id) || !scope(event.scope)
      || ![null, "mock", "codex"].includes(event.provider as null)
      || typeof event.key !== "string" || event.key.length > 256 || !noticeKinds.includes(event.kind as typeof noticeKinds[number])
      || !["overview", "runs", "recovery", "schedules"].includes(String(event.target)) || !(event.runId === null || typeof event.runId === "string" && event.runId.length > 0 && event.runId.length <= 200)
      || typeof event.createdAt !== "string" || !Number.isFinite(Date.parse(event.createdAt)) || !["disabled", "attempted", "unsupported", "failed", "local"].includes(String(event.delivery))) invalid();
  }
  return input as unknown as DesktopState;
}
const initial = (): DesktopState => ({ version: 1, revision: 0, provider: null, settings: { enabled: true, quotaReset: false, closeExplained: false }, checkpoint: emptyCheckpoint(), history: [] });

async function atomic(path: string, text: string) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, "wx", 0o600);
    try { await handle.writeFile(text); await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, path);
  } finally { await unlink(temporary).catch(() => {}); }
}

/** Preferences, cursor, dedupe keys and notification history commit in one atomic replacement. */
export class NotificationStore {
  private pending: Promise<unknown> = Promise.resolve();
  constructor(readonly path: string) {}
  async load(): Promise<DesktopState> {
    const text = await readFile(this.path, "utf8");
    try { return readDesktopState(JSON.parse(text)); }
    catch (error) { if (error instanceof AppError) throw error; throw new AppError("DESKTOP_STATE_INVALID", "桌面通知状态损坏，请保留原文件并检查有效备份。"); }
  }
  private async locked<T>(work: () => Promise<T>): Promise<T> {
    await mkdir(dirname(this.path), { recursive: true });
    let handle;
    try { handle = await open(this.path + ".lock", "wx", 0o600); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new AppError("DESKTOP_STATE_BUSY", "桌面状态正在被其他写入操作锁定。"); throw error; }
    try { await handle.writeFile(JSON.stringify({ pid: process.pid })); return await work(); }
    finally { await handle.close(); await unlink(this.path + ".lock"); }
  }
  async initialize(): Promise<DesktopState> {
    return this.locked(async () => {
      try { return await this.load(); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        const state = initial(); await atomic(this.path, JSON.stringify(state)); return state;
      }
    });
  }
  update(change: (state: DesktopState) => void): Promise<DesktopState> {
    const result = this.pending.then(() => this.locked(async () => {
      const state = await this.load(), previous = JSON.stringify(state);
      change(state); if (JSON.stringify(state) === previous) return state;
      state.revision++; readDesktopState(state);
      await atomic(this.path + ".bak", previous); await atomic(this.path, JSON.stringify(state)); return state;
    }));
    this.pending = result.catch(() => {}); return result;
  }
  async settled(): Promise<void> { await this.pending; }
}
