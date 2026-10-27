import { randomUUID } from "node:crypto";
import { notificationTransition, type DesktopFeed } from "../domain/notifications.js";
import { systemClock, type Clock } from "../domain/ports.js";
import { NotificationStore, type DesktopState, type StoredNotice } from "./notification-store.js";

export interface NoticeChannel { supported(): boolean; show(notice: StoredNotice, failed: () => void): void; close(): void }
export class DesktopNotifications {
  state: DesktopState | null = null;
  private stopped = false;
  constructor(readonly store: NotificationStore, private readonly native: NoticeChannel, private readonly changed: () => void,
    private readonly clock: Clock = systemClock) {}
  private remember(state: DesktopState) { if (!this.state || state.revision >= this.state.revision) this.state = state; this.changed(); }
  async initialize(): Promise<void> { this.remember(await this.store.initialize()); }
  async preference(key: keyof DesktopState["settings"]): Promise<void> {
    this.remember(await this.store.update((state) => { state.settings[key] = !state.settings[key]; }));
  }
  async explainClose(): Promise<boolean> {
    let first = false;
    this.remember(await this.store.update((state) => { first = !state.settings.closeExplained; state.settings.closeExplained = true; }));
    return first;
  }
  async accept(feed: DesktopFeed | null): Promise<void> {
    if (this.stopped || !this.state) return;
    const created: StoredNotice[] = [];
    const state = await this.store.update((state) => {
      if (feed) state.provider = feed.provider;
      const transition = notificationTransition(state.checkpoint, feed, this.clock.now()); state.checkpoint = transition.checkpoint;
      for (const event of transition.notices) {
        const enabled = state.settings.enabled && (event.kind !== "quota_reset" || state.settings.quotaReset);
        created.push({ key: event.key, kind: event.kind, runId: event.runId, target: event.target, createdAt: event.createdAt,
          provider: state.provider, id: randomUUID(), scope: transition.checkpoint.scope, delivery: !enabled ? "disabled" : this.native.supported() ? "attempted" : "unsupported" });
      }
      const eligible = created.filter((item) => item.delivery === "attempted");
      for (const item of eligible.slice(0, Math.max(0, eligible.length - 3))) item.delivery = "local";
      state.history = [...state.history, ...created].slice(-50);
    });
    this.remember(state);
    // Commit before attempting OS delivery: a crash cannot blindly replay an uncertain display attempt.
    for (const notice of created.filter((item) => item.delivery === "attempted").slice(-3)) {
      if (this.stopped || !this.state?.settings.enabled || notice.kind === "quota_reset" && !this.state.settings.quotaReset) continue;
      const failed = () => { void this.store.update((state) => { const saved = state.history.find((item) => item.id === notice.id); if (saved) saved.delivery = "failed"; }).then((state) => this.remember(state)).catch(() => {}); };
      try { this.native.show(notice, failed); } catch { failed(); }
    }
  }
  async close(): Promise<void> { this.stopped = true; this.native.close(); await this.store.settled(); }
}
