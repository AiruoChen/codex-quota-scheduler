import type { DesktopFeed, FeedRequest } from "../../domain/notifications.js";
import { noticeKinds } from "../../domain/notifications.js";
import { isRecord } from "../../shared/validation.js";
import { AppError } from "../../shared/errors.js";
import type { RuntimeRecord } from "../../runtime/instance.js";

const count = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0;
export function readFeedRequest(params: URLSearchParams): FeedRequest {
  const scope = params.get("scope");
  if (scope !== null && !/^[a-f0-9]{64}$/.test(scope)) throw new AppError("INVALID_ARGUMENT", "通知来源标识无效。");
  const cursor = { execution: Number(params.get("execution") ?? 0), recovery: Number(params.get("recovery") ?? 0), quota: Number(params.get("quota") ?? 0) };
  if (!Object.values(cursor).every(count)) throw new AppError("INVALID_ARGUMENT", "通知检查点无效。");
  return { scope, cursor: scope === null ? null : cursor };
}

export function readDesktopFeed(value: unknown): DesktopFeed {
  function invalid(): never { throw new AppError("RUNTIME_INCOMPATIBLE", "后台通知协议不可验证，请核对服务版本。"); }
  if (!isRecord(value) || typeof value.scope !== "string" || !/^[a-f0-9]{64}$/.test(value.scope)
    || !["mock", "codex"].includes(String(value.provider))
    || !isRecord(value.cursor) || ![value.cursor.execution, value.cursor.recovery, value.cursor.quota].every(count)
    || typeof value.baseline !== "boolean" || typeof value.pendingAttention !== "boolean" || !Array.isArray(value.events) || value.events.length > 384) invalid();
  for (const event of value.events) {
    if (!isRecord(event) || typeof event.key !== "string" || !/^[a-f0-9]{64}$/.test(event.key)
      || !noticeKinds.includes(event.kind as typeof noticeKinds[number]) || !["overview", "runs", "recovery", "schedules"].includes(String(event.target))
      || !(event.runId === null || typeof event.runId === "string" && event.runId.length > 0 && event.runId.length <= 200)
      || typeof event.createdAt !== "string" || !Number.isFinite(Date.parse(event.createdAt))) invalid();
  }
  if (value.monitor !== null && (!isRecord(value.monitor) || !count(value.monitor.failures)
    || !(value.monitor.errorCode === null || typeof value.monitor.errorCode === "string" && /^[A-Z_]{1,64}$/.test(value.monitor.errorCode)))) invalid();
  return { provider: value.provider as DesktopFeed["provider"], scope: value.scope,
    cursor: { execution: Number(value.cursor.execution), recovery: Number(value.cursor.recovery), quota: Number(value.cursor.quota) }, baseline: value.baseline, pendingAttention: value.pendingAttention,
    monitor: value.monitor ? { failures: Number(value.monitor.failures), errorCode: value.monitor.errorCode as string | null } : null,
    events: value.events.map((event) => { const { key, kind, runId, target, createdAt } = event as DesktopFeed["events"][number]; return { key, kind, runId, target, createdAt }; }) };
}

export async function desktopRequest(record: RuntimeRecord, action: "feed" | "pause", request?: FeedRequest): Promise<DesktopFeed | null> {
  if (!record.url) throw new AppError("RUNTIME_STARTING", "后台未就绪。");
  const params = new URLSearchParams();
  if (request?.scope && request.cursor) {
    params.set("scope", request.scope);
    for (const [key, value] of Object.entries(request.cursor)) params.set(key, String(value));
  }
  const response = await fetch(record.url + (action === "feed" ? `/api/runtime/desktop?${params}` : "/api/runtime/pause"), {
    method: action === "feed" ? "GET" : "POST", redirect: "error", signal: AbortSignal.timeout(3000),
    headers: { Authorization: `Bearer ${record.token}`, "X-Runtime-Instance": record.instance },
  });
  if (!response.ok) throw new AppError(response.status === 404 ? "RUNTIME_INCOMPATIBLE" : "RUNTIME_UNREACHABLE", "后台桌面接口不可用。");
  const value: unknown = await response.json();
  if (!isRecord(value) || value.instance !== record.instance || value.pid !== record.pid) throw new AppError("RUNTIME_INSTANCE_CHANGED", "后台身份已变化。");
  return action === "feed" ? readDesktopFeed(value.feed) : null;
}
