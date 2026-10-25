import { contextBridge, ipcRenderer } from "electron";
contextBridge.exposeInMainWorld("desktopProject", Object.freeze({
  chooseDirectory: (): Promise<string | null> => ipcRenderer.invoke("desktop-project:choose"),
}));
