import type { QuotaProvider, QuotaSnapshot } from "../../domain/quota.js";
import { AppError } from "../../shared/errors.js";

/** Phase 1: implement JSON-RPC initialization and account/rateLimits/read here. */
export class AppServerQuotaProvider implements QuotaProvider {
  async read(): Promise<QuotaSnapshot> {
    throw new AppError("NOT_IMPLEMENTED", "真实额度读取尚未实现；请使用 mock 配置演示框架。");
  }
}
