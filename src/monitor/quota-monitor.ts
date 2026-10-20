import type { QuotaProvider, QuotaSnapshot } from "../domain/quota.js";

/** Read-only one-shot access, separate from the persistent monitoring stream. */
export class QuotaMonitor {
  constructor(private readonly provider: QuotaProvider) {}

  sample(): Promise<QuotaSnapshot> {
    return this.provider.read();
  }
}
