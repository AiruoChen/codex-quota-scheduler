import type { QuotaFeed, QuotaSnapshot } from "../../domain/quota.js";
import { systemClock, type Clock } from "../../domain/ports.js";
import { AppError } from "../../shared/errors.js";
import { defaultCodexOptions, type CodexOptions } from "./launcher.js";
import { connectCodex, readAccount, readQuota } from "./session.js";

/** Reusable connection for monitoring only. Notifications trigger complete authenticated reads. */
export class AppServerQuotaFeed implements QuotaFeed {
  private connection: Awaited<ReturnType<typeof connectCodex>> | undefined;
  private readonly listeners = new Set<() => void>();
  private cleanup: (() => void)[] = [];
  private readonly notificationSignatures = new Map<string, string>();
  private broken = false;
  constructor(private readonly options: CodexOptions = defaultCodexOptions, private readonly clock: Clock = systemClock) {}

  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private invalidate(): void { for (const listener of this.listeners) listener(); }

  async read(signal?: AbortSignal): Promise<QuotaSnapshot> {
    try {
      if (this.broken) await this.close();
      if (!this.connection) {
        this.connection = await connectCodex(this.options, signal);
        this.cleanup.push(this.connection.client.onNotification((method, params) => {
          if (method !== "account/updated" && method !== "account/rateLimits/updated") return;
          // The real CLI can repeat account/updated with the same plan during a quota read.
          // Verify identity using account/read on both sides, and coalesce identical hints.
          const signature = JSON.stringify(params) ?? "null";
          if (this.notificationSignatures.get(method) === signature) return;
          this.notificationSignatures.set(method, signature);
          this.invalidate();
        }), this.connection.client.onFailure(() => { this.broken = true; this.invalidate(); }));
      }
      const { client, launch } = this.connection;
      const snapshot = await readQuota(client, this.clock, launch.version, signal);
      const account = await readAccount(client, signal);
      if (JSON.stringify(account) !== JSON.stringify(snapshot.account)) {
        throw new AppError("CODEX_ACCOUNT_CHANGED", "额度查询期间账户发生变化，请重新获取快照。");
      }
      return snapshot;
    } catch (error) { await this.close(); throw error; }
  }

  async close(): Promise<void> {
    for (const unsubscribe of this.cleanup.splice(0)) unsubscribe();
    const connection = this.connection;
    this.connection = undefined;
    this.broken = false;
    await connection?.client.close();
  }
}
