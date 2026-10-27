import { readFile } from "node:fs/promises";
import { dirname, resolve, isAbsolute } from "node:path";
import type { TaskDefinition } from "../domain/task.js";
import { AppError } from "../shared/errors.js";
import { requireNumber, requireRecord, requireString } from "../shared/validation.js";
import { hasResumeAuthorization, isResumeAuthorization } from "../domain/resume-authorization.js";

export async function loadTasks(path: string): Promise<TaskDefinition[]> {
  const filePath = resolve(path);
  const input: unknown = JSON.parse(await readFile(filePath, "utf8"));
  if (!Array.isArray(input)) throw new AppError("INVALID_TASKS", "任务文件必须是数组");
  const ids = new Set<string>();
  return input.map((value: unknown, index: number) => {
    const task = parseTask(value, dirname(filePath), `tasks[${index}]`);
    if (ids.has(task.id)) throw new AppError("DUPLICATE_TASK", `任务 ID 重复：${task.id}`);
    ids.add(task.id);
    return task;
  });
}

export function parseTask(value: unknown, base: string, label = "task"): TaskDefinition {
  const data = requireRecord(value, label);
  const id = requireString(data.id, "task.id");
  if (typeof data.enabled !== "boolean") throw new AppError("INVALID_TASK", "enabled 必须是布尔值");
  const session = requireRecord(data.session, "session");
  if (session.mode !== "new" && session.mode !== "resume") {
    throw new AppError("INVALID_TASK", "session.mode 必须是 new 或 resume");
  }
  const task: TaskDefinition = {
    id,
    name: requireString(data.name, "task.name"),
    enabled: data.enabled,
    projectDir: resolve(base, requireString(data.projectDir, "projectDir")),
    promptFile: resolve(base, requireString(data.promptFile, "promptFile")),
    priority: requireNumber(data.priority, "priority", 0, 1000),
    session: session.mode === "new"
      ? { mode: "new" }
      : { mode: "resume", threadId: requireString(session.threadId, "threadId") },
  };
  if (data.model !== undefined) task.model = requireString(data.model, "model");
  if (data.environment !== undefined) {
    const env = requireRecord(data.environment, "environment");
    if (env.version !== 1 || !["folder", "project", "unassigned", "resume"].includes(String(env.mode))
      || typeof env.scope !== "string" || !/^[a-f0-9]{64}$/.test(env.scope) || typeof env.connectionKey !== "string" || !/^[a-f0-9]{64}$/.test(env.connectionKey)
      || !(env.projectId === null || typeof env.projectId === "string") || typeof env.projectKnown !== "boolean"
      || typeof env.permissionsVerified !== "boolean" || env.cwd !== task.projectDir
      || ![env.roots, env.writableRoots].every(paths => Array.isArray(paths) && paths.length <= 100 && paths.every(path => typeof path === "string" && isAbsolute(path)))) {
      throw new AppError("INVALID_TASK", "执行环境快照无效。");
    }
    task.environment = { version: 1, mode: env.mode as NonNullable<TaskDefinition["environment"]>["mode"], scope: env.scope, connectionKey: env.connectionKey,
      projectId: env.projectId, projectKnown: env.projectKnown, roots: [...env.roots as string[]], cwd: task.projectDir,
      writableRoots: [...env.writableRoots as string[]], permissionsVerified: env.permissionsVerified };
    if (env.resumeAuthorization !== undefined) {
      if (!isResumeAuthorization(env.resumeAuthorization)) throw new AppError("INVALID_TASK", "续接授权快照无效。");
      const grant = env.resumeAuthorization;
      task.environment.resumeAuthorization = { version: 1, threadId: grant.threadId, context: grant.context, cliVersion: grant.cliVersion,
        sandbox: grant.sandbox, readScope: "local-files", networkAccess: false, approvalPolicy: "on-request", approvalsReviewer: "user" };
    }
  }
  if (data.quotaContinuation !== undefined) {
    const policy = requireRecord(data.quotaContinuation, "quotaContinuation");
    if (typeof policy.enabled !== "boolean" || !Number.isSafeInteger(policy.maxAttempts) || Number(policy.maxAttempts) < 0 || Number(policy.maxAttempts) > 20) throw new AppError("INVALID_TASK", "自动继续次数必须为 0～20 的整数。");
    task.quotaContinuation = { enabled: policy.enabled, maxAttempts: Number(policy.maxAttempts) };
  }
  if (data.execution !== undefined) {
    const execution = requireRecord(data.execution, "execution");
    const sandbox = execution.sandbox ?? "read-only";
    if (sandbox !== "read-only" && sandbox !== "workspace-write") throw new AppError("INVALID_TASK", "execution.sandbox 必须是 read-only 或 workspace-write");
    task.execution = {
      sandbox,
      timeoutMs: execution.timeoutMs === undefined ? 900000 : requireNumber(execution.timeoutMs, "execution.timeoutMs", 100, 86400000),
    };
    if (execution.effort !== undefined) {
      if (!["none", "minimal", "low", "medium", "high", "xhigh"].includes(String(execution.effort))) throw new AppError("INVALID_TASK", "不支持此 reasoning effort");
      task.execution.effort = execution.effort as "low" | "medium" | "high" | "xhigh";
    }
  }
  if (task.environment?.resumeAuthorization && !hasResumeAuthorization(task)) throw new AppError("INVALID_TASK", "续接授权与会话或文件权限不一致。");
  return task;
}

export async function loadTask(path: string): Promise<TaskDefinition> {
  const filePath = resolve(path);
  return parseTask(JSON.parse(await readFile(filePath, "utf8")), dirname(filePath));
}
