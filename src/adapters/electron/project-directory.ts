import { dialog, ipcMain, type BrowserWindow } from "electron";
import { ProjectPicker } from "../../desktop/project-picker.js";
import { isManagementNavigation } from "../../desktop/security.js";

export function registerProjectDirectory(window: BrowserWindow, currentOrigin: () => string | null) {
  const picker = new ProjectPicker({
    trusted: () => false,
    async pick() {
      const result = await dialog.showOpenDialog(window, { title: "选择任务项目目录", buttonLabel: "使用此目录", properties: ["openDirectory", "dontAddToRecent"] });
      return result.canceled ? null : result.filePaths[0] ?? null;
    },
  });
  ipcMain.handle("desktop-project:choose", (event, ...args: unknown[]) => {
    if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) return Promise.reject(new Error("HTTP_FORBIDDEN"));
    const frame = event.senderFrame, origin = currentOrigin();
    return picker.choose(args, () => !window.isDestroyed() && origin !== null && origin === currentOrigin()
      && frame === window.webContents.mainFrame && isManagementNavigation(frame?.url ?? "", origin));
  });
  window.once("closed", () => ipcMain.removeHandler("desktop-project:choose"));
}
