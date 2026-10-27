import { execFile, spawn } from "node:child_process";
import { mkdir, open, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { root } from "./runtime-files.mjs";

async function stopProcessTree(child, exited, stopFile, graceMs) {
  if (stopFile) {
    try {
      await writeFile(stopFile, "stop\n", { flag: "wx", mode: 0o600 });
      if (await Promise.race([exited.then(() => true, () => true), delay(graceMs, undefined, { ref: false }).then(() => false)])) return false;
    } catch { /* Continue to the bounded process-tree fallback. */ }
  }
  if (child.exitCode !== null || !Number.isSafeInteger(child.pid) || child.pid <= 0) return false;
  if (process.platform === "win32") {
    const taskkill = join(process.env.SystemRoot ?? "C:/Windows", "System32/taskkill.exe");
    const killed = await new Promise((done) => {
      execFile(taskkill, ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, timeout: 15000 }, (error) => done(!error));
    });
    if (killed || child.exitCode !== null) return false;
  } else {
    try { process.kill(-child.pid, "SIGKILL"); return false; } catch { if (child.exitCode !== null) return false; }
  }
  child.kill();
  return true;
}

/** Capture raw output only in ignored local storage. Reports contain fixed IDs, counts and durations. */
export async function runAcceptanceCommand(id, command, args, logPath, { timeoutMs = 1200000, cooperativeStop = false, requireTap = false, stopGraceMs = 30000 } = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2147483647 || !Number.isSafeInteger(stopGraceMs) || stopGraceMs < 1) throw new Error("ACCEPTANCE_TIMEOUT_INVALID");
  await mkdir(dirname(logPath), { recursive: true });
  const handle = await open(logPath, "wx", 0o600), started = performance.now();
  let tail = "", bytes = 0, exceeded = false, writes = Promise.resolve();
  const stopFile = cooperativeStop ? logPath + ".stop" : null;
  const child = spawn(command, args, { cwd: root, windowsHide: true, detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"], env: stopFile ? { ...process.env, CQS_ACCEPTANCE_STOP_FILE: stopFile } : process.env });
  const exited = new Promise((done, reject) => { child.once("error", reject); child.once("exit", done); });
  const capture = (data) => {
    bytes += data.length; tail = (tail + data.toString()).slice(-32768);
    if (bytes <= 16 * 1024 * 1024) writes = writes.then(() => handle.write(data));
    else { exceeded = true; if (!termination) termination = stopProcessTree(child, exited, stopFile, stopGraceMs); }
  };
  child.stdout.on("data", capture); child.stderr.on("data", capture);
  let timedOut = false, termination = null, cleanupFailed = false;
  const timer = setTimeout(() => { timedOut = true; if (!termination) termination = stopProcessTree(child, exited, stopFile, stopGraceMs); }, timeoutMs);
  let code;
  try { code = await exited; }
  finally {
    clearTimeout(timer);
    if (termination) cleanupFailed = await termination;
    try { await writes; } finally { await handle.close(); if (stopFile) await unlink(stopFile).catch(() => {}); }
  }
  if (cleanupFailed) throw new Error("ACCEPTANCE_TREE_CLEANUP_FAILED");
  const lines = tail.trim().split(/\r?\n/), newestFirst = [...lines].reverse();
  if (code !== 0 || timedOut || exceeded) {
    const error = new Error(`ACCEPTANCE_${id.toUpperCase()}_FAILED`);
    const line = id === "desktop" ? newestFirst.find((item) => item.startsWith('{"smokeFailure":')) : null;
    if (line) {
      try {
        const value = JSON.parse(line).smokeFailure;
        if (/^[A-Za-z0-9_-]{1,64}$/.test(value?.checkpoint)
          && ["UI_NOT_READY", "DEBUGGER_TIMEOUT", "ASSERTION_FAILED", "SMOKE_CHECK_FAILED"].includes(value.reason)
          && ["visible", "hidden", "unknown"].includes(value.visibility) && typeof value.focused === "boolean") {
          error.smokeFailure = { checkpoint: value.checkpoint, reason: value.reason, visibility: value.visibility, focused: value.focused };
        }
      } catch { /* Keep the fixed error code when diagnostic text is malformed. */ }
    }
    throw error;
  }
  const summary = newestFirst.find((line) => line.startsWith('{"passed":true'));
  const tests = [...tail.matchAll(/^# tests (\d+)\r?$/gm)].at(-1)?.[1], failures = [...tail.matchAll(/^# fail (\d+)\r?$/gm)].at(-1)?.[1];
  const testCount = tests === undefined ? null : Number(tests), failureCount = failures === undefined ? null : Number(failures);
  if (requireTap && (!Number.isSafeInteger(testCount) || testCount < 1 || failureCount !== 0)) throw new Error("ACCEPTANCE_UNIT_TAP_MISSING");
  return { id, status: "passed", durationMs: Math.round(performance.now() - started), count: testCount ?? 1,
    summary: summary ? JSON.parse(summary) : null, text: tail };
}
export async function resultSummary(path) { return JSON.parse(await readFile(path, "utf8")); }
