import type { Clock, ExecutionQuotaGuard } from "../domain/ports.js";
import type { MonitorRepository } from "../domain/monitor.js";
import type { QuotaSnapshot } from "../domain/quota.js";
import { evaluateQuota, hasQuotaIdentity, type QuotaAvailability, type QuotaPolicy } from "../domain/quota-policy.js";

/** Full verified reads retain monitor window history; final admission never overwrites a newer observation. */
export class MonitoredExecutionQuota implements ExecutionQuotaGuard {
  constructor(private readonly repository: MonitorRepository, private readonly policy: QuotaPolicy, private readonly clock: Clock) {}

  observe(snapshot: QuotaSnapshot): QuotaAvailability {
    if (snapshot.source !== "codex") return { status: "unknown", reason: "unknown_quota" };
    if (!hasQuotaIdentity(snapshot.account)) return { status: "unknown", reason: "identity_unknown" };
    return this.repository.record({ snapshot }).state.availability;
  }

  check(snapshot: QuotaSnapshot): QuotaAvailability {
    if (snapshot.source !== "codex") return { status: "unknown", reason: "unknown_quota" };
    if (!hasQuotaIdentity(snapshot.account)) return { status: "unknown", reason: "identity_unknown" };
    const state = this.repository.status();
    if (!state || JSON.stringify(state.snapshot) !== JSON.stringify(snapshot)) return { status: "unknown", reason: "stale_quota" };
    if (state.availability.status !== "available") return state.availability;
    return evaluateQuota(snapshot, this.policy, this.clock.now());
  }
}
