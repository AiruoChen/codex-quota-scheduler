import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { CatalogPage, ModelChoice, ProjectChoice, ThreadChoice, ExecutionEnvironment } from "../../domain/catalog.js";
import type { CodexOptions } from "./launcher.js";
import { connectCodex, readAccount } from "./session.js";
import { codexConnectionKey } from "./connection-key.js";
import { hasQuotaIdentity } from "../../domain/quota-policy.js";
import { AppError } from "../../shared/errors.js";
import { isRecord, requireString } from "../../shared/validation.js";
import type { StdioRpcClient } from "./rpc-client.js";

export const catalogScope = (options: CodexOptions, account: unknown): string => createHash("sha256").update(JSON.stringify([codexConnectionKey(options), account])).digest("hex");
const text = (value: unknown) => typeof value === "string" && value.length > 0 && value.length <= 4000 ? value : null;
function project(value: unknown): ProjectChoice {
  if (!isRecord(value) || !text(value.id) || !text(value.name) || !Array.isArray(value.roots)
    || value.roots.some(root => !isRecord(root) || typeof root.path !== "string" || !isAbsolute(root.path))) throw new AppError("CODEX_PROTOCOL_ERROR", "项目目录响应不完整或当前环境不受支持。");
  return { id: String(value.id), name: String(value.name), roots: value.roots.map(root => String((root as Record<string, unknown>).path)) };
}
function thread(value: unknown): ThreadChoice {
  if (!isRecord(value) || !text(value.id) || typeof value.cwd !== "string" || !isAbsolute(value.cwd)) throw new AppError("CODEX_PROTOCOL_ERROR", "会话元数据不完整或不属于本机环境。");
  return { id: String(value.id), name: text(value.name) ?? `未命名会话 · ${String(value.id).slice(0, 8)}`,
    projectId: text(value.projectId), projectKnown: Object.hasOwn(value, "projectId") && (value.projectId === null || !!text(value.projectId)), cwd: value.cwd,
    updatedAt: typeof value.updatedAt === "number" && Number.isFinite(value.updatedAt) ? value.updatedAt : null };
}

/** Experimental opt-in is confined to these verified, read-only catalog methods. No arbitrary RPC forwarding. */
export class CodexCatalog {
  constructor(private readonly options: CodexOptions) {}
  private async read<T>(operation: (client: StdioRpcClient, scope: string) => Promise<T>, expectedScope?: string): Promise<T> {
    const { client } = await connectCodex(this.options, undefined, true);
    try {
      const before = await readAccount(client);
      if (!hasQuotaIdentity(before)) throw new AppError("ACCOUNT_UNKNOWN", "目录查询缺少可验证账户。");
      const scope = catalogScope(this.options, before);
      if (expectedScope && scope !== expectedScope) throw new AppError("CATALOG_SCOPE_CHANGED", "账户或连接已改变，请重新加载模型、项目和会话。");
      const result = await operation(client, scope);
      if (catalogScope(this.options, await readAccount(client)) !== scope) throw new AppError("CATALOG_SCOPE_CHANGED", "查询期间账户改变，请重新加载。");
      return result;
    } finally { await client.close(); }
  }
  models(cursor?: string): Promise<CatalogPage<ModelChoice>> {
    return this.read(async (client, scope) => {
      const result = await client.request("model/list", { limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) });
      if (!isRecord(result) || !Array.isArray(result.data)) throw new AppError("CODEX_PROTOCOL_ERROR", "模型列表格式无效。");
      const items: ModelChoice[] = [];
      for (const item of result.data) {
        if (!isRecord(item) || !text(item.model) || !text(item.displayName) || !Array.isArray(item.supportedReasoningEfforts)) throw new AppError("CODEX_PROTOCOL_ERROR", "模型字段不完整。");
        if (item.hidden === true) continue;
        items.push({ id: String(item.model), name: String(item.displayName), isDefault: item.isDefault === true,
          efforts: item.supportedReasoningEfforts.flatMap(e => isRecord(e) && text(e.reasoningEffort) ? [String(e.reasoningEffort)] : []) });
      }
      return { scope, items, nextCursor: text(result.nextCursor) };
    });
  }
  projects(cursor?: string): Promise<CatalogPage<ProjectChoice>> {
    return this.read(async (client, scope) => {
      const result = await client.request("project/list", { limit: 100, ...(cursor ? { cursor } : {}) });
      if (!isRecord(result) || !Array.isArray(result.data)) throw new AppError("CODEX_PROTOCOL_ERROR", "官方项目列表格式无效。");
      return { scope, items: result.data.map(project), nextCursor: text(result.nextCursor) };
    });
  }
  threads(projectId?: string, cursor?: string, expectedScope?: string): Promise<CatalogPage<ThreadChoice>> {
    return this.read(async (client, scope) => {
      const result = await client.request("thread/list", { limit: 100, sourceKinds: ["cli", "vscode", "appServer", "exec"], useStateDbOnly: true,
        ...(projectId && projectId !== "none" ? { projectId } : {}), ...(cursor ? { cursor } : {}) });
      if (!isRecord(result) || !Array.isArray(result.data)) throw new AppError("CODEX_PROTOCOL_ERROR", "会话列表格式无效。");
      const items = result.data.map(thread).filter(item => projectId === "none" ? item.projectKnown && item.projectId === null : !projectId || item.projectId === projectId);
      return { scope, items, nextCursor: text(result.nextCursor) };
    }, expectedScope);
  }
  environment(threadId: string, expectedScope?: string): Promise<{ scope: string; thread: ThreadChoice; environment: ExecutionEnvironment; limitation: string }> {
    return this.read(async (client, scope) => {
      const response = await client.request("thread/read", { threadId, includeTurns: false });
      if (!isRecord(response)) throw new AppError("CODEX_PROTOCOL_ERROR", "会话读取失败。");
      const selected = thread(response.thread);
      if (selected.id !== threadId) throw new AppError("THREAD_MISMATCH", "返回的会话标识不一致。");
      let roots: string[] = [];
      if (selected.projectId) {
        const result = await client.request("project/read", { projectId: selected.projectId });
        if (!isRecord(result)) throw new AppError("CODEX_PROTOCOL_ERROR", "项目读取失败。");
        const found = project(result.project);
        if (found.id !== selected.projectId) throw new AppError("THREAD_MISMATCH", "项目归属不一致。");
        roots = found.roots;
      }
      const cwd = await realpath(selected.cwd);
      return { scope, thread: selected, environment: { version: 1, mode: "resume", scope, connectionKey: codexConnectionKey(this.options),
        projectId: selected.projectId, projectKnown: selected.projectKnown, roots, cwd, writableRoots: [], permissionsVerified: false },
        limitation: "已读取会话实际目录和项目文件夹；当前只读协议没有完整有效权限，完整环境续接暂不可执行。" };
    }, expectedScope);
  }
  newEnvironment(projectId: string | null, cwd: string, writableRoots: string[], expectedScope: string): Promise<ExecutionEnvironment> {
    return this.read(async (client, scope) => {
      let roots: string[] = [];
      if (projectId) {
        const result = await client.request("project/read", { projectId });
        if (!isRecord(result)) throw new AppError("CODEX_PROTOCOL_ERROR", "项目读取失败。");
        const selected = project(result.project);
        if (selected.id !== projectId) throw new AppError("THREAD_MISMATCH", "项目标识不一致。");
        roots = await Promise.all(selected.roots.map(path => realpath(path)));
      }
      const actual = await realpath(requireString(cwd, "cwd"));
      if (projectId && roots.length && !roots.includes(actual)) throw new AppError("PROJECT_MISMATCH", "本次工作目录必须是所选项目明确关联的文件夹。");
      const writes = await Promise.all(writableRoots.map(path => realpath(path)));
      if (writes.some(path => !(projectId ? roots : [actual]).includes(path))) throw new AppError("PERMISSION_SCOPE_INVALID", "写入范围超出已确认文件夹。");
      return { version: 1, mode: projectId ? "project" : "unassigned", scope, connectionKey: codexConnectionKey(this.options),
        projectId, projectKnown: true, roots, cwd: actual, writableRoots: writes, permissionsVerified: true };
    }, expectedScope);
  }
}
