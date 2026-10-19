import type { TaskExecutor } from "../domain/ports.js";
import type { TaskDefinition, TaskRun } from "../domain/task.js";
import { AppError } from "../shared/errors.js";

export class CodexExecutor implements TaskExecutor {
  async execute(_task: TaskDefinition, _prompt: string, _signal: AbortSignal): Promise<TaskRun> {
    throw new AppError("NOT_IMPLEMENTED", "真实执行器尚未实现；当前框架仅提供调度预览。");
  }
}
