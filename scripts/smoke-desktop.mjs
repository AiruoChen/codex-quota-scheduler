import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { root } from "./lib/runtime-files.mjs";
import { readInstance } from "../dist/src/runtime/instance.js";
import { desktopDebugger } from "./lib/desktop-debugger.mjs";
import { desktopDiagnostics, smokeFailureSummary } from "./lib/desktop-diagnostics.mjs";
import { guiAcceptance } from "./lib/gui-acceptance.mjs";
import { tasksQueueAcceptance } from "./lib/tasks-queue-acceptance.mjs";
import { runsRecoveryAcceptance } from "./lib/runs-recovery-acceptance.mjs";
import { trayAcceptance } from "./lib/tray-acceptance.mjs";
import { catalogAcceptance } from "./lib/catalog-acceptance.mjs";
import { queueRecoveryAcceptance } from "./lib/queue-recovery-acceptance.mjs";
import { timedPlansAcceptance } from "./lib/timed-plans-acceptance.mjs";

const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== "--packaged")) throw new Error("Usage: smoke-desktop.mjs [--packaged path/to/client.exe]");
const packaged = args.length > 0;
const executable = packaged ? resolve(args[1]) : createRequire(import.meta.url)("electron");
const prefix = packaged ? [] : [root];
await mkdir(join(root, ".local"), { recursive: true });
const artifacts = await mkdtemp(join(root, ".local/desktop-acceptance-"));
const profile = join(artifacts, "profile 中文");
const configPath = join(profile, "config/local.json");
const env = { ...process.env };
for (const key of Object.keys(env)) if (/^(PATH|NODE_OPTIONS|NODE_PATH|ELECTRON_RUN_AS_NODE)$/i.test(key)) delete env[key];
env.PATH = artifacts; // Electron and its backend must work without an installed node/npm on PATH.
const versions = JSON.parse(execFileSync(executable, ["--experimental-sqlite", "-e",
  "const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(':memory:');console.log(JSON.stringify({node:process.versions.node,electron:process.versions.electron,sqlite:db.prepare('select sqlite_version() as version').get().version}));db.close()"],
  { env: { ...env, ELECTRON_RUN_AS_NODE: "1" }, windowsHide: true, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 10000 }));
const launchArgs = [...prefix, "--data-dir", profile, "--remote-debugging-port=0"];
const child = spawn(executable, launchArgs, { cwd: artifacts, env, windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
let stderr = "";
child.stderr.on("data", (chunk) => { stderr = (stderr + chunk.toString()).slice(-4000); });
const exited = new Promise((done, reject) => { child.once("error", reject); child.once("exit", (code) => done(code)); });
let pageDebugger;
let controlDebugger;
let secondary;
let checkpoint = "launch";
try {
  let port;
  for (let attempt = 0; attempt < 150; attempt++) {
    assert.equal(child.exitCode, null, stderr);
    try { port = (await readFile(join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0]; break; }
    catch { await delay(100); }
  }
  assert.ok(port, "Owned desktop debugging endpoint becomes ready: " + stderr);
  let page;
  for (let attempt = 0; attempt < 150; attempt++) {
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    page = targets.find((target) => target.type === "page" && target.url.startsWith("http://127.0.0.1:"));
    if (page) break;
    await delay(100);
  }
  assert.ok(page, "Management page loaded: " + stderr);
  pageDebugger = await desktopDebugger(page.webSocketDebuggerUrl);
  const { call, evaluate, wait } = pageDebugger;
  checkpoint = "initial-page";
  await wait("document.getElementById('source')?.textContent.includes('MOCK')");
  assert.equal(await evaluate("typeof require"), "undefined");
  assert.equal(await evaluate("typeof process"), "undefined");
  assert.equal(await evaluate("document.querySelector('[data-action=resume]').disabled"), true);
  const result = await evaluate(`(async () => {
    const csrf = (await (await fetch('/api/bootstrap')).json()).csrf;
    const action = async (body) => { const response = await fetch('/api/action', { method:'POST', headers:{'Content-Type':'application/json','X-CSRF-Token':csrf}, body:JSON.stringify(body) }); if(!response.ok) throw new Error('Smoke action rejected');return response.json(); };
    await action({action:'task-save',definition:{id:'desktop-smoke',name:'桌面验收任务',enabled:true,projectDir:${JSON.stringify(artifacts)},priority:1,session:{mode:'new'}},prompt:'Synthetic desktop verification only.'});
    const run = await action({action:'enqueue',id:'desktop-smoke'});
    const state = await (await fetch('/api/state')).json();
    return {paused:state.scheduler.paused,source:state.provider,runId:run.id};
  })()`);
  assert.equal(result.paused, true); assert.equal(result.source, "mock"); assert.ok(result.runId);
  checkpoint = "gui-framework";
  const gui = await guiAcceptance(pageDebugger, artifacts, (step) => { checkpoint = step; });
  const catalog = await catalogAcceptance(pageDebugger, artifacts, (step) => { checkpoint = step; });
  checkpoint = "tasks-and-queue";
  const tasksQueue = await tasksQueueAcceptance(pageDebugger, gui.taskId, step => { checkpoint = step; });
  const timedPlans = await timedPlansAcceptance(pageDebugger, gui.taskId, artifacts, step => { checkpoint = step; });
  const controlPage = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((target) => target.url.endsWith("/startup.html"));
  assert.ok(controlPage, "Lifecycle control page exists");
  controlDebugger = await desktopDebugger(controlPage.webSocketDebuggerUrl);
  await controlDebugger.wait("typeof window.desktopLifecycle !== 'undefined'");
  await controlDebugger.evaluate("window.desktopLifecycle.command('show')");
  await wait("document.visibilityState === 'visible' && document.hasFocus()");
  checkpoint = "runs-and-recovery";
  const runsRecovery = await runsRecoveryAcceptance(pageDebugger, artifacts, gui.taskId);
  const queueRecovery = await queueRecoveryAcceptance(pageDebugger, configPath, artifacts, step => { checkpoint = step; });
  const image = await call("Page.captureScreenshot", { format: "png" });
  await writeFile(join(artifacts, "overview.png"), Buffer.from(image.data, "base64"));
  const record = await readInstance(configPath);
  assert.ok(record && record.pid !== child.pid);
  assert.equal(await evaluate("typeof window.desktopLifecycle"), "undefined");
  assert.equal(await controlDebugger.evaluate("typeof require"), "undefined");
  await controlDebugger.evaluate("window.desktopLifecycle.command('restart')");
  assert.equal(await controlDebugger.evaluate("window.desktopLifecycle.read().then(v => v.intent)"), "restart");
  assert.equal((await readInstance(configPath)).pid, record.pid, "No restart before confirmation");
  await controlDebugger.evaluate("window.desktopLifecycle.command('keep-open')");
  checkpoint = "tray-and-notifications";
  const tray = await trayAcceptance(pageDebugger, controlDebugger, profile, configPath, artifacts, child.pid, step => { checkpoint = step; });
  secondary = spawn(executable, [...prefix, "--data-dir", profile], { cwd: artifacts, env, windowsHide: true, stdio: "ignore" });
  const secondaryExit = await Promise.race([
    new Promise((done, reject) => { secondary.once("error", reject); secondary.once("exit", done); }),
    delay(10000, undefined, { ref: false }).then(() => { throw new Error("Second instance did not exit"); }),
  ]);
  assert.equal(secondaryExit, 0);
  assert.equal((await readInstance(configPath))?.pid, record.pid);
  for (let cycle = 0; cycle < 3; cycle++) {
    checkpoint = `restart-${cycle + 1}`;
    const previous = await readInstance(configPath);
    let stopWatching;
    let pausedDocument;
    if (cycle === 0) {
      // Hold the new document so refreshing during loadURL deterministically exercises the old CI race.
      pausedDocument = new Promise((done) => { stopWatching = pageDebugger.on("Fetch.requestPaused", done); });
      await call("Fetch.enable", { patterns: [{ resourceType: "Document", requestStage: "Request" }] });
    }
    await controlDebugger.evaluate("window.desktopLifecycle.command('restart')");
    await controlDebugger.evaluate("void window.desktopLifecycle.command('wait').catch(() => {}); true");
    await controlDebugger.wait(`window.desktopLifecycle.read().then(v => v.phase === 'running' && v.connection.pid !== ${previous.pid})`);
    const origin = await controlDebugger.evaluate("window.desktopLifecycle.read().then(v => v.connection.url)");
    if (pausedDocument) await Promise.race([pausedDocument, delay(10000, undefined, { ref: false }).then(() => { throw new Error("New document was not intercepted"); })]);
    if (pausedDocument) { await call("Page.reload"); await call("Fetch.disable"); stopWatching(); }
    // A running backend does not imply that its new renderer has finished loading or is visible.
    await wait(`location.origin === ${JSON.stringify(origin)} && document.visibilityState === 'visible' && document.getElementById('source')?.textContent.includes('MOCK')`);
    if (!pausedDocument) { await call("Page.reload"); await wait(`location.origin === ${JSON.stringify(origin)} && document.visibilityState === 'visible' && document.getElementById('source')?.textContent.includes('MOCK')`); }
    assert.equal(await controlDebugger.evaluate("window.desktopLifecycle.read().then(v=>v.code)"), null);
    await evaluate("location.hash='#tasks'");
    await wait("document.getElementById('task-sort')?.value==='created_asc'");
    assert.equal(await evaluate("fetch('/api/preferences').then(r=>r.json()).then(p=>p.taskSort)"), "created_asc");
  }
  assert.equal(await evaluate("(async () => (await (await fetch('/api/tasks')).json()).some(t => t.id === 'desktop-smoke'))()"), true);
  assert.deepEqual(pageDebugger.errors, []);
  assert.deepEqual(controlDebugger.errors, []);
  await controlDebugger.evaluate("window.desktopLifecycle.command('exit')").catch(() => {});
  const code = await Promise.race([exited, delay(15000, undefined, { ref: false }).then(() => { throw new Error("Desktop did not finish graceful shutdown"); })]);
  assert.equal(code, 0, stderr);
  assert.equal(await readInstance(configPath), null);
  assert.ok((await readFile(join(profile, "data/state.sqlite"))).length > 0);
  if (packaged) {
    const appRoot = join(executable, "../resources/app");
    const manifest = JSON.parse(await readFile(join(appRoot, "package.json"), "utf8"));
    const manual = await readFile(join(appRoot, "docs/USER-MANUAL.html"), "utf8");
    assert.ok(manual.includes(`<span class="edition">${manifest.version} `), "Packaged offline manual matches the client version");
    const appFiles = await readdir(join(executable, "../resources/app"), { recursive: true });
    assert.ok(!appFiles.some((file) => /(^|[\\/])(node_modules|tests|\.local|\.runtime|\.git)([\\/]|$)|local\.json|\.sqlite|\.log$/.test(file)));
  }
  await writeFile(join(artifacts, "result.json"), JSON.stringify({ packaged, versions, nodeOnPath: false, source: result.source,
    initiallyPaused: result.paused, gui, catalog, tasksQueue, timedPlans, runsRecovery, queueRecovery, tray, singleInstance: true, controlledRestarts: 3, refreshDuringNavigation: true, isolatedLifecycleBridge: true,
    scriptErrors: pageDebugger.errors.length, gracefulExit: true }, null, 2));
  console.log(JSON.stringify({ passed: true, packaged, versions, artifacts }));
} catch (error) {
  const diagnostic = await desktopDiagnostics(artifacts, { checkpoint, error, page: pageDebugger, control: controlDebugger }).catch(() => null);
  console.log(JSON.stringify({ smokeFailure: smokeFailureSummary(checkpoint, error, diagnostic) }));
  throw error;
} finally {
  pageDebugger?.close();
  controlDebugger?.close();
  // Only owned test process handles are terminated if an assertion prevented normal shutdown.
  if (secondary && secondary.exitCode === null) secondary.kill();
  if (child.exitCode === null) child.kill();
}
