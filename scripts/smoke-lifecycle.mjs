import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { root } from "./lib/runtime-files.mjs";
import { desktopDebugger } from "./lib/desktop-debugger.mjs";
import { desktopDiagnostics } from "./lib/desktop-diagnostics.mjs";
import { closeWindow } from "./lib/close-window.mjs";
import { desktopOptions, initializeDesktopProfile } from "../dist/src/desktop/profile.js";
import { ConfigManager } from "../dist/src/config/manage.js";
import { SqliteStore } from "../dist/src/storage/sqlite-store.js";
import { DesktopBackend } from "../dist/src/desktop/backend.js";
import { readInstance } from "../dist/src/runtime/instance.js";

const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== "--packaged")) throw new Error("Usage: smoke-lifecycle.mjs [--packaged client.exe]");
const executable = args.length ? resolve(args[1]) : createRequire(import.meta.url)("electron");
const prefix = args.length ? [] : [root];
await mkdir(join(root, ".local"), { recursive: true });
const artifacts = await mkdtemp(join(root, ".local/lifecycle-acceptance-"));
const results = [];
for (const [scenario, choice, expected] of [["lifecycle-success", "wait", "succeeded"], ["hang", "cancel", "cancelled"],
  ["cancel-unconfirmed", "escalate", "needs_attention"], ["external", "detach", "running"], ["external-stop", "confirmed-stop", "stopped"],
  ["startup-error", "retry", "running"], ["tray-complete", "background", "succeeded"]]) {
  const profile = join(artifacts, scenario);
  const options = desktopOptions([], profile);
  await initializeDesktopProfile(options);
  const trace = join(profile, "protocol.jsonl");
  const originalConfig = await readFile(options.configPath, "utf8");
  if (!scenario.startsWith("external") && scenario !== "startup-error") {
    const manager = new ConfigManager(options.configPath);
    await manager.set("provider", "codex");
    await manager.set("codex.executable", executable);
    await manager.set("codex.args", [join(root, "tests/fixtures/fake-execution.mjs"), "--scenario", scenario === "tray-complete" ? "lifecycle-success" : scenario, "--trace", trace, "--project", profile]);
  }
  if (scenario === "startup-error") await writeFile(options.configPath, "broken-config");
  const owner = scenario.startsWith("external") ? new DesktopBackend(options.configPath, {
    executable, entry: join(root, "dist/src/desktop/backend-entry.js"), electron: true }) : undefined;
  await owner?.start();
  const child = spawn(executable, [...prefix, "--data-dir", profile, "--remote-debugging-port=0"], {
    cwd: artifacts, windowsHide: true, stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr = (stderr + chunk.toString()).slice(-2000); });
  const exited = new Promise((done, reject) => { child.once("error", reject); child.once("exit", done); });
  let page;
  let control;
  try {
    let port;
    for (let attempt = 0; attempt < 150; attempt++) {
      assert.equal(child.exitCode, null, stderr);
      try { port = (await readFile(join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0]; break; } catch { await delay(100); }
    }
    assert.ok(port, "Lifecycle debugger ready");
    let pages;
    for (let attempt = 0; attempt < 150; attempt++) {
      pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      if (pages.some((target) => scenario === "startup-error" ? target.url.endsWith("/startup.html") : target.url.startsWith("http://127.0.0.1:"))) break;
      await delay(100);
    }
    control = await desktopDebugger(pages.find((target) => target.url.endsWith("/startup.html")).webSocketDebuggerUrl);
    await control.wait("typeof window.desktopLifecycle !== 'undefined'");
    if (scenario === "startup-error") {
      await control.wait("window.desktopLifecycle.read().then(v => v.phase === 'failed')");
      assert.equal(await readFile(options.configPath, "utf8"), "broken-config");
      assert.equal(await readInstance(options.configPath), null);
      await writeFile(options.configPath, originalConfig);
      await control.evaluate("window.desktopLifecycle.command('start')");
      pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      for (let attempt = 0; attempt < 100 && !pages.some((target) => target.url.startsWith("http://127.0.0.1:")); attempt++) {
        await delay(100); pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      }
    }
    page = await desktopDebugger(pages.find((target) => target.url.startsWith("http://127.0.0.1:")).webSocketDebuggerUrl);
    await control.wait("window.desktopLifecycle.read().then(v => v.phase === 'running')");
    if (scenario === "tray-complete") await control.evaluate("window.desktopLifecycle.command('notifications-toggle')");
    if (scenario === "startup-error") {
      await control.evaluate("window.desktopLifecycle.command('exit')").catch(() => {});
      assert.equal(await Promise.race([exited, delay(15000, undefined, { ref: false }).then(() => { throw new Error("Retry shutdown timeout"); })]), 0);
    } else if (owner) {
      assert.equal(await control.evaluate("window.desktopLifecycle.read().then(v => v.connection.owned)"), false);
      await control.evaluate("window.desktopLifecycle.command('stop-external')");
      assert.equal(await control.evaluate("window.desktopLifecycle.read().then(v => v.intent)"), "stop-external");
      assert.equal((await owner.status()).stopping, false);
      if (choice === "confirmed-stop") {
        await control.evaluate("document.querySelector('[data-command=wait]').click(); true");
        await control.wait("window.desktopLifecycle.read().then(v => v.phase === 'stopped')");
        assert.equal(await readInstance(options.configPath), null);
      } else await control.evaluate("window.desktopLifecycle.command('keep-open')");
      await control.evaluate("window.desktopLifecycle.command('exit')").catch(() => {});
    } else {
      const runId = await page.evaluate(`(async () => {
        const csrf=(await(await fetch('/api/bootstrap')).json()).csrf;
        const action=async(body)=>{const response=await fetch('/api/action',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':csrf},body:JSON.stringify(body)});if(!response.ok)throw new Error('Fixture action failed');return response.json()};
        await action({action:'task-save',definition:{id:'lifecycle-test',name:'生命周期协议替身验收',enabled:true,projectDir:${JSON.stringify(profile)},priority:1,session:{mode:'new'}},prompt:'Synthetic fixture instruction.'});
        const job=await action({action:'run',id:'lifecycle-test'});
        for(let i=0;i<100;i++){const state=await(await fetch('/api/state')).json();const runId=state.jobs.find(item=>item.id===job.id)?.runId;if(runId){const detail=await(await fetch('/api/run?id='+encodeURIComponent(runId))).json();if(detail.run.turnId)return runId}await new Promise(done=>setTimeout(done,25))}throw new Error('Fixture turn did not start');
      })()`);
      await control.evaluate("window.desktopLifecycle.command('status')");
      if (scenario === "tray-complete") {
        const pid = (await readInstance(options.configPath)).pid;
        await control.evaluate("window.desktopLifecycle.command('show')");
        await closeWindow(page, child.pid);
        await control.wait("window.desktopLifecycle.read().then(v=>v.desktop.closeNotice)");
        await control.evaluate("window.desktopLifecycle.command('hide')");
        await control.wait("window.desktopLifecycle.read().then(v=>v.desktop.hidden)");
        assert.equal((await readInstance(options.configPath)).pid,pid);
        await control.wait("window.desktopLifecycle.read().then(v=>v.desktop.notices.some(n=>n.title.includes('任务已完成')))");
        const id=await control.evaluate("window.desktopLifecycle.read().then(v=>v.desktop.notices.find(n=>n.title.includes('任务已完成')).id)");
        await control.evaluate(`window.desktopLifecycle.openNotice(${JSON.stringify(id)})`);
        await page.wait(`document.getElementById('run-dialog')?.open && document.getElementById('run-detail').textContent.includes('${runId}')`);
        await control.evaluate("window.desktopLifecycle.command('exit')").catch(()=>{});
      } else {
        await control.evaluate("window.desktopLifecycle.command('exit')");
        assert.equal(await control.evaluate("window.desktopLifecycle.read().then(v => v.intent)"), "exit");
        await control.evaluate("window.desktopLifecycle.command('keep-open')");
        assert.equal(await control.evaluate("window.desktopLifecycle.read().then(v => v.phase)"), "running");
        await control.evaluate("window.desktopLifecycle.command('exit')");
        const firstChoice = choice === "escalate" ? "wait" : choice;
        await control.evaluate(`document.querySelector('[data-command=${firstChoice}]').click(); true`);
        // Immediate terminal confirmation may close the window before a screenshot is captured.
        // The escalation case deliberately remains waiting until this test chooses cancellation.
        if (choice === "escalate") {
          await control.wait("window.desktopLifecycle.read().then(v => v.phase === 'stopping' && v.mode === 'wait')");
          const screenshot = await control.call("Page.captureScreenshot", { format: "png" });
          await writeFile(join(profile, "stopping.png"), Buffer.from(screenshot.data, "base64"));
          await control.evaluate("document.querySelector('[data-command=cancel]').click(); true");
        }
      }
      const code = await Promise.race([exited, delay(20000, undefined, { ref: false }).then(() => { throw new Error("Lifecycle shutdown timeout"); })]);
      assert.equal(code, 0, stderr);
      const store = new SqliteStore(join(profile, "data/state.sqlite"));
      try { assert.equal((await store.runs.get(runId))?.status, expected); } finally { store.close(); }
      const requests = await readFile(trace, "utf8");
      assert.equal(requests.split('"method":"turn/start"').length - 1, 1);
      if (choice === "wait" || choice === "background") assert.ok(!requests.includes('"method":"turn/interrupt"'));
    }
    if (owner) {
      assert.equal(await Promise.race([exited, delay(15000, undefined, { ref: false }).then(() => { throw new Error("External detach timeout"); })]), 0);
      if (choice === "detach") {
        assert.equal((await owner.status()).stopping, false);
        assert.ok(await readInstance(options.configPath));
      } else assert.equal(await readInstance(options.configPath), null);
    } else assert.equal(await readInstance(options.configPath), null);
    assert.deepEqual(page.errors, []); assert.deepEqual(control.errors, []);
    results.push({ scenario, choice, status: expected, passed: true });
  } catch (error) {
    await desktopDiagnostics(profile, { checkpoint: scenario, error, page, control }).catch(() => {});
    throw error;
  } finally {
    page?.close(); control?.close();
    if (child.exitCode === null) child.kill();
    await owner?.close();
  }
}
await writeFile(join(artifacts, "result.json"), JSON.stringify({ packaged: args.length > 0, protocolFixturesOnly: true, results }, null, 2));
console.log(JSON.stringify({ passed: true, scenarios: results.length, artifacts }));
