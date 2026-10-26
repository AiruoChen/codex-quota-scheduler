import { spawn } from "node:child_process";
import { mkdir, open, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { root } from "./runtime-files.mjs";

/** Capture raw output only in ignored local storage. Reports contain fixed IDs, counts and durations. */
export async function runAcceptanceCommand(id, command, args, logPath, timeoutMs = 1200000) {
  await mkdir(dirname(logPath), { recursive: true });
  const handle = await open(logPath, "wx", 0o600), started = performance.now();
  let tail = "", bytes = 0, exceeded = false, writes = Promise.resolve();
  const child = spawn(command, args, { cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: process.env });
  const capture = (data) => {
    bytes += data.length; tail = (tail + data.toString()).slice(-32768);
    if (bytes <= 16 * 1024 * 1024) writes = writes.then(() => handle.write(data));
    else { exceeded = true; child.kill(); }
  };
  child.stdout.on("data", capture); child.stderr.on("data", capture);
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
  let code;
  try { code = await new Promise((done, reject) => { child.once("error", reject); child.once("exit", done); }); }
  finally { clearTimeout(timer); try { await writes; } finally { await handle.close(); } }
  if (code !== 0 || timedOut || exceeded) throw new Error(`ACCEPTANCE_${id.toUpperCase()}_FAILED`);
  const lines = tail.trim().split(/\r?\n/), summary = lines.reverse().find((line) => line.startsWith('{"passed":true'));
  const tests = [...tail.matchAll(/^# tests (\d+)\r?$/gm)].at(-1)?.[1];
  return { id, status: "passed", durationMs: Math.round(performance.now() - started), count: tests ? Number(tests) : 1,
    summary: summary ? JSON.parse(summary) : null, text: tail };
}
export async function resultSummary(path) { return JSON.parse(await readFile(path, "utf8")); }
