import { Notification } from "electron";
import { noticeCopy } from "../../domain/notifications.js";
import type { NoticeChannel } from "../../desktop/notifications.js";
import type { StoredNotice } from "../../desktop/notification-store.js";

export class ElectronNotices implements NoticeChannel {
  private readonly active = new Map<string, Notification>();
  private stopped = false;
  constructor(private readonly open: (id: string) => void) {}
  supported(): boolean { return Notification.isSupported(); }
  show(notice: StoredNotice, failed: () => void): void {
    if (this.stopped) return;
    const copy = noticeCopy[notice.kind];
    const notification = new Notification({ title: (notice.provider === "mock" ? "模拟环境 · " : "") + copy.title, body: copy.body, silent: false });
    notification.on("click", () => { if (!this.stopped) this.open(notice.id); });
    notification.on("failed", () => { if (!this.stopped) failed(); });
    this.active.set(notice.id, notification);
    while (this.active.size > 50) { const [id, oldest] = this.active.entries().next().value!; oldest.close(); this.active.delete(id); }
    notification.show();
  }
  close(): void { this.stopped = true; for (const notification of this.active.values()) notification.close(); this.active.clear(); }
}
