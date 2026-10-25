import { app, BrowserWindow, Menu, powerMonitor, session } from "electron";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DesktopBackend } from "./backend.js";
import { DesktopLifecycle } from "./lifecycle.js";
import { desktopOptions, initializeDesktopProfile, type DesktopOptions } from "./profile.js";
import { desktopWebPreferences, isManagementNavigation } from "./security.js";
import { recoverInstance } from "../runtime/instance.js";
import { AppError } from "../shared/errors.js";
import { registerLifecycleControl } from "../adapters/electron/lifecycle-ipc.js";
import type { LifecycleCommand, LifecycleIntent, LifecycleState, LifecycleView, ShutdownMode } from "../domain/lifecycle.js";

app.setName("CodexQuotaScheduler");
const controlPage = new URL("./public/startup.html", import.meta.url);
let options: DesktopOptions;
let window: BrowserWindow | undefined;
let control: BrowserWindow | undefined;
let intent: LifecycleIntent | null = null;
let uiCode: string | null = null;
let loadedUrl = "";
let navigation = 0;
let allowQuit = false;
let starting: Promise<void> | undefined;
let exiting: Promise<void> | undefined;
const lifecycle = new DesktopLifecycle((exited) => new DesktopBackend(options.configPath, {
  executable: process.execPath, entry: fileURLToPath(new URL("./backend-entry.js", import.meta.url)), electron: true,
}, exited), changed);

function view(): LifecycleView {
  const state = lifecycle.snapshot();
  return { ...state, ...(uiCode ? { code: uiCode, ...(state.phase === "starting" || state.phase === "stopping" ? {} : { phase: "failed" as const }) } : {}), intent };
}
function publish() { if (control && !control.isDestroyed()) control.webContents.send("desktop-lifecycle:changed", view()); }
function showControl() { if (control && !control.isDestroyed()) { control.show(); control.focus(); publish(); } }
function showMain() {
  if (!window || window.isDestroyed()) return;
  if (window.isMinimized()) window.restore();
  window.show(); window.focus();
}
function report(error: unknown) {
  uiCode = error instanceof AppError ? error.code : "DESKTOP_OPERATION_FAILED";
  showControl();
}
function changed(state: LifecycleState) {
  if (state.phase === "starting") { loadedUrl = ""; navigation++; }
  publish();
  if (state.phase === "running" && state.connection) {
    if (loadedUrl !== state.connection.url) {
      loadedUrl = state.connection.url;
      const loading = ++navigation;
      window!.setTitle(`Codex 任务助手${state.connection.owned ? "" : " · 已连接外部服务"}`);
      void window!.loadURL(loadedUrl).then(() => {
        if (loading === navigation && lifecycle.snapshot().phase === "running" && !intent && !exiting) { showMain(); control?.hide(); }
      }).catch((error: unknown) => { if (loading === navigation && lifecycle.snapshot().phase === "running") report(error); });
    }
  } else if (["failed", "disconnected", "stopping", "stopped"].includes(state.phase)) {
    window?.hide();
    if (state.phase === "failed" || state.phase === "stopped") loadedUrl = "";
    showControl();
  }
}
function connect(): Promise<void> {
  return starting ??= (async () => {
    uiCode = null; publish();
    await initializeDesktopProfile(options);
    await lifecycle.start();
  })().finally(() => { starting = undefined; });
}
async function exitClient(mode: ShutdownMode) {
  return exiting ??= (async () => {
    intent = null; uiCode = null;
    await starting?.catch(() => {});
    if (lifecycle.snapshot().connection?.owned) await lifecycle.stop(mode);
    else await lifecycle.detach();
    allowQuit = true; app.quit();
  })().catch((error: unknown) => { exiting = undefined; report(error); });
}
async function requestExit() {
  if (exiting) { showControl(); return; }
  if (starting) {
    intent = "exit"; showControl();
    await starting.catch(() => {});
    if (intent !== "exit") return;
  }
  if (lifecycle.snapshot().phase === "stopping") { showControl(); return; }
  await lifecycle.check();
  const state = lifecycle.snapshot();
  if (state.connection?.owned && (state.phase === "disconnected" || (state.activity?.activeOperations ?? 0) > 0)) {
    intent = "exit"; showControl(); return;
  }
  await exitClient("cancel");
}
async function command(action: LifecycleCommand) {
  if (action === "cancel" && lifecycle.snapshot().phase === "stopping") { await lifecycle.escalate(); return; }
  if (action === "keep-open") {
    if (lifecycle.snapshot().phase === "stopping") throw new AppError("LIFECYCLE_BUSY", "停止已开始，不能撤销为继续派发。");
    intent = null; uiCode = null; publish();
    if (lifecycle.snapshot().phase === "running") { showMain(); control?.hide(); }
    return;
  }
  if (action === "wait" || action === "cancel") {
    const selected = intent;
    if (!selected) throw new AppError("CONFIRM_REQUIRED", "没有待确认的操作。");
    intent = null; uiCode = null;
    if (selected === "exit") { await exitClient(action); return; }
    if (selected === "recover") {
      if (action !== "wait") throw new AppError("CONFIRM_REQUIRED", "服务记录修复需要明确确认。");
      await recoverInstance(options.configPath);
      await connect(); return;
    }
    if (selected === "restart") await lifecycle.restart(action);
    else await lifecycle.stop(action, selected === "stop-external");
    return;
  }
  if (action === "start") { await connect(); return; }
  if (action === "status") { uiCode = null; await lifecycle.check(); publish(); return; }
  if (action === "exit") { await requestExit(); return; }
  const state = lifecycle.snapshot();
  if (state.phase === "starting" || state.phase === "stopping") throw new AppError("LIFECYCLE_BUSY", "请等待状态切换完成。");
  if (action === "recover") {
    if (!["RUNTIME_STALE", "DESKTOP_BACKEND_EXITED"].includes(state.code ?? "")) throw new AppError("RECOVERY_REQUIRED", "请先核对服务进程是否已经退出。");
  } else if (state.phase !== "running" || (action === "stop-external" ? state.connection?.owned !== false : state.connection?.owned !== true)) {
    throw new AppError("EXTERNAL_SERVICE", "操作与当前服务归属不匹配。");
  }
  intent = action; showControl();
}
async function main() {
  options = desktopOptions(process.argv.slice(app.isPackaged ? 1 : 2), join(app.getPath("appData"), "CodexQuotaScheduler"));
  app.setPath("userData", options.dataDir);
  if (options.debugging) app.commandLine.appendSwitch("remote-debugging-address", "127.0.0.1");
  if (!app.requestSingleInstanceLock()) { allowQuit = true; app.quit(); return; }
  app.on("second-instance", () => view().phase === "running" && !intent ? showMain() : showControl());
  app.on("before-quit", (event) => { if (!allowQuit) { event.preventDefault(); void requestExit().catch(report); } });
  process.on("SIGINT", () => { void exitClient("cancel"); });
  process.on("SIGTERM", () => { void exitClient("cancel"); });
  await app.whenReady();
  const desktopSession = session.fromPartition("cqs-desktop");
  desktopSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  desktopSession.setPermissionCheckHandler(() => false);
  window = new BrowserWindow({ title: "Codex 任务助手", width: 1200, height: 800, minWidth: 960, minHeight: 640,
    backgroundColor: "#f5f7fa", show: false, webPreferences: { ...desktopWebPreferences, session: desktopSession } });
  control = new BrowserWindow({ title: "后台服务管理", width: 820, height: 680, minWidth: 720, minHeight: 580, show: false,
    webPreferences: { ...desktopWebPreferences, preload: fileURLToPath(new URL("./control-preload.cjs", import.meta.url)), session: desktopSession } });
  for (const target of [window, control]) {
    target.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    target.webContents.on("will-attach-webview", (event) => event.preventDefault());
    const navigation = (event: Electron.Event, url: string) => {
      if (target === control ? url !== controlPage.href : !isManagementNavigation(url, lifecycle.snapshot().connection?.url ?? "")) event.preventDefault();
    };
    target.webContents.on("will-navigate", navigation); target.webContents.on("will-redirect", navigation);
  }
  window.on("close", (event) => { if (!allowQuit) { event.preventDefault(); void requestExit().catch(report); } });
  control.on("close", (event) => {
    if (allowQuit) return;
    event.preventDefault();
    if (lifecycle.snapshot().phase === "running") { intent = null; showMain(); control?.hide(); }
    else void requestExit().catch(report);
  });
  registerLifecycleControl(control, controlPage.href, { view, command, failed: report });
  const invoke = (action: LifecycleCommand) => { void command(action).catch(report); };
  Menu.setApplicationMenu(Menu.buildFromTemplate([{ label: "后台服务", submenu: [
    { label: "服务状态…", click: showControl }, { label: "重新连接 / 启动", click: () => invoke("start") },
    { label: "重启自有后台…", click: () => invoke("restart") }, { label: "停止自有后台…", click: () => invoke("stop") },
    { label: "停止外部服务…", click: () => invoke("stop-external") }, { type: "separator" }, { label: "退出客户端", click: () => invoke("exit") },
  ] }]));
  const health = setInterval(() => { void lifecycle.check(); }, 3000);
  health.unref();
  powerMonitor.on("resume", () => { void lifecycle.check(); });
  await control.loadFile(fileURLToPath(controlPage));
  showControl();
  await connect();
}
void main().catch((error: unknown) => {
  if (control) report(error);
  else { console.error("DESKTOP_START_FAILED"); allowQuit = true; app.quit(); }
});
