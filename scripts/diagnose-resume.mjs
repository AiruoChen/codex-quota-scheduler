import { DatabaseSync } from "node:sqlite";
import { loadConfig } from "../dist/src/config/load.js";
import { readRun } from "../dist/src/storage/run-repository.js";
import { readOrigin } from "../dist/src/storage/recovery-repository.js";
import { checkResumeCompatibility } from "../dist/src/adapters/codex/resume-check.js";

// No output paths, arbitrary RPC forwarding, recovery writes, or implicit target selection.
try {
  const args = process.argv.slice(2), values = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index], value = args[index + 1];
    if (!["--config", "--run"].includes(key) || values.has(key) || !value || value.startsWith("--")) throw new Error();
    values.set(key, value);
  }
  if (values.size !== 2) throw new Error();
  const config = await loadConfig(values.get("--config"));
  if (config.provider !== "codex" || config.storage.databasePath === ":memory:") throw new Error();
  const db = new DatabaseSync(config.storage.databasePath, { readOnly: true });
  let target;
  try {
    db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=3000;");
    const row = db.prepare("SELECT r.data_json, o.data_json AS origin FROM runs r LEFT JOIN execution_origins o ON o.run_id=r.id WHERE r.id=?").get(values.get("--run"));
    if (!row) throw new Error();
    target = { run: readRun(row.data_json), origin: row.origin === null ? null : readOrigin(row.origin) };
  } finally { db.close(); }
  const report = await checkResumeCompatibility(config.codex, target, AbortSignal.timeout(60000));
  console.log(JSON.stringify(report, null, 2));
  if (report.result !== "read_only_checks_passed") process.exitCode = 1;
} catch {
  console.log(JSON.stringify({ format: 1, result: "blocked", errorCode: "RESUME_CHECK_INPUT_OR_STORAGE_INVALID", resumeVerified: false }));
  process.exitCode = 1;
}
