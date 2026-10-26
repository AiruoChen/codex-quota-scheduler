import { homedir } from "node:os";
import { join } from "node:path";
import type { AppConfig } from "../config/load.js";
import { digest } from "./recognize.js";

/** Keep the persisted stream identity identical for monitoring and execution preflight. */
export function quotaStreamKey(config: AppConfig): string {
  return digest([config.provider, config.limitId, config.reservePercent, config.quotaMaxAgeMs,
    config.provider === "codex" ? [config.codex.executable, config.codex.args,
      config.codex.home ?? process.env.CODEX_HOME ?? join(homedir(), ".codex")] : null]);
}
