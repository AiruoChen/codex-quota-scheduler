import { realpath } from "node:fs/promises";
import type { ExecutionOrigin, RecoveryReader, RecoveryTarget, RemoteRecoveryResult } from "../../domain/recovery.js";
import { AppError } from "../../shared/errors.js";
import { redact } from "../../shared/redact.js";
import { isRecord } from "../../shared/validation.js";
import type { CodexOptions } from "./launcher.js";
import { codexConnectionKey } from "./connection-key.js";
import { connectCodex, readAccount } from "./session.js";
import type { StdioRpcClient } from "./rpc-client.js";

const unknown = (code: string): RemoteRecoveryResult => ({ kind: "unknown", code });
function sameAccount(left: ExecutionOrigin["account"], right: ExecutionOrigin["account"]): boolean {
  return (["type", "email", "planType", "workspaceId"] as const).every((key) => left[key] === right[key]);
}

export class CodexRecoveryReader implements RecoveryReader {
  constructor(private readonly options: CodexOptions) {}

  async read(target: RecoveryTarget, signal?: AbortSignal): Promise<RemoteRecoveryResult> {
    const { run, origin } = target;
    if (!origin) return unknown("ORIGIN_UNKNOWN");
    if (origin.connectionKey !== codexConnectionKey(this.options)) return unknown("CONNECTION_MISMATCH");
    if (!origin.account.email && !origin.account.workspaceId) return unknown("ACCOUNT_UNKNOWN");
    if (!run.threadId || !run.turnId) return unknown("TURN_ID_UNKNOWN");
    const { client } = await connectCodex(this.options, signal);
    try {
      const before = await readAccount(client, signal);
      if (!sameAccount(before, origin.account)) return unknown("ACCOUNT_MISMATCH");
      const response = await client.request("thread/read", { threadId: run.threadId, includeTurns: false }, signal);
      if (!isRecord(response) || !isRecord(response.thread) || response.thread.id !== run.threadId || typeof response.thread.cwd !== "string") return unknown("THREAD_MISMATCH");
      if (await realpath(response.thread.cwd) !== await realpath(run.taskSnapshot.projectDir)) return unknown("PROJECT_MISMATCH");
      if (isRecord(response.thread.status) && response.thread.status.type === "active") return { kind: "pending", code: "THREAD_ACTIVE" };
      let turn: Record<string, unknown> | undefined;
      try { turn = await this.findTurn(client, run.threadId, run.turnId, signal); }
      catch (error) {
        if (!(error instanceof AppError) || error.code !== "CODEX_INCOMPATIBLE") throw error;
        // Older histories may only support full legacy reads. Never infer a missing turn from the latest one.
        const legacy = await client.request("thread/read", { threadId: run.threadId, includeTurns: true }, signal);
        if (!isRecord(legacy) || !isRecord(legacy.thread) || legacy.thread.id !== run.threadId || !Array.isArray(legacy.thread.turns)) return unknown("HISTORY_UNAVAILABLE");
        turn = legacy.thread.turns.find((item: unknown) => isRecord(item) && item.id === run.turnId) as Record<string, unknown> | undefined;
      }
      if (!turn) return unknown("TURN_NOT_FOUND");
      if (turn.status === "inProgress") return { kind: "pending", code: "TURN_ACTIVE" };
      if (turn.status !== "completed" && turn.status !== "failed" && turn.status !== "interrupted") return unknown("TURN_STATUS_UNKNOWN");
      if (turn.itemsView === "notLoaded") turn = { ...turn, items: await this.turnItems(client, run.threadId, run.turnId, signal), itemsView: "full" };
      const after = await readAccount(client, signal);
      if (!sameAccount(before, after) || !sameAccount(after, origin.account)) return unknown("ACCOUNT_CHANGED");
      if (!Array.isArray(turn.items) || turn.itemsView !== undefined && turn.itemsView !== "full") return unknown("TURN_ITEMS_INCOMPLETE");
      const messages = new Map<string, { text: string; final: boolean }>();
      for (const item of turn.items) if (isRecord(item) && item.type === "agentMessage") {
        if (typeof item.id !== "string" || typeof item.text !== "string") return unknown("HISTORY_PROTOCOL_ERROR");
        messages.set(item.id, { text: item.text, final: item.phase === "final_answer" });
      }
      const all = [...messages.values()]; const final = all.filter((message) => message.final);
      const output = (final.length ? final : all).map((message) => message.text).join("\n");
      if (Buffer.byteLength(output) > 1024 * 1024) return unknown("RECOVERY_OUTPUT_LIMIT");
      const timestamp = typeof turn.completedAt === "number" ? new Date(turn.completedAt * 1000) : null;
      return { kind: "terminal", code: "TURN_CONFIRMED", turnStatus: turn.status as "completed" | "failed" | "interrupted", output: redact(output),
        completedAt: timestamp && Number.isFinite(timestamp.getTime()) ? timestamp.toISOString() : null };
    } finally { await client.close(); }
  }

  private async findTurn(client: StdioRpcClient, threadId: string, turnId: string, signal?: AbortSignal): Promise<Record<string, unknown> | undefined> {
    let cursor: string | undefined;
    const seen = new Set<string>();
    for (let page = 0; page < 20; page++) {
      const result = await client.request("thread/turns/list", { threadId, limit: 50, sortDirection: "desc", itemsView: "notLoaded", ...(cursor ? { cursor } : {}) }, signal);
      if (!isRecord(result) || !Array.isArray(result.data)) throw new AppError("HISTORY_PROTOCOL_ERROR", "回合历史格式异常。");
      const turn = result.data.find((item: unknown) => isRecord(item) && item.id === turnId);
      if (isRecord(turn)) return turn;
      if (result.nextCursor === null) return undefined;
      if (typeof result.nextCursor !== "string" || !result.nextCursor || seen.has(result.nextCursor)) throw new AppError("HISTORY_CURSOR_ERROR", "历史分页游标缺失或循环。");
      seen.add(result.nextCursor); cursor = result.nextCursor;
    }
    throw new AppError("HISTORY_PAGE_LIMIT", "已达到历史读取上限，未推断未找到回合的结果。");
  }

  private async turnItems(client: StdioRpcClient, threadId: string, turnId: string, signal?: AbortSignal): Promise<Record<string, unknown>[]> {
    let cursor: string | undefined; const seen = new Set<string>();
    const items: Record<string, unknown>[] = []; let bytes = 0;
    for (let page = 0; page < 20; page++) {
      const result = await client.request("thread/items/list", { threadId, turnId, limit: 50, sortDirection: "asc", ...(cursor ? { cursor } : {}) }, signal);
      if (!isRecord(result) || !Array.isArray(result.data)) throw new AppError("HISTORY_PROTOCOL_ERROR", "回合消息格式异常。");
      for (const entry of result.data) {
        if (!isRecord(entry) || entry.turnId !== turnId || !isRecord(entry.item)) throw new AppError("HISTORY_SCOPE_MISMATCH", "历史消息不属于目标回合。");
        if (entry.item.type !== "agentMessage") continue;
        bytes += typeof entry.item.text === "string" ? Buffer.byteLength(entry.item.text) : 0;
        if (bytes > 1024 * 1024) throw new AppError("RECOVERY_OUTPUT_LIMIT", "恢复输出超过读取上限。");
        items.push(entry.item);
      }
      if (result.nextCursor === null) return items;
      if (typeof result.nextCursor !== "string" || !result.nextCursor || seen.has(result.nextCursor)) throw new AppError("HISTORY_CURSOR_ERROR", "消息分页游标缺失或循环。");
      seen.add(result.nextCursor); cursor = result.nextCursor;
    }
    throw new AppError("HISTORY_PAGE_LIMIT", "已达到消息读取上限。");
  }
}
