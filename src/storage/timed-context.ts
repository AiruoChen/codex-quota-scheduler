import type { AppConfig } from "../config/load.js";
import { codexConnectionKey } from "../adapters/codex/connection-key.js";
import { quotaStreamKey } from "../monitor/context.js";
import { digest } from "../monitor/recognize.js";
import type { TimedContext } from "./timed-plan-repository.js";

/** Account/source authorization survives reserve changes; quota checks still use the active policy stream. */
export function timedContext(config: AppConfig): TimedContext {
  return { provider: config.provider, streamKey: quotaStreamKey(config),
    sourceKey: digest([config.provider, config.limitId, codexConnectionKey(config.codex)]), policy: config };
}
