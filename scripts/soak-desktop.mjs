import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtemp, mkdir, open, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { root } from "./lib/runtime-files.mjs";
import { sourceIdentity, inspectInstaller, jsonFile } from "./lib/release-files.mjs";
import { desktopDebugger } from "./lib/desktop-debugger.mjs";
import { initializeDesktopProfile } from "../dist/src/desktop/profile.js";
import { ConfigManager } from "../dist/src/config/manage.js";
import { readInstance } from "../dist/src/runtime/instance.js";

if (process.platform !== "win32") throw new Error("SOAK_WINDOWS_REQUIRED");
const args = process.argv.slice(2), options = {};
for (let i = 0; i < args.length; i += 2) {
  if (!["--package", "--installer", "--seconds"].includes(args[i]) || !args[i + 1] || options[args[i]]) throw new Error("SOAK_ARGUMENT_INVALID");
  options[args[i]] = args[i + 1];
}
const seconds = Number(options["--seconds"] ?? 86400);
if (!options["--package"] || !options["--installer"] || !Number.isInteger(seconds) || seconds < 10 || seconds > 172800) throw new Error("SOAK_ARGUMENT_INVALID");
const installer = await inspectInstaller(resolve(options["--installer"])), source = sourceIdentity();
const executable = join(resolve(options["--package"]), "CodexQuotaScheduler.exe");
await mkdir(join(root, ".local"), { recursive: true });
const artifacts = await mkdtemp(join(root, ".local/soak-acceptance-")), profile = join(artifacts, "profile 中文");
const configPath = join(profile, "config/local.json"), audit = join(artifacts, "audit.jsonl");
await initializeDesktopProfile({ dataDir: profile, configPath, debugging: true });
await mkdir(join(profile, "fixture-home"));
const config = new ConfigManager(configPath);
await config.set("codex.executable", executable);
await config.set("codex.args", [join(root, "tests/fixtures/fake-execution.mjs"), "--scenario", "success", "--audit-file", audit, "--project", profile]);
await config.set("codex.home", join(profile, "fixture-home"));
await config.set("provider", "codex"); await config.set("pollIntervalMs", 1000);
await config.set("quotaMaxAgeMs", 10000);
const env = { ...process.env };
for (const key of Object.keys(env)) if (/^(PATH|NODE_OPTIONS|NODE_PATH|ELECTRON_RUN_AS_NODE|CODEX_HOME)$/i.test(key)) delete env[key];
env.PATH = artifacts;
const child = spawn(executable, ["--data-dir", profile, "--remote-debugging-port=0"], { env, windowsHide: true, stdio: ["ignore", "ignore", "ignore"] });
const exited = new Promise((done) => child.once("exit", done));
let page, control, browser, interrupted = false, completed = false, started = 0, wall = 0, samples = 0, maxGapMs = 0;
let peakBytes = 0, initialBytes = 0, lastBytes = 0, heapPeakBytes = 0, submissions = 0, uniqueRuns = 0, leakedChildren = 0;
let monitorUpdates = 0, lastMonitorAt = null, notificationCount = 0;
process.once("SIGINT", () => { interrupted = true; }); process.once("SIGTERM", () => { interrupted = true; });
let auditOffset = 0, auditTail = "", auditRows = 0, auditSubmissions = 0;
const auditActive = new Set(), auditKeys = new Set();
/** Consume only newly appended fixture events so a real 24-hour run remains linear in log size. */
async function auditState() {
  const handle = await open(audit, "r");
  try {
    const size = (await handle.stat()).size;
    assert.ok(size >= auditOffset && size < 32 * 1024 * 1024);
    while (auditOffset < size) {
      const buffer = Buffer.allocUnsafe(Math.min(65536, size - auditOffset));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, auditOffset);
      assert.ok(bytesRead > 0);
      auditOffset += bytesRead;
      const lines = (auditTail + buffer.subarray(0, bytesRead).toString("utf8")).split("\n");
      auditTail = lines.pop();
      for (const line of lines) {
        const row = JSON.parse(line); auditRows++;
        assert.ok(auditRows <= 500000 && Number.isSafeInteger(row.pid) && row.pid > 0);
        if (row.event === "spawn") auditActive.add(row.pid);
        else if (row.event === "exit") auditActive.delete(row.pid);
        else if (row.event === "submit" && /^[a-f0-9]{64}$/.test(row.key)) { auditSubmissions++; auditKeys.add(row.key); }
        else throw new Error("SOAK_AUDIT_INVALID");
      }
    }
  } finally { await handle.close(); }
  return { active: [...auditActive], count: auditSubmissions, unique: auditKeys.size };
}
async function memory() {
  const metrics = await browser.call("SystemInfo.getProcessInfo"), backend = await readInstance(configPath);
  const ids = [...new Set([...metrics.processInfo.map((item) => item.id), backend?.pid].filter((id) => Number.isSafeInteger(id) && id > 0))];
  assert.ok(ids.includes(child.pid));
  const script = "$ErrorActionPreference='Stop';$metricSum=0;foreach($metricId in @(" + ids.join(",") + ")){$metricProcess=Get-Process -Id $metricId -ErrorAction SilentlyContinue;if($metricProcess){$metricSum+=$metricProcess.WorkingSet64}};[Console]::Write($metricSum)";
  const amount = Number(execFileSync(join(process.env.SystemRoot ?? "C:/Windows", "System32/WindowsPowerShell/v1.0/powershell.exe"),
    ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", script], { windowsHide: true, encoding: "utf8", timeout: 10000 }));
  assert.ok(Number.isSafeInteger(amount) && amount > 0); return amount;
}
try {
  let port, browserPath;
  for (let i = 0; i < 150; i++) {
    assert.equal(child.exitCode, null);
    try { [port, browserPath] = (await readFile(join(profile, "DevToolsActivePort"), "utf8")).trim().split("\n"); break; } catch { await delay(100); }
  }
  assert.ok(port && browserPath);
  browser = await desktopDebugger(`ws://127.0.0.1:${port}${browserPath}`, { page: false });
  let targets;
  for (let i = 0; i < 150; i++) {
    targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    if (targets.some((target) => target.url.startsWith("http://127.0.0.1:"))) break;
    await delay(100);
  }
  page = await desktopDebugger(targets.find((target) => target.url.startsWith("http://127.0.0.1:")).webSocketDebuggerUrl);
  control = await desktopDebugger(targets.find((target) => target.url.endsWith("startup.html")).webSocketDebuggerUrl);
  await control.wait("window.desktopLifecycle.read().then(v=>v.phase==='running')");
  await control.evaluate("window.desktopLifecycle.command('notifications-toggle')");
  await page.evaluate(`(async()=>{const csrf=(await(await fetch('/api/bootstrap')).json()).csrf;
    const action=async(body)=>{const r=await fetch('/api/action',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':csrf},body:JSON.stringify(body)});if(!r.ok)throw new Error('Soak fixture action failed');return r.json()};
    for(let i=0;i<10;i++){await action({action:'task-save',definition:{id:'soak-'+i,name:'Synthetic soak fixture',enabled:true,projectDir:${JSON.stringify(profile)},priority:1,session:{mode:'new'}},prompt:'Synthetic soak fixture '+i});await action({action:'enqueue',id:'soak-'+i})}
    await action({action:'scheduler-start'});await action({action:'resume'});})()`);
  await page.wait("fetch('/api/state').then(r=>r.json()).then(s=>s.scheduler.queue.length===10 && s.scheduler.queue.every(r=>r.status==='succeeded'))");
  await control.wait("window.desktopLifecycle.read().then(v=>v.desktop.notices.length===10)");
  const domStart = await page.call("Memory.getDOMCounters");
  await control.evaluate("window.desktopLifecycle.command('hide')");
  await control.evaluate("window.desktopLifecycle.command('hide')");
  initialBytes = lastBytes = await memory(); peakBytes = initialBytes;
  started = performance.now(); wall = Date.now(); let previous = started, sampledMemory = started;
  while (!interrupted && performance.now() - started < seconds * 1000) {
    const now = performance.now(); maxGapMs = Math.max(maxGapMs, Math.round(now - previous)); previous = now;
    assert.equal(child.exitCode, null);
    const state = await control.evaluate("window.desktopLifecycle.read().then(v=>({phase:v.phase,operations:v.activity?.activeOperations,notices:v.desktop.notices.length,hidden:v.desktop.hidden}))");
    assert.equal(state.phase, "running"); assert.ok(state.operations >= 0 && state.operations <= 1); assert.equal(state.hidden, true); assert.equal(state.notices, 10);
    notificationCount = Math.max(notificationCount, state.notices);
    const quotaState = await page.evaluate("fetch('/api/state').then(r=>r.json()).then(s=>({provider:s.provider,observedAt:s.monitor?.observedAt,errorCode:s.monitor?.errorCode}))");
    assert.equal(quotaState.provider, "codex"); assert.equal(quotaState.errorCode, null);
    assert.ok(typeof quotaState.observedAt === "string" && Number.isFinite(Date.parse(quotaState.observedAt)));
    if (quotaState.observedAt !== lastMonitorAt) { monitorUpdates++; lastMonitorAt = quotaState.observedAt; }
    const auditValue = await auditState();
    submissions = auditValue.count; uniqueRuns = auditValue.unique;
    assert.equal(submissions, 10); assert.equal(uniqueRuns, 10); assert.ok(auditValue.active.length <= 2);
    const heap = await page.call("Runtime.getHeapUsage"), dom = await page.call("Memory.getDOMCounters");
    heapPeakBytes = Math.max(heapPeakBytes, Math.round(heap.usedSize));
    assert.ok(dom.nodes <= domStart.nodes * 2 + 1000); assert.ok(dom.jsEventListeners <= domStart.jsEventListeners * 2 + 100);
    if (now - sampledMemory >= 60000) { lastBytes = await memory(); peakBytes = Math.max(peakBytes, lastBytes); sampledMemory = now; }
    assert.ok(peakBytes <= 1536 * 1024 * 1024 && lastBytes - initialBytes <= 256 * 1024 * 1024 && heapPeakBytes <= 256 * 1024 * 1024);
    samples++; await delay(Math.min(1000, Math.max(1, seconds * 1000 - (performance.now() - started))));
  }
  maxGapMs = Math.max(maxGapMs, Math.round(performance.now() - previous));
  const elapsedMs = Math.round(performance.now() - started), wallMs = Date.now() - wall;
  lastBytes = await memory(); peakBytes = Math.max(peakBytes, lastBytes);
  const endSource = sourceIdentity(); assert.equal(endSource.commit, source.commit); assert.equal(endSource.clean, source.clean);
  completed = !interrupted && elapsedMs >= seconds * 1000 && Math.abs(wallMs - elapsedMs) <= 5000 && maxGapMs <= 15000;
  assert.deepEqual(page.errors, []); assert.deepEqual(control.errors, []);
  await control.evaluate("void window.desktopLifecycle.command('exit').catch(()=>{});true");
  assert.equal(await Promise.race([exited, delay(15000, undefined, { ref: false }).then(() => { throw new Error("SOAK_SHUTDOWN_TIMEOUT"); })]), 0);
  for (let i = 0; i < 30; i++) { leakedChildren = (await auditState()).active.length; if (leakedChildren === 0) break; await delay(100); }
  assert.equal(leakedChildren, 0);
  const result = { format: 1, ...source, version: installer.version, installerSha256: installer.sha256, scope: "desktop_protocol_fixture", completed,
    requestedMs: seconds * 1000, elapsedMs, wallMs, maxGapMs, samples, submissions, uniqueRuns, leakedChildren, peakBytes,
    growthBytes: Math.max(0, lastBytes - initialBytes), heapPeakBytes, monitorUpdates, notificationCount };
  await jsonFile(join(artifacts, "result.json"), result);
  if (!completed || monitorUpdates < 2 || notificationCount < 1) throw new Error("SOAK_CONTINUITY_FAILED");
  console.log(JSON.stringify({ passed: true, artifacts }));
} finally {
  page?.close(); control?.close(); browser?.close(); if (child.exitCode === null) child.kill();
}
