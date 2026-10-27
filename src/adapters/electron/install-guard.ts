import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { AppError } from "../../shared/errors.js";

/** Installed builds include a tiny fixed native probe; it only checks the installer's mutex. */
export function checkInstallGuard(packaged: boolean, executable: string): void {
  if (!packaged || process.platform !== "win32") return;
  const probe = join(dirname(executable), "maintenance-guard.exe");
  if (!existsSync(probe)) return; // Existing portable distributions have no installer integration.
  const result = spawnSync(probe, [], { windowsHide: true, timeout: 5000, stdio: "ignore" });
  if (result.error || result.status !== 0) throw new AppError("INSTALLER_BUSY", "安装或卸载正在进行，或维护状态无法验证。请完成安装后重试，必要时核对安装文件。");
}
