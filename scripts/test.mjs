import { readdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

// Pass explicit files so Windows does not need shell glob expansion.
const files = readdirSync("tests", { recursive: true })
  .filter((file) => file.endsWith(".test.ts") || file.endsWith(".test.mjs"))
  .map((file) => file.endsWith(".test.ts") ? join("dist/tests", file.replace(/\.ts$/, ".js")) : join("tests", file));
if (files.length === 0) throw new Error("No compiled tests found. Run npm run build first.");
// Each protocol suite launches child processes and uses durable SQLite writes.
// Bound concurrent files so shared Windows runners do not starve a suite's deadline.
const result = spawnSync(process.execPath, ["--experimental-sqlite", "--test", "--test-concurrency=2", "--test-timeout=60000", ...files], { stdio: "inherit" });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
