import { setTimeout as delay } from "node:timers/promises";
import type { MonitorRepository, MonitorUpdate } from "../domain/monitor.js";
import { systemClock, type Clock } from "../domain/ports.js";
import type { QuotaFeed, QuotaProvider } from "../domain/quota.js";
import { AppError } from "../shared/errors.js";

export interface MonitorWaiter { sleep(ms: number, signal: AbortSignal): Promise<void> }
const systemWaiter: MonitorWaiter = { sleep: async (ms, signal) => { await delay(ms, undefined, { signal }); } };

export class ContinuousQuotaMonitor {
  constructor(private readonly provider: QuotaProvider, readonly repository: MonitorRepository,
    private readonly clock: Clock = systemClock, private readonly waiter: MonitorWaiter = systemWaiter) {}

  async sample(signal?: AbortSignal): Promise<MonitorUpdate> {
    let observation;
    try { observation = { snapshot: await this.provider.read(signal) }; }
    catch (error) {
      if (signal?.aborted) throw error;
      observation = { errorCode: error instanceof AppError && /^[A-Z_]{1,64}$/.test(error.code) ? error.code : "QUOTA_READ_FAILED" };
    }
    if (signal?.aborted) throw new AppError("MONITOR_STOPPED", "额度监控已停止。");
    // Storage errors must escape; treating them as a network retry could lose reset events.
    return this.repository.record(observation);
  }

  async run(signal: AbortSignal, onUpdate: (update: MonitorUpdate) => void | Promise<void>, samples = Infinity): Promise<void> {
    if (!(samples >= 1) || samples !== Infinity && !Number.isSafeInteger(samples)) throw new AppError("INVALID_ARGUMENT", "采样次数必须是正整数。");
    const feed = this.provider as Partial<QuotaFeed>;
    let hint = false;
    const unsubscribe = feed.subscribe?.(() => { hint = true; });
    try {
      for (let index = 0; index < samples && !signal.aborted; index++) {
        hint = false;
        const update = await this.sample(signal);
        await onUpdate(update);
        if (index + 1 >= samples || signal.aborted) break;
        let remaining = Math.max(1000, Date.parse(update.state.nextPollAt) - this.clock.now().getTime());
        let wall = this.clock.now().getTime();
        let waited = 0;
        while (remaining > 0 && !signal.aborted) {
          if (hint && update.state.failures === 0 && waited >= 1000) break;
          const step = Math.min(1000, remaining);
          await this.waiter.sleep(step, signal);
          const now = this.clock.now().getTime();
          // A delayed timer after resume, or a wall-clock correction, requires a new read.
          if (now < wall || now - wall > step + 2000) break;
          remaining -= step; waited += step; wall = now;
        }
      }
    } catch (error) { if (!signal.aborted) throw error; }
    finally { unsubscribe?.(); await feed.close?.(); }
  }

  async close(): Promise<void> { await (this.provider as Partial<QuotaFeed>).close?.(); }
}
