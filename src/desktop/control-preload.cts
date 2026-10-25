import { contextBridge, ipcRenderer } from "electron";
import type { LifecycleCommand, LifecycleView } from "../domain/lifecycle.js" with { "resolution-mode": "import" };

contextBridge.exposeInMainWorld("desktopLifecycle", Object.freeze({
  read: (): Promise<LifecycleView> => ipcRenderer.invoke("desktop-lifecycle:read"),
  command: (command: LifecycleCommand): Promise<void> => ipcRenderer.invoke("desktop-lifecycle:command", command),
  onChange: (listener: (view: LifecycleView) => void) => {
    const receive = (_event: Electron.IpcRendererEvent, view: LifecycleView) => listener(view);
    ipcRenderer.on("desktop-lifecycle:changed", receive);
    return () => ipcRenderer.removeListener("desktop-lifecycle:changed", receive);
  },
}));
