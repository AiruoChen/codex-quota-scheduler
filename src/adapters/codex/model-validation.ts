import type { TaskDefinition } from "../../domain/task.js";
import { AppError } from "../../shared/errors.js";
import { isRecord } from "../../shared/validation.js";
import type { StdioRpcClient } from "./rpc-client.js";

/** Validate exact wire IDs; an unavailable selected model is never replaced by another. */
export async function validateModel(client: StdioRpcClient, task: TaskDefinition, signal: AbortSignal): Promise<void> {
  if (!task.model) return;
  let cursor: string | undefined; const seen = new Set<string>();
  do {
    const result = await client.request("model/list", { limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) }, signal);
    if (!isRecord(result) || !Array.isArray(result.data)) throw new AppError("CODEX_PROTOCOL_ERROR", "模型目录格式无效，未发送任务。");
    const model = result.data.find(value => isRecord(value) && value.model === task.model && value.hidden !== true);
    if (isRecord(model)) {
      const effort = task.execution?.effort;
      if (effort && (!Array.isArray(model.supportedReasoningEfforts) || !model.supportedReasoningEfforts.some(value => isRecord(value) && value.reasoningEffort === effort))) throw new AppError("MODEL_EFFORT_UNAVAILABLE", "当前模型不支持所选推理强度，未发送任务。");
      return;
    }
    cursor = typeof result.nextCursor === "string" && result.nextCursor ? result.nextCursor : undefined;
    if (cursor && (seen.has(cursor) || seen.size >= 50)) throw new AppError("CODEX_PROTOCOL_ERROR", "模型目录分页无效。");
    if (cursor) seen.add(cursor);
  } while (cursor);
  throw new AppError("MODEL_UNAVAILABLE", "所选模型不在当前账户可用目录中，请重新选择；未发送任务。");
}
