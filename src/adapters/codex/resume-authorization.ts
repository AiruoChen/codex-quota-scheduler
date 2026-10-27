import { createHash } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { ExecutionEnvironment, ResumeAuthorizationPreview } from "../../domain/catalog.js";
import type { TaskDefinition } from "../../domain/task.js";
import { hasResumeAuthorization } from "../../domain/resume-authorization.js";
import { AppError } from "../../shared/errors.js";
import { isRecord } from "../../shared/validation.js";
import type { StdioRpcClient } from "./rpc-client.js";

type Sandbox = "read-only" | "workspace-write";
export async function resumeRequirements(client: StdioRpcClient, signal?: AbortSignal): Promise<Sandbox[]> {
  const result = await client.request("configRequirements/read", {}, signal);
  if (!isRecord(result) || !(result.requirements === null || isRecord(result.requirements))) throw new AppError("CODEX_AUTHORIZATION_UNSUPPORTED", "无法确认当前管理策略，不能建立续接授权。");
  const rules = result.requirements;
  if (rules === null) return ["read-only", "workspace-write"];
  if (rules.allowedPermissionProfiles != null) throw new AppError("CODEX_AUTHORIZATION_UNSUPPORTED", "当前管理策略要求命名权限配置，此客户端暂不能验证其完整范围。");
  const permits = (key: string, value: string) => {
    const list = rules[key];
    if (list == null) return true;
    if (!Array.isArray(list) || list.length > 100) throw new AppError("CODEX_AUTHORIZATION_UNSUPPORTED", "管理策略格式不受支持。");
    return list.includes(value);
  };
  if (!permits("allowedApprovalPolicies", "on-request") || !permits("allowedApprovalsReviewers", "user")) throw new AppError("CODEX_AUTHORIZATION_DENIED", "当前管理策略不允许所需的人工审批方式。");
  return (["read-only", "workspace-write"] as const).filter(mode => permits("allowedSandboxModes", mode));
}

export function resumePreview(scope: string, threadId: string, environment: ExecutionEnvironment, candidates: string[],
  cliVersion: string, allowedSandboxes: Sandbox[]): ResumeAuthorizationPreview {
  const writableCandidates = [...new Set([environment.cwd, ...candidates])].sort();
  const context = createHash("sha256").update(JSON.stringify([scope, threadId, environment, writableCandidates, cliVersion, allowedSandboxes])).digest("hex");
  return { context, cliVersion, writableCandidates, allowedSandboxes, readScope: "local-files" };
}

export async function authorizeResume(environment: ExecutionEnvironment, preview: ResumeAuthorizationPreview, threadId: string,
  input: unknown, sandbox: unknown): Promise<ExecutionEnvironment> {
  if (!isRecord(input) || input.confirmed !== true || input.readAllLocalFiles !== true) throw new AppError("CODEX_AUTHORIZATION_REQUIRED", "请明确确认本次续接授权及本机文件读取范围。");
  if (input.context !== preview.context) throw new AppError("CODEX_AUTHORIZATION_CHANGED", "会话、目录、CLI 或管理策略已变化，请重新读取并确认授权。");
  if (sandbox !== "read-only" && sandbox !== "workspace-write" || !preview.allowedSandboxes.includes(sandbox)) throw new AppError("CODEX_AUTHORIZATION_DENIED", "所选文件权限不符合当前管理策略。");
  if (!Array.isArray(input.writableRoots) || input.writableRoots.length > 100 || input.writableRoots.some(path => typeof path !== "string" || !isAbsolute(path))) throw new AppError("PERMISSION_SCOPE_INVALID", "请从已读取的文件夹中明确选择可写范围。");
  const writableRoots = [...new Set(await Promise.all(input.writableRoots.map(async (path: string) => {
    if (!preview.writableCandidates.includes(path) || !(await stat(path)).isDirectory()) throw new AppError("PERMISSION_SCOPE_INVALID", "可写文件夹不在已确认的候选范围。");
    const canonical = await realpath(path);
    if (canonical !== path) throw new AppError("CODEX_AUTHORIZATION_CHANGED", "文件夹定位已变化，请重新读取授权范围。");
    return canonical;
  })))].sort();
  if (sandbox === "read-only" ? writableRoots.length !== 0 : !writableRoots.includes(environment.cwd)) throw new AppError("PERMISSION_SCOPE_INVALID", "只读模式不能授权写入；写入模式须明确包含会话实际工作目录。");
  return { ...environment, writableRoots, resumeAuthorization: { version: 1, threadId, context: preview.context, cliVersion: preview.cliVersion,
    sandbox, readScope: "local-files", networkAccess: false, approvalPolicy: "on-request", approvalsReviewer: "user" } };
}

export const resumeWorkspaceRoots = (task: TaskDefinition) => task.execution?.sandbox === "workspace-write" ? task.environment!.writableRoots : [task.projectDir];
export function resumeConfig(task: TaskDefinition): Record<string, unknown> {
  return { "sandbox_workspace_write.writable_roots": task.environment!.writableRoots, "sandbox_workspace_write.network_access": false,
    "sandbox_workspace_write.exclude_slash_tmp": true, "sandbox_workspace_write.exclude_tmpdir_env_var": true };
}

/** Verify effective legacy response before sending any prompt. Unknown profiles/fields fail closed. */
export async function verifyResumedAuthorization(response: Record<string, unknown>, task: TaskDefinition): Promise<void> {
  const fail = () => { throw new AppError("CODEX_AUTHORIZATION_MISMATCH", "服务端实际权限与本次授权不一致，未发送指令；请核对会话状态后重新授权。"); };
  if (!hasResumeAuthorization(task) || response.approvalPolicy !== "on-request" || response.approvalsReviewer !== "user"
    || typeof response.cwd !== "string" || await realpath(response.cwd) !== task.projectDir || !isRecord(response.sandbox)
    || !Array.isArray(response.runtimeWorkspaceRoots)) return fail();
  const policy = response.sandbox, writes = task.environment!.writableRoots;
  const paths = async (value: unknown): Promise<string[]> => {
    if (!Array.isArray(value) || value.length > 100 || value.some(path => typeof path !== "string" || !isAbsolute(path))) return fail();
    return [...new Set(await Promise.all(value.map(path => realpath(String(path)))))].sort();
  };
  const same = (a: string[], b: string[]) => JSON.stringify([...new Set(a)].sort()) === JSON.stringify([...new Set(b)].sort());
  if (!same(await paths(response.runtimeWorkspaceRoots), resumeWorkspaceRoots(task))) return fail();
  if (policy.networkAccess !== false && policy.networkAccess !== undefined) return fail();
  if (task.execution?.sandbox === "workspace-write") {
    if (policy.type !== "workspaceWrite" || policy.excludeSlashTmp !== true || policy.excludeTmpdirEnvVar !== true
      || Object.keys(policy).some(key => !["type", "networkAccess", "excludeSlashTmp", "excludeTmpdirEnvVar", "writableRoots"].includes(key))) return fail();
    // cwd is also writable under this protocol even if not repeated in writableRoots.
    if (!same([...await paths(policy.writableRoots ?? []), task.projectDir], writes)) return fail();
  } else if (policy.type !== "readOnly" || Object.keys(policy).some(key => !["type", "networkAccess"].includes(key))) return fail();
}
