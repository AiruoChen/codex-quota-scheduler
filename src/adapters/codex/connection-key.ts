import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { CodexOptions } from "./launcher.js";

/** Identifies a connection location without persisting the personal home path in diagnostic events. */
export function codexConnectionKey(options: CodexOptions): string {
  return createHash("sha256").update(JSON.stringify([options.executable, options.args,
    resolve(options.home ?? process.env.CODEX_HOME ?? join(homedir(), ".codex"))])).digest("hex");
}
