import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile, stat, readdir, unlink, symlink, rename, lstat, realpath, rmdir } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { root } from "./lib/runtime-files.mjs";
import { desktopDebugger } from "./lib/desktop-debugger.mjs";
import { desktopDiagnostics } from "./lib/desktop-diagnostics.mjs";
import { pickConfig } from "./lib/pick-config.mjs";
import { initializeDesktopProfile } from "../dist/src/desktop/profile.js";
import { loadConfig } from "../dist/src/config/load.js";
import { SqliteStore } from "../dist/src/storage/sqlite-store.js";

if (process.platform !== "win32") throw new Error("Installer acceptance requires Windows");
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== "--package") throw new Error("Usage: smoke-installer.mjs --package generated/desktop-directory");
const input = resolve(args[1]), id = randomUUID(), outputName = `installer-acceptance-${id}`;
await mkdir(join(root, ".local"), { recursive: true });
const artifacts = join(root, ".local", outputName);
await mkdir(artifacts);
execFileSync(process.execPath, [join(root, "scripts/package-installer.mjs"), "--package", input, "--output-name", outputName, "--test-id", id], { windowsHide: true, stdio: "inherit" });
const manifest = JSON.parse(await readFile(join(root, ".release", outputName, "release.json"), "utf8"));
const setup = join(root, ".release", outputName, manifest.file), destination = join(artifacts, "安装目录 中文", "CodexQuotaScheduler");
const executable = join(destination, "CodexQuotaScheduler.exe");
const hash = async (path) => createHash("sha256").update(await readFile(path)).digest("hex");
assert.equal(await hash(setup), manifest.sha256);
function native(executable, args) {
  try { execFileSync(executable, args, { windowsHide: true, stdio: "pipe", timeout: 120000 }); return 0; }
  catch (error) { if (Number.isInteger(error.status)) return error.status; throw error; }
}
await mkdir(destination, { recursive: true });
const sentinel = join(destination, "foreign-file.txt");
await writeFile(sentinel, "Synthetic unrelated file");
assert.equal(native(setup, ["/S"]), 43, "Refuse an unrelated nonempty directory");
assert.equal(await readFile(sentinel, "utf8"), "Synthetic unrelated file");
await unlink(sentinel);
assert.equal(native(setup, ["/S"]), 0, "Fresh per-user install");
for (const [path, expected] of Object.entries(manifest.files)) assert.equal(await hash(join(destination, path)), expected);
const ready = join(artifacts, "mutex-ready"), release = join(artifacts, "mutex-release");
const holdScript = `$ErrorActionPreference='Stop';$mutex=New-Object System.Threading.Mutex($false,'Local\\CodexQuotaScheduler.Maintenance.v1');try {[System.IO.File]::WriteAllText($env:CQS_MUTEX_READY,'ready');for($i=0;$i -lt 100;$i++){if(Test-Path -LiteralPath $env:CQS_MUTEX_RELEASE){break};Start-Sleep -Milliseconds 100}}finally{$mutex.Dispose()}`;
const holder = spawn(join(process.env.SystemRoot ?? "C:/Windows", "System32/WindowsPowerShell/v1.0/powershell.exe"),
  ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-EncodedCommand", Buffer.from(holdScript, "utf16le").toString("base64")],
  { windowsHide: true, stdio: "ignore", env: { ...process.env, CQS_MUTEX_READY: ready, CQS_MUTEX_RELEASE: release } });
const released = new Promise((done) => holder.once("exit", done));
try {
  for (let i = 0; i < 100; i++) { try { await stat(ready); break; } catch { await delay(100); } }
  assert.ok(await stat(ready));
  assert.equal(native(join(destination, "maintenance-guard.exe"), []), 42, "Maintenance probe blocks startup");
} finally { await writeFile(release, "release"); await released; }
assert.equal(native(join(destination, "maintenance-guard.exe"), []), 0, "Maintenance probe clears after installer exits");
const originalConfig = join(artifacts, "source 中文/config/local.json"), sourceDir = join(artifacts, "source 中文");
await initializeDesktopProfile({ dataDir: sourceDir, configPath: originalConfig, debugging: false });
const sourceConfig = await loadConfig(originalConfig), sourceStore = new SqliteStore(sourceConfig.storage.databasePath);
await sourceStore.tasks.create({ id: "migrated-fixture", name: "Migration fixture", enabled: true, projectDir: artifacts,
  promptFile: join(artifacts, "unused.md"), priority: 1, session: { mode: "new" } }, "Synthetic migration fixture");
const sourceRun = await sourceStore.runs.create("migrated-fixture");
await sourceStore.runs.update(sourceRun.id, { status: "needs_attention", output: "Synthetic preserved output" }, "queued");
sourceStore.import([], true); sourceStore.close();
const sourceHash = await hash(sourceConfig.storage.databasePath);
const profile = join(artifacts, "用户数据 中文");
const env = { ...process.env };
for (const key of Object.keys(env)) if (/^(PATH|NODE_OPTIONS|NODE_PATH|ELECTRON_RUN_AS_NODE)$/i.test(key)) delete env[key];
env.PATH = artifacts;
const child = spawn(executable, ["--data-dir", profile, "--remote-debugging-port=0"], { env, windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
let stderr = "", page, control, checkpoint = "installed-launch";
child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-4000); });
const exited = new Promise((done) => child.once("exit", done));
try {
  let port;
  for (let i = 0; i < 150; i++) {
    assert.equal(child.exitCode, null, stderr);
    try { port = (await readFile(join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0]; break; } catch { await delay(100); }
  }
  assert.ok(port, "Installed desktop debugger ready: " + stderr);
  let targets;
  for (let i = 0; i < 150; i++) {
    targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    if (targets.some((target) => target.url.startsWith("http://127.0.0.1:"))) break;
    await delay(100);
  }
  page = await desktopDebugger(targets.find((target) => target.url.startsWith("http://127.0.0.1:")).webSocketDebuggerUrl);
  control = await desktopDebugger(targets.find((target) => target.url.endsWith("startup.html")).webSocketDebuggerUrl);
  await page.wait("document.getElementById('source')?.textContent.includes('MOCK')");
  await page.evaluate(`(async()=>{const csrf=(await(await fetch('/api/bootstrap')).json()).csrf;const response=await fetch('/api/action',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':csrf},body:JSON.stringify({action:'task-save',definition:{id:'original-desktop',name:'Original desktop fixture',enabled:true,projectDir:${JSON.stringify(artifacts)},priority:1,session:{mode:'new'}},prompt:'Synthetic original desktop data'})});if(!response.ok)throw new Error('Original fixture save failed')})()`);
  assert.equal(await page.evaluate("typeof window.desktopData"), "undefined");
  assert.equal(await control.evaluate("typeof require"), "undefined");
  const appHash = await hash(executable);
  checkpoint = "running-upgrade-refused";
  assert.equal(native(setup, ["/S"]), 42);
  assert.ok([0, 42].includes(native(join(destination, "Uninstall.exe"), ["/S"])));
  await delay(1000); // The uninstaller may copy itself before returning; verify its actual protected state.
  assert.ok(await stat(join(destination, "install-product.ini")));
  assert.equal(child.exitCode, null);
  assert.equal(await hash(executable), appHash);
  checkpoint = "migration-native-picker";
  await control.evaluate("window.desktopData.action('stop',undefined,true)");
  await control.evaluate("window.desktopLifecycle.command('status')");
  await control.wait("document.visibilityState==='visible' && document.hasFocus()");
  await control.evaluate("window.desktopData.action('preview').catch(()=>{});true");
  await pickConfig(child.pid, originalConfig);
  await control.wait("window.desktopData.read().then(v=>v.preview?.tasks===1 && v.preview.runs===1)");
  await control.evaluate("document.getElementById('data-confirm').click();true");
  await control.wait("!document.getElementById('data-commit').disabled");
  await control.evaluate("document.getElementById('data-commit').click();true");
  await control.wait("window.desktopData.read().then(v=>!v.busy && !v.preview && v.profiles.length===2)");
  assert.equal(await control.evaluate("window.desktopLifecycle.read().then(v=>v.phase)"), "stopped");
  assert.equal(await hash(sourceConfig.storage.databasePath), sourceHash);
  const imported = await control.evaluate("window.desktopData.read().then(v=>v.config)");
  await control.evaluate("window.desktopLifecycle.command('start')");
  const importedUrl = await control.evaluate("window.desktopLifecycle.read().then(v=>v.connection.url)");
  await page.wait(`location.origin===${JSON.stringify(importedUrl)} && document.getElementById('source')?.textContent.includes('MOCK')`);
  await page.wait("fetch('/api/run?id=" + sourceRun.id + "').then(r=>r.json()).then(s=>s.run?.id==='" + sourceRun.id + "')");
  assert.equal(await page.evaluate("fetch('/api/tasks').then(r=>r.json()).then(tasks=>tasks.some(t=>t.id==='original-desktop'))"), false);
  assert.equal(await control.evaluate("window.desktopLifecycle.read().then(v=>v.activity.paused)"), true);
  await control.evaluate("window.desktopLifecycle.command('status')");
  await control.evaluate("document.getElementById('data-management').scrollIntoView()");
  const screenshot = await control.call("Page.captureScreenshot", { format: "png" });
  await writeFile(join(artifacts, "migration.png"), Buffer.from(screenshot.data, "base64"));
  checkpoint = "profile-switch-and-upgrade-preparation";
  await control.evaluate("window.desktopData.action('stop',undefined,true)");
  await control.evaluate("window.desktopData.action('switch','default',true)");
  await control.evaluate("window.desktopLifecycle.command('start')");
  const originalUrl = await control.evaluate("window.desktopLifecycle.read().then(v=>v.connection.url)");
  await page.wait(`location.origin===${JSON.stringify(originalUrl)} && document.getElementById('source')?.textContent.includes('MOCK')`);
  assert.equal(await page.evaluate("fetch('/api/tasks').then(r=>r.json()).then(tasks=>tasks.some(t=>t.id==='original-desktop'))"), true);
  await control.evaluate("void window.desktopData.action('prepare-upgrade',undefined,true).catch(()=>{});true");
  assert.equal(await Promise.race([exited, delay(20000).then(() => { throw new Error("Upgrade preparation timeout"); })]), 0);
  const dataPaths = [join(profile, "config/local.json"), join(profile, "data/state.sqlite"), imported, (await loadConfig(imported)).storage.databasePath];
  const before = await Promise.all(dataPaths.map(hash));
  assert.ok((await readdir(join(profile, "backups"))).some((name) => name.startsWith("manual-")));
  checkpoint = "upgrade-and-uninstall-preserve-data";
  const reg = join(process.env.SystemRoot ?? "C:/Windows", "System32/reg.exe"), key = `HKCU\\Software\\${manifest.product}`;
  execFileSync(reg, ["ADD", key, "/v", "Version", "/t", "REG_SZ", "/d", "9.0.0", "/f", "/reg:64"], { windowsHide: true, stdio: "ignore" });
  assert.equal(native(setup, ["/S"]), 44, "Downgrade refused");
  execFileSync(reg, ["ADD", key, "/v", "Version", "/t", "REG_SZ", "/d", manifest.version, "/f", "/reg:64"], { windowsHide: true, stdio: "ignore" });
  const resources = join(destination, "resources"), saved = join(destination, "resources-saved"), outside = join(artifacts, "external-project");
  for (const path of [resources, saved, outside]) assert.ok(resolve(path).startsWith(resolve(artifacts) + sep));
  assert.equal((await realpath(resources)).toLowerCase(), resolve(resources).toLowerCase());
  await mkdir(outside); await writeFile(join(outside, "auth.json"), "Synthetic external file");
  await rename(resources, saved);
  try {
    await symlink(outside, resources, "junction");
    assert.equal(native(setup, ["/S"]), 43, "Installation refuses a redirected program path");
    assert.ok([0, 43].includes(native(join(destination, "Uninstall.exe"), ["/S"])));
    await delay(1000); assert.ok(await stat(executable));
    assert.equal(await readFile(join(outside, "auth.json"), "utf8"), "Synthetic external file");
  } finally {
    if ((await lstat(resources)).isSymbolicLink() && (await realpath(resources)).toLowerCase() === resolve(outside).toLowerCase()) await rmdir(resources);
    await rename(saved, resources);
  }
  assert.equal(native(setup, ["/S"]), 0, "Manual reinstall/upgrade");
  assert.deepEqual(await Promise.all(dataPaths.map(hash)), before);
  await writeFile(join(destination, "user-file-to-keep.txt"), "Synthetic unknown file");
  assert.equal(native(join(destination, "Uninstall.exe"), ["/S"]), 0);
  for (let i = 0; i < 100; i++) { try { await stat(executable); await delay(100); } catch (error) { if (error.code === "ENOENT") break; throw error; } }
  await assert.rejects(stat(executable), { code: "ENOENT" });
  assert.equal(await readFile(join(destination, "user-file-to-keep.txt"), "utf8"), "Synthetic unknown file");
  assert.deepEqual(await Promise.all(dataPaths.map(hash)), before);
  assert.equal(await hash(sourceConfig.storage.databasePath), sourceHash);
  assert.deepEqual(page.errors, []); assert.deepEqual(control.errors, []);
  await writeFile(join(artifacts, "result.json"), JSON.stringify({ installed: true, nodeOnPath: false, maintenanceProbe: true, runningUpgradeBlocked: true, runningUninstallBlocked: true,
    nativeConfigPicker: true, migrationSourceUnchanged: true, importedHistoryPreserved: true, profileSwitch: true, upgradeBackup: true,
    manualUpgradePreservesData: true, downgradeBlocked: true, redirectedPathsBlocked: true, uninstallPreservesData: true, unknownFilesPreserved: true, realTasksSubmitted: false, scriptErrors: 0 }, null, 2));
  console.log(JSON.stringify({ passed: true, artifacts }));
} catch (error) {
  await desktopDiagnostics(artifacts, { checkpoint, error, page, control }).catch(() => {}); throw error;
} finally {
  page?.close(); control?.close();
  if (child.exitCode === null) { child.kill(); await Promise.race([exited, delay(5000)]); }
  // Failed acceptance still cleans only its own marked installation; data and unknown files remain.
  try {
    const marker = await readFile(join(destination, "install-product.ini"), "utf8");
    if (marker.includes("Id=" + manifest.product)) {
      for (let attempt = 0; attempt < 10; attempt++) {
        native(join(destination, "Uninstall.exe"), ["/S"]); await delay(500);
        try { await stat(executable); } catch (error) { if (error.code === "ENOENT") break; throw error; }
      }
    }
  } catch (error) { if (error.code !== "ENOENT") throw error; }
}
