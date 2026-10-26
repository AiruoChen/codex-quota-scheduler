import { dialog, ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from "electron";
import type { DesktopDataView } from "../../domain/data-transfer.js";
import { AppError } from "../../shared/errors.js";

export type DataAction = "stop" | "preview" | "commit" | "backup" | "switch" | "prepare-upgrade";
export function registerDataTransfer(window: BrowserWindow, page: string, callbacks: {
  view(): Promise<DesktopDataView>; action(action: DataAction, value?: string): Promise<void>;
  preview(path: string): Promise<void>;
  openDirectory(): Promise<void>;
}): void {
  const validate = (event: IpcMainInvokeEvent) => {
    if (window.isDestroyed() || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url !== page) {
      throw new AppError("HTTP_FORBIDDEN", "仅允许本机状态窗口管理数据。");
    }
  };
  ipcMain.handle("desktop-data:read", async (event) => { validate(event); return callbacks.view(); });
  ipcMain.handle("desktop-data:open-directory", async (event, ...args: unknown[]) => {
    validate(event);
    if (args.length) throw new AppError("INVALID_ARGUMENT", "打开数据目录不接受路径参数。");
    try { await callbacks.openDirectory(); }
    catch { throw new Error("DESKTOP_OPEN_DIRECTORY_FAILED"); }
  });
  ipcMain.handle("desktop-data:action", async (event, action: unknown, value: unknown, confirmed: unknown) => {
    validate(event);
    try {
      if (!["stop", "preview", "commit", "backup", "switch", "prepare-upgrade"].includes(String(action))) throw new AppError("INVALID_ARGUMENT", "未知数据操作。");
      if (action !== "preview" && confirmed !== true) throw new AppError("CONFIRM_REQUIRED", "请先确认操作范围及暂停/等待行为。");
      if (["commit", "switch"].includes(String(action)) && (typeof value !== "string" || !/^(default|[a-f0-9-]{36})$/.test(value))) {
        throw new AppError("INVALID_ARGUMENT", "数据配置标识无效。");
      }
      if (action === "preview") {
        const picked = await dialog.showOpenDialog(window, { title: "选择旧项目配置或备份中的 config.json", properties: ["openFile"], filters: [{ name: "JSON 配置", extensions: ["json"] }] });
        if (!picked.canceled && picked.filePaths.length === 1) await callbacks.preview(picked.filePaths[0]!);
      } else await callbacks.action(action as DataAction, typeof value === "string" ? value : undefined);
    } catch (error) {
      // Electron serializes Error.message, not custom properties. Expose only a stable code.
      throw new Error(error instanceof AppError ? error.code : "MIGRATION_FAILED");
    }
  });
  window.once("closed", () => {
    ipcMain.removeHandler("desktop-data:read"); ipcMain.removeHandler("desktop-data:action"); ipcMain.removeHandler("desktop-data:open-directory");
  });
}
