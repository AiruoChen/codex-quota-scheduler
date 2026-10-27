import { app, BrowserWindow, dialog, Menu, session } from "electron";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DesktopBackend } from "./backend.js";
import { desktopOptions, initializeDesktopProfile } from "./profile.js";
import { desktopWebPreferences, isManagementNavigation } from "./security.js";
import { AppError } from "../shared/errors.js";

app.setName("CodexQuotaScheduler");
let window: BrowserWindow | undefined;
let backend: DesktopBackend | undefined;
let startup: Promise<void> | undefined;
let quitting: Promise<void> | undefined;
let canQuit = false;

function foreground() {
  if (!window || window.isDestroyed()) return;
  if (window.isMinimized()) window.restore();
  window.show(); window.focus();
}

async function quitSafely() {
  return quitting ??= (async () => {
    if (window && !window.isDestroyed()) { window.setTitle("正在安全退出，请等待结果保存…"); window.setEnabled(false); }
    await startup?.catch(() => {});
    await backend?.close();
    canQuit = true;
    app.quit();
  })().catch(() => {
    quitting = undefined;
    if (window && !window.isDestroyed()) window.setEnabled(true);
    dialog.showErrorBox("退出尚未完成", "无法确认后台已安全结束。请保留窗口并检查运行状态，不要重复提交任务。");
  });
}

async function start() {
  const options = desktopOptions(process.argv.slice(app.isPackaged ? 1 : 2), join(app.getPath("appData"), "CodexQuotaScheduler"));
  app.setPath("userData", options.dataDir);
  if (options.debugging) app.commandLine.appendSwitch("remote-debugging-address", "127.0.0.1");
  if (!app.requestSingleInstanceLock()) { canQuit = true; app.quit(); return; }
  app.on("second-instance", foreground);
  app.on("before-quit", (event) => { if (!canQuit) { event.preventDefault(); void quitSafely(); } });
  process.on("SIGINT", () => { void quitSafely(); });
  process.on("SIGTERM", () => { void quitSafely(); });
  await app.whenReady();
  Menu.setApplicationMenu(null);
  const desktopSession = session.fromPartition("cqs-desktop");
  desktopSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  desktopSession.setPermissionCheckHandler(() => false);
  window = new BrowserWindow({ title: "Codex 任务助手", width: 1200, height: 800, minWidth: 960, minHeight: 640,
    backgroundColor: "#f5f7fa", show: false, webPreferences: { ...desktopWebPreferences, session: desktopSession } });
  window.on("close", (event) => { if (!canQuit) { event.preventDefault(); void quitSafely(); } });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-attach-webview", (event) => event.preventDefault());
  const startupPage = new URL("./public/startup.html", import.meta.url);
  let origin = "";
  const allowNavigation = (event: Electron.Event, url: string) => {
    if (url !== startupPage.href && !isManagementNavigation(url, origin)) event.preventDefault();
  };
  window.webContents.on("will-navigate", allowNavigation);
  window.webContents.on("will-redirect", allowNavigation);
  await window.loadFile(fileURLToPath(startupPage));
  window.show();
  startup = (async () => {
    await initializeDesktopProfile(options);
    backend = new DesktopBackend(options.configPath, { executable: process.execPath,
      entry: fileURLToPath(new URL("./backend-entry.js", import.meta.url)), electron: true }, () => {
      dialog.showErrorBox("后台已停止", "后台进程意外退出。运行记录会保留，请下次启动时核对异常状态，不要直接重发任务。");
      void quitSafely();
    });
    const connection = await backend.start();
    if (quitting) return;
    origin = connection.url;
    window!.setTitle(`Codex 任务助手${connection.owned ? "" : " · 已连接现有服务"}`);
    await window!.loadURL(connection.url);
  })();
  await startup;
}

void start().catch(async (error: unknown) => {
  const code = error instanceof AppError ? error.code : "DESKTOP_START_FAILED";
  dialog.showErrorBox("客户端启动失败", `${code}\n请检查配置、数据权限和本地运行记录。不会自动修复执行权或重新提交任务。`);
  await quitSafely();
});
