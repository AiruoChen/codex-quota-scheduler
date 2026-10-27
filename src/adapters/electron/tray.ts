import { Menu, Tray, nativeImage, type NativeImage } from "electron";
import type { LifecycleCommand, LifecycleView } from "../../domain/lifecycle.js";

/** Code-native icon: no downloaded asset, user data or runtime file dependency. */
export function trayImage(): NativeImage {
  const size = 32, pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const cornerX = Math.max(0, 6 - x, x - 25), cornerY = Math.max(0, 6 - y, y - 25);
    if (cornerX * cornerX + cornerY * cornerY > 36) continue;
    const radius = Math.hypot(x - 15.5, y - 15.5);
    const letter = radius > 6 && radius < 10 && !(x > 19 && Math.abs(y - 15.5) < 6);
    const index = (y * size + x) * 4;
    pixels[index] = letter ? 227 : 67; pixels[index + 1] = letter ? 246 : 93; pixels[index + 2] = letter ? 233 : 30; pixels[index + 3] = 255;
  }
  return nativeImage.createFromBitmap(pixels, { width: size, height: size, scaleFactor: 1 });
}

export class DesktopTray {
  private tray: Tray | undefined;
  private lastMenu = "";
  constructor(private readonly command: (action: LifecycleCommand) => void) {}
  create(): boolean {
    try { this.tray = new Tray(trayImage()); this.tray.on("click", () => this.command("show")); this.tray.on("double-click", () => this.command("show")); return true; }
    catch { this.tray = undefined; return false; }
  }
  available(): boolean { return !!this.tray && !this.tray.isDestroyed(); }
  update(view: LifecycleView): void {
    if (!this.available()) return;
    const ready = view.phase === "running", busy = ["starting", "stopping"].includes(view.phase), state = view.desktop;
    const signature = JSON.stringify([view.phase, view.activity, view.connection?.owned, state?.settings]);
    if (signature === this.lastMenu) return; this.lastMenu = signature;
    const status = !ready ? "后台需要检查" : view.activity?.paused ? "派发已暂停" : "派发已恢复";
    this.tray!.setToolTip(`Codex 任务助手 · ${status}${view.activity?.activeOperations ? " · 有活动任务" : ""}`);
    this.tray!.setContextMenu(Menu.buildFromTemplate([
      { label: `Codex 任务助手 · ${status}`, enabled: false }, { type: "separator" },
      { label: "打开主窗口", click: () => this.command("show") }, { label: "服务状态与通知记录", click: () => this.command("status") },
      { label: view.connection?.owned === false ? "暂停外部服务派发" : "暂停派发（当前任务继续）", enabled: ready && !view.activity?.paused, click: () => this.command("pause") },
      { type: "separator" },
      { label: "系统通知", type: "checkbox", checked: state?.settings?.enabled ?? false, enabled: !!state?.settings, click: () => this.command("notifications-toggle") },
      { label: "通知已确认的额度刷新", type: "checkbox", checked: state?.settings?.quotaReset ?? false, enabled: !!state?.settings, click: () => this.command("quota-notifications-toggle") },
      { type: "separator" }, { label: "安全退出…", enabled: !busy, click: () => this.command("exit") },
    ]));
  }
  destroy(): void { this.tray?.destroy(); this.tray = undefined; }
}
