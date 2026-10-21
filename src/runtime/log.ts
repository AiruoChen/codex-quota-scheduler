import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";

/** Only fixed event names and error codes enter this log. Prompts, output, paths and account data do not. */
export class RuntimeLogger {
  private failed = false;
  constructor(readonly path: string, private readonly maxBytes = 1024 * 1024, private readonly backups = 3) {
    mkdirSync(dirname(path), { recursive: true });
  }
  write = (event: string, code?: string): void => {
    try { this.append(event, code); this.failed = false; }
    catch {
      // Diagnostics must not break finalization of an already submitted task.
      if (!this.failed) console.error(JSON.stringify({ error: { code: "RUNTIME_LOG_WRITE_FAILED", message: "运行日志暂时无法写入。" } }));
      this.failed = true;
    }
  };
  private append(event: string, code?: string): void {
    const entry = JSON.stringify({ time: new Date().toISOString(), event: /^[a-z_]{1,64}$/.test(event) ? event : "runtime_event",
      ...(code && /^[A-Z_]{1,64}$/.test(code) ? { code } : {}) }) + "\n";
    if (existsSync(this.path) && statSync(this.path).size + Buffer.byteLength(entry) > this.maxBytes) {
      if (existsSync(`${this.path}.${this.backups}`)) unlinkSync(`${this.path}.${this.backups}`);
      for (let index = this.backups - 1; index >= 1; index--) {
        if (existsSync(`${this.path}.${index}`)) renameSync(`${this.path}.${index}`, `${this.path}.${index + 1}`);
      }
      renameSync(this.path, `${this.path}.1`);
    }
    appendFileSync(this.path, entry, { mode: 0o600 });
  }
  tail(lines = 80): string {
    if (!existsSync(this.path)) return "";
    return readFileSync(this.path, "utf8").trimEnd().split("\n").slice(-Math.min(200, Math.max(1, lines))).join("\n");
  }
}
