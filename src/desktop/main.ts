import { app, BrowserWindow, Menu, powerMonitor, session } from "electron";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DesktopBackend } from "./backend.js";
import { DesktopLifecycle } from "./lifecycle.js";
import { desktopOptions, initializeDesktopProfile, type DesktopOptions } from "./profile.js";
import { desktopWebPreferences, isAbortedNavigation, isManagementNavigation } from "./security.js";
import { recoverInstance } from "../runtime/instance.js";
import { AppError } from "../shared/errors.js";
import { registerLifecycleControl } from "../adapters/electron/lifecycle-ipc.js";
import { registerProjectDirectory } from "../adapters/electron/project-directory.js";
import { DesktopTray } from "../adapters/electron/tray.js";
import { ElectronNotices } from "../adapters/electron/notifications.js";
import { DesktopNotifications } from "./notifications.js";
import { NotificationStore } from "./notification-store.js";
import { noticeCopy } from "../domain/notifications.js";
import { DesktopVisibility } from "./visibility.js";
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
let notifications: DesktopNotifications | undefined;
let tray: DesktopTray | undefined;
let background = false, closeNotice = false, integrationStopping = false;
let integrationReason: string | null = null;
let polling: Promise<void> | undefined;
const lifecycle = new DesktopLifecycle((exited) => new DesktopBackend(options.configPath, {
  executable: process.execPath, entry: fileURLToPath(new URL("./backend-entry.js", import.meta.url)), electron: true,
}, exited), changed);

function view(): LifecycleView {
  const state = lifecycle.snapshot();
  const saved = notifications?.state;
  return { ...state, ...(uiCode ? { code: uiCode, ...(state.phase === "starting" || state.phase === "stopping" ? {} : { phase: "failed" as const }) } : {}), intent,
    desktop: { trayAvailable: !!saved && !!tray?.available(), hidden: !!window && !visible(window) && !visible(control), closeNotice,
      reason: integrationReason, notificationSupported: app.isReady() && nativeNotices.supported(), settings: saved ? { ...saved.settings } : null,
      notices: saved?.history.slice().reverse().map((event) => ({ id: event.id, title: (event.provider === "mock" ? "模拟环境 · " : "") + noticeCopy[event.kind].title,
        body: noticeCopy[event.kind].body, createdAt: event.createdAt, delivery: event.delivery })) ?? [] } };
}
const nativeNotices = new ElectronNotices((id) => { void openNotice(id).catch(reportIntegration); });
function visible(target: BrowserWindow | undefined): boolean { return !!target && !target.isDestroyed() && target.isVisible(); }
function publish() {
  const state = view();
  if (control && !control.isDestroyed()) control.webContents.send("desktop-lifecycle:changed", state);
  tray?.update(state);
}
function showControl() { if (control && !control.isDestroyed()) { control.show(); control.focus(); publish(); } }
function showMain() {
  if (!window || window.isDestroyed()) return;
  background = false; closeNotice = false;
  if (window.isMinimized()) window.restore();
  window.show(); window.focus();
}
function presentManagement() {
  const state = lifecycle.snapshot();
  if (window && !window.isDestroyed() && state.phase === "running" && state.connection
    && isManagementNavigation(window.webContents.getURL(), state.connection.url)
    && !intent && !exiting && !uiCode && !background) { showMain(); control?.hide(); }
}
function activateMain() {
  if (view().phase === "running" && !intent && !exiting && window && !window.isDestroyed() && isManagementNavigation(window.webContents.getURL(), lifecycle.snapshot().connection?.url ?? "")) {
    showMain(); control?.hide(); publish();
  } else showControl();
}
function reportIntegration(error: unknown) {
  const code = error instanceof AppError ? error.code : "DESKTOP_INTEGRATION_FAILED";
  const changed = integrationReason !== code; integrationReason = code;
  if (changed || !visible(window) && !visible(control)) showControl(); publish();
}
function operationError(error: unknown) {
  if (error instanceof AppError && /^(DESKTOP_STATE|NOTICE_|TRAY_)/.test(error.code)) reportIntegration(error); else report(error);
}
const visibility = new DesktopVisibility({
  available: () => !!notifications?.state && !!tray?.available(),
  stopping: () => !!exiting || lifecycle.snapshot().phase === "stopping",
  explainOnce: () => notifications!.explainClose(),
  hide(first) { background = true; closeNotice = first; intent = null; if (window && !window.isDestroyed()) window.hide(); if (control && !control.isDestroyed()) control.hide(); if (first) showControl(); publish(); },
  unavailable() { integrationReason ??= "TRAY_UNAVAILABLE"; intent = "exit"; showControl(); publish(); },
  progress: showControl,
});
function hideClient(): Promise<void> { return visibility.hide(); }
async function openNotice(id: string) {
  const notice = notifications?.state?.history.find((item) => item.id === id);
  if (!notice) throw new AppError("NOTICE_NOT_FOUND", "通知记录已过期。");
  const before = lifecycle.snapshot();
  if (before.phase !== "running" || !before.connection || intent || exiting) { showControl(); return; }
  const checkpoint = notifications!.state!.checkpoint;
  const verified = await lifecycle.desktopFeed({ scope: checkpoint.scope, cursor: checkpoint.cursor });
  const current = lifecycle.snapshot();
  if (current.phase !== "running" || current.connection?.url !== before.connection.url) { showControl(); return; }
  if (notice.scope !== null && notice.scope !== verified.scope) throw new AppError("NOTICE_SOURCE_CHANGED", "通知属于其他数据源，请核对原配置。");
  background = false; closeNotice = false;
  loadManagement(current.connection.url, notice.runId ? `#runs/${encodeURIComponent(notice.runId)}` : `#${notice.target}`);
}
function pollNotifications(): Promise<void> {
  if (polling) return polling;
  if (integrationStopping || !notifications?.state || ["idle", "starting", "stopping", "stopped"].includes(lifecycle.snapshot().phase)) return Promise.resolve();
  return polling = (async () => {
    let feed;
    try { const checkpoint = notifications!.state!.checkpoint; feed = await lifecycle.desktopFeed({ scope: checkpoint.scope, cursor: checkpoint.cursor }); }
    catch (error) { if (error instanceof AppError && error.code === "RUNTIME_INCOMPATIBLE") { reportIntegration(error); return; } feed = null; }
    if (!integrationStopping) {
      try { await notifications!.accept(feed); }
      catch (error) { reportIntegration(error); }
    }
  })().finally(() => { polling = undefined; });
}
function report(error: unknown) {
  uiCode = error instanceof AppError ? error.code : "DESKTOP_OPERATION_FAILED";
  showControl();
}
function loadManagement(url: string, hash = "") {
  if (!window || window.isDestroyed()) { reportIntegration(new AppError("DESKTOP_WINDOW_CLOSED", "主窗口已销毁，请安全退出后重新打开客户端。")); return; }
  loadedUrl = url;
  const loading = ++navigation;
  void window!.loadURL(url + hash).then(() => {
    if (loading === navigation) presentManagement();
  }).catch((error: unknown) => {
    if (loading !== navigation || lifecycle.snapshot().phase !== "running") return;
    if (!isAbortedNavigation(error)) { report(error); return; }
    // Refresh can target the previous committed page while the new endpoint is still loading.
    // Reopen only the current verified management URL; this never restarts the backend or a task.
    setImmediate(() => {
      if (loading === navigation && lifecycle.snapshot().phase === "running" && lifecycle.snapshot().connection?.url === url && !exiting) {
        loadManagement(url, hash);
      }
    });
  });
}
function changed(state: LifecycleState) {
  if (state.phase === "starting") { loadedUrl = ""; navigation++; }
  publish();
  if (state.phase === "running" && state.connection) {
    if (loadedUrl !== state.connection.url) {
      if (!window || window.isDestroyed()) { reportIntegration(new AppError("DESKTOP_WINDOW_CLOSED", "主窗口已销毁，请安全退出后重新打开客户端。")); return; }
      window!.setTitle(`Codex 任务助手${state.connection.owned ? "" : " · 已连接外部服务"}`);
      loadManagement(state.connection.url);
    }
  } else if (["failed", "disconnected", "stopping", "stopped"].includes(state.phase)) {
    if (window && !window.isDestroyed()) window.hide();
    if (state.phase === "failed" || state.phase === "stopped") loadedUrl = "";
    if (!background || !tray?.available()) showControl();
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
    integrationStopping = true;
    intent = null; uiCode = null;
    await starting?.catch(() => {});
    if (lifecycle.snapshot().connection?.owned) await lifecycle.stop(mode);
    else await lifecycle.detach();
    await polling?.catch(() => {}); await notifications?.close();
    allowQuit = true; app.quit();
  })().catch((error: unknown) => { integrationStopping = false; exiting = undefined; report(error); });
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
  if (action === "hide") { await hideClient(); return; }
  if (action === "show") { activateMain(); return; }
  if (action === "pause") { await lifecycle.pauseDispatch(); publish(); return; }
  if (action === "notifications-toggle" || action === "quota-notifications-toggle") {
    if (integrationStopping) throw new AppError("RUNTIME_STOPPING", "安全退出期间不能修改通知偏好。");
    if (!notifications?.state) throw new AppError("DESKTOP_STATE_INVALID", "通知设置不可用，请核对桌面状态文件。");
    await notifications.preference(action === "notifications-toggle" ? "enabled" : "quotaReset"); return;
  }
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
    if (selected === "restart") { background = false; await lifecycle.restart(action); }
    else await lifecycle.stop(action, selected === "stop-external");
    return;
  }
  if (action === "start") { background = false; await connect(); return; }
  if (action === "status") { uiCode = null; await lifecycle.check(); showControl(); publish(); return; }
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
  if (process.platform === "win32") app.setAppUserModelId("local.codex-quota-scheduler");
  if (options.debugging) app.commandLine.appendSwitch("remote-debugging-address", "127.0.0.1");
  if (!app.requestSingleInstanceLock()) { allowQuit = true; app.quit(); return; }
  app.on("second-instance", activateMain);
  app.on("will-quit", () => tray?.destroy());
  app.on("before-quit", (event) => { if (!allowQuit) { event.preventDefault(); void requestExit().catch(report); } });
  process.on("SIGINT", () => { void exitClient("cancel"); });
  process.on("SIGTERM", () => { void exitClient("cancel"); });
  await app.whenReady();
  const desktopSession = session.fromPartition("cqs-desktop");
  desktopSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  desktopSession.setPermissionCheckHandler(() => false);
  window = new BrowserWindow({ title: "Codex 任务助手", width: 1200, height: 800, minWidth: 960, minHeight: 640,
    backgroundColor: "#f5f7fa", show: false, webPreferences: { ...desktopWebPreferences, session: desktopSession,
      preload: fileURLToPath(new URL("./project-preload.cjs", import.meta.url)) } });
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
  window.on("close", (event) => { if (!allowQuit) { event.preventDefault(); void hideClient().catch(reportIntegration); } });
  window.on("closed", () => { if (!allowQuit) { integrationReason = "DESKTOP_WINDOW_CLOSED"; showControl(); publish(); } });
  window.webContents.on("did-finish-load", presentManagement);
  window.webContents.on("did-stop-loading", presentManagement);
  control.on("close", (event) => {
    if (allowQuit) return;
    event.preventDefault();
    void hideClient().catch(reportIntegration);
  });
  registerLifecycleControl(control, controlPage.href, { view, command, failed: operationError, openNotice });
  registerProjectDirectory(window, () => lifecycle.snapshot().phase === "running" ? lifecycle.snapshot().connection?.url ?? null : null);
  const invoke = (action: LifecycleCommand) => { void command(action).catch(operationError); };
  notifications = new DesktopNotifications(new NotificationStore(join(options.dataDir, "desktop-state.json")), nativeNotices, publish);
  try { await notifications.initialize(); } catch (error) { integrationReason = error instanceof AppError ? error.code : "DESKTOP_STATE_INVALID"; }
  tray = new DesktopTray(invoke);
  if (!tray.create()) integrationReason ??= "TRAY_UNAVAILABLE";
  Menu.setApplicationMenu(Menu.buildFromTemplate([{ label: "后台服务", submenu: [
    { label: "服务状态与通知…", click: showControl }, { label: "隐藏到托盘", click: () => invoke("hide") }, { label: "重新连接 / 启动", click: () => invoke("start") },
    { label: "关闭窗口到托盘", role: "close", accelerator: "CommandOrControl+W" },
    { label: "重启自有后台…", click: () => invoke("restart") }, { label: "停止自有后台…", click: () => invoke("stop") },
    { label: "停止外部服务…", click: () => invoke("stop-external") }, { type: "separator" }, { label: "退出客户端", click: () => invoke("exit") },
  ] }]));
  const health = setInterval(() => { void lifecycle.check(); void pollNotifications(); }, 3000);
  health.unref();
  powerMonitor.on("resume", () => { void lifecycle.check(); void pollNotifications(); });
  await control.loadFile(fileURLToPath(controlPage));
  showControl();
  await connect();
  await pollNotifications(); publish();
}
void main().catch((error: unknown) => {
  if (control) report(error);
  else { console.error("DESKTOP_START_FAILED"); allowQuit = true; app.quit(); }
});
