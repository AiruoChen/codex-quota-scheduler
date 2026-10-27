import { app, dialog } from "electron";
import { checkInstallGuard } from "../adapters/electron/install-guard.js";

// Verify maintenance BEFORE importing the backend/lifecycle module graph.
app.setName("CodexQuotaScheduler");
try {
  checkInstallGuard(app.isPackaged, process.execPath);
  await import("./main.js");
} catch {
  dialog.showErrorBox("客户端暂时无法启动", "安装维护尚未完成或程序文件无法验证。请完成安装后重试；不要强制结束正在保存的任务。");
  app.exit(42);
}
