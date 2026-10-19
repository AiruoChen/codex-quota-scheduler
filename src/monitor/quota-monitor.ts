import type { QuotaProvider, QuotaSnapshot } from "../domain/quota.js";

/** One sample at a time. Polling, cancellation and reset events are phase 4. */
export class QuotaMonitor {
  constructor(private readonly provider: QuotaProvider) {}

  sample(): Promise<QuotaSnapshot> {
    return this.provider.read();
  }
}
