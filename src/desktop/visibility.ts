export interface VisibilityPort {
  available(): boolean; stopping(): boolean; explainOnce(): Promise<boolean>;
  hide(first: boolean): void; unavailable(): void; progress(): void;
}
/** Closing hides only when a discoverable tray and durable preferences are available. */
export class DesktopVisibility {
  private pending: Promise<void> | undefined;
  constructor(private readonly port: VisibilityPort) {}
  hide(): Promise<void> {
    return this.pending ??= (async () => {
      if (this.port.stopping()) { this.port.progress(); return; }
      if (!this.port.available()) { this.port.unavailable(); return; }
      const first = await this.port.explainOnce();
      if (this.port.stopping()) { this.port.progress(); return; }
      if (!this.port.available()) { this.port.unavailable(); return; }
      this.port.hide(first);
    })().finally(() => { this.pending = undefined; });
  }
}
