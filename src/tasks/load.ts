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
    const data = requireRecord(value, `tasks[${index}]`);
    const id = requireString(data.id, "task.id");
    if (ids.has(id)) throw new AppError("DUPLICATE_TASK", `任务 ID 重复：${id}`);
    ids.add(id);
    if (typeof data.enabled !== "boolean") throw new AppError("INVALID_TASK", "enabled 必须是布尔值");
    const session = requireRecord(data.session, "session");
    if (session.mode !== "new" && session.mode !== "resume") {
      throw new AppError("INVALID_TASK", "session.mode 必须是 new 或 resume");
    }
    const task: TaskDefinition = {
      id,
      name: requireString(data.name, "task.name"),
      enabled: data.enabled,
      projectDir: resolve(dirname(filePath), requireString(data.projectDir, "projectDir")),
      promptFile: resolve(dirname(filePath), requireString(data.promptFile, "promptFile")),
      priority: requireNumber(data.priority, "priority", 0, 1000),
      session: session.mode === "new"
        ? { mode: "new" }
        : { mode: "resume", threadId: requireString(session.threadId, "threadId") },
    };
    if (data.model !== undefined) task.model = requireString(data.model, "model");
    return task;
  });
}
