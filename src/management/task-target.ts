import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createHash } from "node:crypto";
import type { AppConfig } from "../config/load.js";
import type { ExecutionEnvironment } from "../domain/catalog.js";
import { CodexCatalog } from "../adapters/codex/catalog.js";
import { AppError } from "../shared/errors.js";
import { requireRecord, requireString } from "../shared/validation.js";
import { authorizeResume } from "../adapters/codex/resume-authorization.js";

export async function resolveTaskTarget(config: AppConfig, configPath: string, input: unknown, scopeValue: unknown,
  identity: string, sandbox: unknown): Promise<{ environment: ExecutionEnvironment; threadId?: string }> {
  if (config.provider !== "codex") throw new AppError("CATALOG_REQUIRES_CODEX", "模拟模式不读取真实项目或会话；请使用本地文件夹模式练习。");
  const target = requireRecord(input, "target"), scope = requireString(scopeValue, "scope");
  if (!/^[a-f0-9]{64}$/.test(scope)) throw new AppError("CATALOG_SCOPE_CHANGED", "请重新加载目录。");
  const catalog = new CodexCatalog(config.codex);
  if (target.mode === "resume") {
    const threadId = requireString(target.threadId, "threadId"), found = await catalog.environment(threadId, scope);
    if (target.authorization === undefined) throw new AppError("CODEX_ENVIRONMENT_UNVERIFIED", found.limitation);
    if (!found.authorization) throw new AppError("CODEX_AUTHORIZATION_UNSUPPORTED", "当前无法验证续接授权策略，请刷新目录并核对 CLI 与管理策略。");
    return { environment: await authorizeResume(found.environment, found.authorization, threadId, target.authorization, sandbox ?? "read-only"), threadId };
  }
  if (!["project", "unassigned", "folder"].includes(String(target.mode))) throw new AppError("INVALID_ARGUMENT", "任务执行方式无效。");
  let cwd = typeof target.cwd === "string" ? target.cwd : "";
  const writes = target.writableRoots ?? [];
  if (!Array.isArray(writes) || writes.length > 100 || writes.some(path => typeof path !== "string")) throw new AppError("INVALID_ARGUMENT", "文件授权范围无效。");
  const projectId = target.mode === "project" ? requireString(target.projectId, "projectId") : null;
  if (!cwd) {
    if (target.mode === "folder") throw new AppError("INVALID_ARGUMENT", "本地文件夹模式需要选择工作目录。");
    if (projectId) throw new AppError("INVALID_ARGUMENT", "项目接口未标识主目录，请明确选择本次工作目录；无文件夹项目暂不支持执行。");
    cwd = resolve(dirname(configPath), "../.local/workspaces", createHash("sha256").update(identity).digest("hex"));
    await mkdir(cwd, { recursive: true });
  }
  const environment = await catalog.newEnvironment(projectId, cwd, sandbox === "workspace-write" ? writes : [], scope);
  if (sandbox === "workspace-write" && !environment.writableRoots.includes(environment.cwd)) throw new AppError("PERMISSION_SCOPE_INVALID", "当前协议的工作区写入模式包含工作目录，请明确勾选该目录；无业务文件夹时可使用只读。");
  if (target.mode === "folder") { environment.mode = "folder"; environment.projectKnown = false; environment.roots = [environment.cwd]; }
  return { environment };
}
