import { contextBridge, ipcRenderer } from "electron";
import type { LifecycleCommand, LifecycleView } from "../domain/lifecycle.js" with { "resolution-mode": "import" };
import type { DesktopDataView } from "../domain/data-transfer.js" with { "resolution-mode": "import" };

contextBridge.exposeInMainWorld("desktopLifecycle", Object.freeze({
  read: (): Promise<LifecycleView> => ipcRenderer.invoke("desktop-lifecycle:read"),
  command: (command: LifecycleCommand): Promise<void> => ipcRenderer.invoke("desktop-lifecycle:command", command),
  openNotice: (id: string): Promise<void> => ipcRenderer.invoke("desktop-notices:open", id),
  onChange: (listener: (view: LifecycleView) => void) => {
    const receive = (_event: Electron.IpcRendererEvent, view: LifecycleView) => listener(view);
    ipcRenderer.on("desktop-lifecycle:changed", receive);
    return () => ipcRenderer.removeListener("desktop-lifecycle:changed", receive);
  },
}));
contextBridge.exposeInMainWorld("desktopData", Object.freeze({
  read: (): Promise<DesktopDataView> => ipcRenderer.invoke("desktop-data:read"),
  openDirectory: (): Promise<void> => ipcRenderer.invoke("desktop-data:open-directory"),
  action: (action: string, value?: string, confirmed = false): Promise<void> => ipcRenderer.invoke("desktop-data:action", action, value, confirmed),
  onFocus: (listener: () => void) => {
    const receive = () => listener(); ipcRenderer.on("desktop-data:focus", receive);
    return () => ipcRenderer.removeListener("desktop-data:focus", receive);
  },
}));
