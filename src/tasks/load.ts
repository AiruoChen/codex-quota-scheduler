import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { TaskDefinition } from "../domain/task.js";
import { AppError } from "../shared/errors.js";
import { requireNumber, requireRecord, requireString } from "../shared/validation.js";

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
  if (data.execution !== undefined) {
    const execution = requireRecord(data.execution, "execution");
    const sandbox = execution.sandbox ?? "read-only";
    if (sandbox !== "read-only" && sandbox !== "workspace-write") throw new AppError("INVALID_TASK", "execution.sandbox 必须是 read-only 或 workspace-write");
    task.execution = {
      sandbox,
      timeoutMs: execution.timeoutMs === undefined ? 900000 : requireNumber(execution.timeoutMs, "execution.timeoutMs", 100, 86400000),
    };
    if (execution.effort !== undefined) {
      if (!["low", "medium", "high", "xhigh"].includes(String(execution.effort))) throw new AppError("INVALID_TASK", "不支持此 reasoning effort");
      task.execution.effort = execution.effort as "low" | "medium" | "high" | "xhigh";
    }
  }
  return task;
}

export async function loadTask(path: string): Promise<TaskDefinition> {
  const filePath = resolve(path);
  return parseTask(JSON.parse(await readFile(filePath, "utf8")), dirname(filePath));
}
