import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { CatalogPage, ModelChoice, ProjectChoice, ThreadChoice, ExecutionEnvironment, ResumeAuthorizationPreview } from "../../domain/catalog.js";
import type { CodexOptions } from "./launcher.js";
import { connectCodex, readAccount } from "./session.js";
import { codexConnectionKey } from "./connection-key.js";
import { hasQuotaIdentity } from "../../domain/quota-policy.js";
import { AppError } from "../../shared/errors.js";
import { isRecord, requireString } from "../../shared/validation.js";
import type { StdioRpcClient } from "./rpc-client.js";
import { readSidebarState, type SidebarReader, type SidebarState } from "./sidebar-state.js";
import { bindSidebarProject, displayedProject, readSidebarCursor, sidebarCursor } from "./sidebar-projects.js";
import { resumePreview, resumeRequirements } from "./resume-authorization.js";

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
  constructor(private readonly options: CodexOptions, private readonly sidebar: SidebarReader = readSidebarState) {}
  private async verifySidebar(before: SidebarState): Promise<void> {
    const after = await this.sidebar(this.options);
    if (before.status !== after.status || before.status === "ready" && (after.status !== "ready" || before.snapshot.revision !== after.snapshot.revision)) {
      throw new AppError("CATALOG_CHANGED", "桌面项目关联在读取期间发生变化，请重新加载目录。");
    }
  }
  private async liveProjects(client: StdioRpcClient): Promise<Set<string>> {
    const ids = new Set<string>(), seen = new Set<string>(); let cursor: string | null = null;
    do {
      const result = await client.request("project/list", { limit: 100, ...(cursor ? { cursor } : {}) });
      if (!isRecord(result) || !Array.isArray(result.data)) throw new AppError("CODEX_PROTOCOL_ERROR", "项目关联核对响应无效。");
      for (const value of result.data) ids.add(project(value).id);
      cursor = text(result.nextCursor);
      if (cursor && (seen.has(cursor) || seen.size >= 50)) throw new AppError("CODEX_PROTOCOL_ERROR", "项目关联分页未推进。");
      if (cursor) seen.add(cursor);
    } while (cursor);
    return ids;
  }
  private async read<T>(operation: (client: StdioRpcClient, scope: string, cliVersion: string) => Promise<T>, expectedScope?: string): Promise<T> {
    const { client, launch } = await connectCodex(this.options, undefined, true);
    try {
      const before = await readAccount(client);
      if (!hasQuotaIdentity(before)) throw new AppError("ACCOUNT_UNKNOWN", "目录查询缺少可验证账户。");
      const scope = catalogScope(this.options, before);
      if (expectedScope && scope !== expectedScope) throw new AppError("CATALOG_SCOPE_CHANGED", "账户或连接已改变，请重新加载模型、项目和会话。");
      const result = await operation(client, scope, launch.version);
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
      const state = await this.sidebar(this.options);
      let after = cursor;
      if (state.status === "ready") after = cursor ? readSidebarCursor(cursor, scope, projectId, state.snapshot.revision) : undefined;
      else if (cursor?.startsWith("sidebar-v1:")) throw new AppError("CATALOG_CHANGED", "桌面项目关联已变化，请重新读取第一页。");
      const live = state.status === "ready" ? await this.liveProjects(client) : new Set<string>();
      const seen = new Set<string>();
      let items: ThreadChoice[] = [], next: string | null = null;
      // Legacy membership is absent from the server filter. Scan empty pages with a fixed bound, preserving its opaque cursor.
      for (let page = 0; page < 10; page++) {
        const result = await client.request("thread/list", { limit: 100, sourceKinds: ["cli", "vscode", "appServer", "exec"], useStateDbOnly: true,
          ...(state.status !== "ready" && projectId ? { projectId: projectId === "none" ? null : projectId } : {}), ...(after ? { cursor: after } : {}) });
        if (!isRecord(result) || !Array.isArray(result.data)) throw new AppError("CODEX_PROTOCOL_ERROR", "会话列表格式无效。");
        const current = result.data.map(thread).map(item => state.status === "ready" ? bindSidebarProject(item, state.snapshot, live) : item);
        items = current.filter(item => !projectId || displayedProject(item) === (projectId === "none" ? null : projectId));
        next = text(result.nextCursor);
        if (next && (next === after || seen.has(next))) throw new AppError("CODEX_PROTOCOL_ERROR", "会话分页未推进，请重新读取。");
        if (next) seen.add(next);
        if (items.length || !next || !projectId || state.status !== "ready") break;
        after = next;
      }
      await this.verifySidebar(state);
      return { scope, items, nextCursor: next && state.status === "ready" ? sidebarCursor(next, scope, projectId, state.snapshot.revision) : next, desktopStatus: state.status };
    }, expectedScope);
  }
  environment(threadId: string, expectedScope?: string): Promise<{ scope: string; thread: ThreadChoice; environment: ExecutionEnvironment; limitation: string; sidebarProject?: ProjectChoice; authorization?: ResumeAuthorizationPreview }> {
    return this.read(async (client, scope, cliVersion) => {
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
      const state = await this.sidebar(this.options);
      const enriched = state.status === "ready" ? bindSidebarProject(selected, state.snapshot, await this.liveProjects(client)) : selected;
      let sidebarProject: ProjectChoice | undefined;
      if (enriched.projectBinding?.source === "desktop_state" && enriched.projectBinding.status === "assigned" && enriched.projectBinding.projectId) {
        const result = await client.request("project/read", { projectId: enriched.projectBinding.projectId });
        if (!isRecord(result)) throw new AppError("CODEX_PROTOCOL_ERROR", "桌面关联项目读取失败。");
        sidebarProject = project(result.project);
        if (sidebarProject.id !== enriched.projectBinding.projectId) throw new AppError("THREAD_MISMATCH", "桌面关联项目标识不一致。");
      }
      await this.verifySidebar(state);
      const environment: ExecutionEnvironment = { version: 1, mode: "resume", scope, connectionKey: codexConnectionKey(this.options),
        projectId: selected.projectId, projectKnown: selected.projectKnown, roots, cwd, writableRoots: [], permissionsVerified: false };
      let authorization: ResumeAuthorizationPreview | undefined;
      try {
        const candidates = await Promise.all((sidebarProject?.roots ?? roots).map(path => realpath(path).catch(() => null)));
        authorization = resumePreview(scope, threadId, environment, candidates.filter((path): path is string => path !== null), cliVersion, await resumeRequirements(client));
      } catch { /* Metadata remains readable when explicit authorization cannot be verified. */ }
      return { scope, thread: enriched, ...(sidebarProject ? { sidebarProject } : {}), environment, ...(authorization ? { authorization } : {}),
        limitation: authorization ? "原会话完整权限尚未继承；可在下方为本任务明确授权。网络关闭，审批请求不会自动同意。"
          : "已读取会话目录，但当前无法验证可用授权策略；请核对 CLI 与管理策略后刷新。" };
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
