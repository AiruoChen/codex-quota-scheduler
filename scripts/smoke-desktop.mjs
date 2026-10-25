import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { root } from "./lib/runtime-files.mjs";
import { readInstance } from "../dist/src/runtime/instance.js";
import { desktopDebugger } from "./lib/desktop-debugger.mjs";

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
let socket;
let controlDebugger;
let secondary;
const pending = new Map();
let sequence = 0;
const scriptErrors = [];
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
  socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((done, reject) => { socket.onopen = done; socket.onerror = reject; });
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    if (message.method === "Runtime.exceptionThrown") scriptErrors.push(message.params.exceptionDetails.text);
    if (message.id) {
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id); clearTimeout(request.timer);
      if (message.error) request.reject(message.error); else request.done(message.result);
    }
  };
  function call(method, params = {}) {
    return new Promise((done, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error("Desktop debugger timeout: " + method)); }, 5000);
      pending.set(id, { done, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async function evaluate(expression) {
    const result = await call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  }
  async function wait(expression) {
    for (let attempt = 0; attempt < 100; attempt++) { if (await evaluate(expression)) return; await delay(100); }
    throw new Error("Desktop UI did not become ready: " + expression);
  }
  await call("Runtime.enable"); await call("Page.enable");
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
  const image = await call("Page.captureScreenshot", { format: "png" });
  await writeFile(join(artifacts, "overview.png"), Buffer.from(image.data, "base64"));
  const record = await readInstance(configPath);
  assert.ok(record && record.pid !== child.pid);
  const controlPage = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((target) => target.url.endsWith("/startup.html"));
  assert.ok(controlPage, "Lifecycle control page exists");
  controlDebugger = await desktopDebugger(controlPage.webSocketDebuggerUrl);
  assert.equal(await evaluate("typeof window.desktopLifecycle"), "undefined");
  assert.equal(await controlDebugger.evaluate("typeof require"), "undefined");
  await controlDebugger.evaluate("window.desktopLifecycle.command('restart')");
  assert.equal(await controlDebugger.evaluate("window.desktopLifecycle.read().then(v => v.intent)"), "restart");
  assert.equal((await readInstance(configPath)).pid, record.pid, "No restart before confirmation");
  await controlDebugger.evaluate("window.desktopLifecycle.command('keep-open')");
  secondary = spawn(executable, [...prefix, "--data-dir", profile], { cwd: artifacts, env, windowsHide: true, stdio: "ignore" });
  const secondaryExit = await Promise.race([
    new Promise((done, reject) => { secondary.once("error", reject); secondary.once("exit", done); }),
    delay(10000, undefined, { ref: false }).then(() => { throw new Error("Second instance did not exit"); }),
  ]);
  assert.equal(secondaryExit, 0);
  assert.equal((await readInstance(configPath))?.pid, record.pid);
  await controlDebugger.evaluate("window.desktopLifecycle.command('restart')");
  await controlDebugger.evaluate("void window.desktopLifecycle.command('wait').catch(() => {}); true");
  try { await controlDebugger.wait(`window.desktopLifecycle.read().then(v => v.phase === 'running' && v.connection.pid !== ${record.pid})`); }
  catch (error) { console.log(JSON.stringify(await controlDebugger.evaluate("window.desktopLifecycle.read()"))); throw error; }
  assert.equal((await readInstance(configPath)).pid !== record.pid, true);
  await call("Page.reload");
  await wait("document.getElementById('source')?.textContent.includes('MOCK')");
  assert.equal(await evaluate("(async () => (await (await fetch('/api/tasks')).json()).some(t => t.id === 'desktop-smoke'))()"), true);
  assert.deepEqual(scriptErrors, []);
  assert.deepEqual(controlDebugger.errors, []);
  await call("Browser.close").catch(() => {});
  const code = await Promise.race([exited, delay(15000, undefined, { ref: false }).then(() => { throw new Error("Desktop did not finish graceful shutdown"); })]);
  assert.equal(code, 0, stderr);
  assert.equal(await readInstance(configPath), null);
  assert.ok((await readFile(join(profile, "data/state.sqlite"))).length > 0);
  if (packaged) {
    const appFiles = await readdir(join(executable, "../resources/app"), { recursive: true });
    assert.ok(!appFiles.some((file) => /(^|[\\/])(node_modules|tests|\.local|\.runtime|\.git)([\\/]|$)|local\.json|\.sqlite|\.log$/.test(file)));
  }
  await writeFile(join(artifacts, "result.json"), JSON.stringify({ packaged, versions, nodeOnPath: false, source: result.source,
    initiallyPaused: result.paused, singleInstance: true, controlledRestart: true, isolatedLifecycleBridge: true,
    scriptErrors: scriptErrors.length, gracefulExit: true }, null, 2));
  console.log(JSON.stringify({ passed: true, packaged, versions, artifacts }));
} finally {
  for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error("Desktop debugger closed")); }
  socket?.close();
  controlDebugger?.close();
  // Only owned test process handles are terminated if an assertion prevented normal shutdown.
  if (secondary && secondary.exitCode === null) secondary.kill();
  if (child.exitCode === null) child.kill();
}
