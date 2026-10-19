import { systemClock, type Clock } from "../../domain/ports.js";
import type { QuotaProvider, QuotaSnapshot } from "../../domain/quota.js";
import { AppError } from "../../shared/errors.js";
import { isRecord } from "../../shared/validation.js";
import { defaultCodexOptions, detectCodex, type CodexOptions } from "./launcher.js";
import { normalizeQuota } from "./normalize-quota.js";
import { StdioRpcClient } from "./rpc-client.js";

export class AppServerQuotaProvider implements QuotaProvider {
  constructor(private readonly options: CodexOptions = defaultCodexOptions, private readonly clock: Clock = systemClock) {}

  async read(): Promise<QuotaSnapshot> {
    const launch = await detectCodex(this.options);
    const client = new StdioRpcClient(launch, this.options);
    try {
      const initialized = await client.request("initialize", {
        clientInfo: { name: "codex_quota_scheduler", title: "Codex Quota Scheduler", version: "0.1.0" },
      });
      if (!isRecord(initialized) || typeof initialized.userAgent !== "string") {
        throw new AppError("CODEX_INCOMPATIBLE", "Codex 初始化响应缺少 userAgent，请检查 CLI 版本。");
      }
      client.notify("initialized");
      const accountResult = await client.request("account/read", { refreshToken: false });
      if (!isRecord(accountResult) || !Object.hasOwn(accountResult, "account")) {
        throw new AppError("CODEX_PROTOCOL_ERROR", "Codex 账户响应缺少 account 字段。");
      }
      const account = accountResult.account;
      if (account === null) {
        throw new AppError("CODEX_AUTH_REQUIRED", "Codex 尚未登录，请使用相同 CODEX_HOME 运行 codex login 后重试。");
      }
      if (!isRecord(account) || typeof account.type !== "string") {
        throw new AppError("CODEX_PROTOCOL_ERROR", "Codex 账户响应格式无效。");
      }
      if (account.type !== "chatgpt") {
        throw new AppError("CODEX_AUTH_UNSUPPORTED", "额度读取需要 ChatGPT 订阅登录；当前账户使用其他认证方式。");
      }
      const result = await client.request("account/rateLimits/read");
      if (!isRecord(result) || !(Object.hasOwn(result, "rateLimits") || Object.hasOwn(result, "rateLimitsByLimitId"))) {
        throw new AppError("CODEX_PROTOCOL_ERROR", "Codex 额度响应缺少额度字段，请检查 CLI 版本。");
      }
      const snapshot = normalizeQuota(result, this.clock.now(), "codex");
      const optionalText = (value: unknown): string | null => typeof value === "string" && value.length > 0 ? value : null;
      snapshot.account = {
        type: "chatgpt",
        email: optionalText(account.email),
        planType: optionalText(account.planType),
        workspaceId: optionalText(account.workspaceId) ?? optionalText(account.chatgptAccountId),
      };
      snapshot.cli = { version: launch.version };
      return snapshot;
    } finally {
      await client.close();
    }
  }
}
