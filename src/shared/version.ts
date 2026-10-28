import { readFileSync } from "node:fs";
import { AppError } from "./errors.js";
import { isRecord } from "./validation.js";

/** Both compiled development and packaged runtimes keep the manifest above dist/src. */
function readVersion(): string {
  try {
    const manifest: unknown = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8"));
    if (isRecord(manifest) && typeof manifest.version === "string" && /^\d+\.\d+\.\d+$/.test(manifest.version)) return manifest.version;
  } catch { /* Only expose a fixed error; never include a package path or raw parse error. */ }
  throw new AppError("APPLICATION_VERSION_INVALID", "程序版本清单无效，请使用完整且匹配的程序包。");
}

export const applicationVersion = readVersion();
