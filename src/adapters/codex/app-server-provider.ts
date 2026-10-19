import { systemClock, type Clock } from "../../domain/ports.js";
import type { QuotaProvider, QuotaSnapshot } from "../../domain/quota.js";
import { defaultCodexOptions, type CodexOptions } from "./launcher.js";
import { connectCodex, readQuota } from "./session.js";

export class AppServerQuotaProvider implements QuotaProvider {
  constructor(private readonly options: CodexOptions = defaultCodexOptions, private readonly clock: Clock = systemClock) {}

  async read(): Promise<QuotaSnapshot> {
    const { client, launch } = await connectCodex(this.options);
    try {
      return await readQuota(client, this.clock, launch.version);
    } finally {
      await client.close();
    }
  }
}
