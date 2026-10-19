import type { Clock } from "../../domain/ports.js";
import type { QuotaProvider, QuotaSnapshot } from "../../domain/quota.js";
import { normalizeQuota } from "../codex/normalize-quota.js";

export class MockQuotaProvider implements QuotaProvider {
  constructor(private readonly clock: Clock) {}

  async read(): Promise<QuotaSnapshot> {
    const now = this.clock.now();
    const seconds = Math.floor(now.getTime() / 1000);
    return normalizeQuota({
      rateLimitsByLimitId: {
        codex: {
          limitName: "模拟 Codex 额度（非真实账户）",
          planType: "mock",
          primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: seconds + 3600 },
          secondary: { usedPercent: 40, windowDurationMins: 10080, resetsAt: seconds + 86400 },
        },
      },
    }, now, "mock");
  }
}
