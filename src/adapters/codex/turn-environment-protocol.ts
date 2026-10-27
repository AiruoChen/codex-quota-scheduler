import { execFile } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import { isRecord } from "../../shared/validation.js";
import type { CodexLaunch, CodexOptions } from "./launcher.js";

/** The field's presence alone does not establish the semantics of an empty list. */
export function supportsEmptyTurnEnvironments(schema: unknown): boolean {
  if (!isRecord(schema) || !isRecord(schema.properties)) return false;
  const field = schema.properties.environments;
  return isRecord(field) && Array.isArray(field.type) && field.type.includes("array")
    && isRecord(field.items) && field.items.$ref === "#/definitions/TurnEnvironmentParams"
    && typeof field.description === "string" && /Empty disables environment access for this turn\./.test(field.description);
}

/** Inspect this exact installed CLI without loading/resuming any chat or changing configuration. */
export async function inspectTurnEnvironmentOverride(launch: CodexLaunch, options: CodexOptions, signal?: AbortSignal): Promise<boolean> {
  let directory: string | undefined, temporaryRoot: string | undefined;
  try {
    temporaryRoot = await realpath(tmpdir());
    directory = await mkdtemp(join(temporaryRoot, "codex-quota-protocol-"));
    const execute = promisify(execFile), settings = {
      env: launch.env, windowsHide: true, timeout: options.requestTimeoutMs, maxBuffer: 65536, ...(signal ? { signal } : {}),
    };
    const sameVersion = async () => {
      const result = await execute(launch.executable, [...launch.args, "--version"], settings);
      return /^codex-cli\s+(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)/m.exec(String(result.stdout))?.[1] === launch.version;
    };
    if (!await sameVersion()) return false;
    await execute(launch.executable, [...launch.args, "app-server", "generate-json-schema", "--experimental", "--out", directory], settings);
    if (!await sameVersion()) return false;
    const path = join(directory, "v2/TurnStartParams.json"), info = await stat(path);
    if (!info.isFile() || info.size > 256 * 1024) return false;
    return supportsEmptyTurnEnvironments(JSON.parse(await readFile(path, "utf8")));
  } catch {
    // Unknown protocol, timeouts and malformed output cannot establish capability.
    return false;
  } finally {
    if (directory && temporaryRoot && dirname(directory) === temporaryRoot && basename(directory).startsWith("codex-quota-protocol-")) {
      await rm(directory, { recursive: true, force: true }).catch(() => {});
    }
  }
}
