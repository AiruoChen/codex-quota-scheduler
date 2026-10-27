import { AppError } from "../../shared/errors.js";
import { isRecord } from "../../shared/validation.js";
import type { QuotaSnapshot } from "../../domain/quota.js";
import type { Clock } from "../../domain/ports.js";
import { detectCodex, type CodexOptions, type CodexLaunch } from "./launcher.js";
import { normalizeQuota } from "./normalize-quota.js";
import { StdioRpcClient } from "./rpc-client.js";

export async function connectCodex(options: CodexOptions, signal?: AbortSignal, experimental = false): Promise<{ client: StdioRpcClient; launch: CodexLaunch }> {
  const launch = await detectCodex(options, signal);
  const client = new StdioRpcClient(launch, options);
  try {
    const initialized = await client.request("initialize", {
      clientInfo: { name: "codex_quota_scheduler", title: "Codex Quota Scheduler", version: "0.1.0" },
      ...(experimental ? { capabilities: { experimentalApi: true } } : {}),
    }, signal);
    if (!isRecord(initialized) || typeof initialized.userAgent !== "string") throw new AppError("CODEX_INCOMPATIBLE", "Codex 初始化响应缺少 userAgent。");
    client.notify("initialized");
    return { client, launch };
  } catch (error) { await client.close(); throw error; }
}

export async function readAccount(client: StdioRpcClient, signal?: AbortSignal): Promise<NonNullable<QuotaSnapshot["account"]>> {
  const result = await client.request("account/read", { refreshToken: false }, signal);
  if (!isRecord(result) || !Object.hasOwn(result, "account")) throw new AppError("CODEX_PROTOCOL_ERROR", "Codex 账户响应缺少 account 字段。");
  if (result.account === null) throw new AppError("CODEX_AUTH_REQUIRED", "Codex 尚未登录，请使用相同 CODEX_HOME 运行 codex login 后重试。");
  const account = result.account;
  if (!isRecord(account) || typeof account.type !== "string") throw new AppError("CODEX_PROTOCOL_ERROR", "Codex 账户响应格式无效。");
  if (account.type !== "chatgpt") throw new AppError("CODEX_AUTH_UNSUPPORTED", "需要 ChatGPT 订阅登录，当前账户使用其他认证方式。");
  const text = (value: unknown): string | null => typeof value === "string" && value.length > 0 ? value : null;
  return { type: "chatgpt", email: text(account.email), planType: text(account.planType), workspaceId: text(account.workspaceId) ?? text(account.chatgptAccountId) };
}

export async function readQuota(client: StdioRpcClient, clock: Clock, version: string, signal?: AbortSignal): Promise<QuotaSnapshot> {
  const account = await readAccount(client, signal);
  const result = await client.request("account/rateLimits/read", undefined, signal);
  if (!isRecord(result) || !(Object.hasOwn(result, "rateLimits") || Object.hasOwn(result, "rateLimitsByLimitId"))) {
    throw new AppError("CODEX_PROTOCOL_ERROR", "Codex 额度响应缺少额度字段。");
  }
  return { ...normalizeQuota(result, clock.now(), "codex"), account, cli: { version } };
}
