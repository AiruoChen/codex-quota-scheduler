import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from "electron";
import { lifecycleCommands, type LifecycleCommand, type LifecycleView } from "../../domain/lifecycle.js";
import { AppError } from "../../shared/errors.js";

/** Only the registered local control window's top frame can use this fixed protocol. */
export function registerLifecycleControl(window: BrowserWindow, pageUrl: string, callbacks: {
  view(): LifecycleView; command(command: LifecycleCommand): Promise<void>; failed(error: unknown): void; openNotice(id: string): Promise<void>;
}): void {
  const validate = (event: IpcMainInvokeEvent) => {
    if (window.isDestroyed() || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame
      || event.senderFrame?.url !== pageUrl) throw new AppError("HTTP_FORBIDDEN", "仅允许本机状态窗口控制生命周期。");
  };
  ipcMain.handle("desktop-lifecycle:read", (event) => { validate(event); return callbacks.view(); });
  ipcMain.handle("desktop-lifecycle:command", async (event, value: unknown) => {
    validate(event);
    if (typeof value !== "string" || !lifecycleCommands.includes(value as LifecycleCommand)) throw new AppError("INVALID_ARGUMENT", "未知生命周期操作。");
    try { await callbacks.command(value as LifecycleCommand); }
    catch (error) { callbacks.failed(error); throw error; }
  });
  ipcMain.handle("desktop-notices:open", async (event, id: unknown) => {
    validate(event);
    if (typeof id !== "string" || !/^[a-f0-9-]{36}$/.test(id)) throw new AppError("INVALID_ARGUMENT", "通知标识无效。");
    await callbacks.openNotice(id);
  });
  window.once("closed", () => {
    ipcMain.removeHandler("desktop-lifecycle:read"); ipcMain.removeHandler("desktop-lifecycle:command");
    ipcMain.removeHandler("desktop-notices:open");
  });
}
