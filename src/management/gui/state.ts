import type { ManagementState } from "../contracts.js";
export interface ViewState { data: ManagementState | null; connected: boolean; expired: boolean; error: string | null }

/** One shared read, one clock anchor. Failures preserve history but invalidate live quota. */
export class StateStore {
  value: ViewState = { data: null, connected: false, expired: false, error: null };
  private pending: Promise<void> | undefined;
  private receivedAt = 0;
  private expiryRequested = "";
  constructor(private readonly read: () => Promise<ManagementState>, private readonly changed: (state: ViewState) => void,
    private readonly monotonic: () => number = () => performance.now()) {}
  refresh(): Promise<void> {
    return this.pending ??= this.read().then((data) => {
      this.receivedAt = this.monotonic(); this.value = { data, connected: true, expired: false, error: null }; this.changed(this.value);
    }).catch((error: unknown) => {
      this.value = { ...this.value, connected: false, expired: true, error: error instanceof Error ? error.message : "服务连接失败" };
      this.changed(this.value);
    }).finally(() => { this.pending = undefined; });
  }
  now(): number { return Date.parse(this.value.data?.now ?? "") + Math.max(0, this.monotonic() - this.receivedAt); }
  tick(): boolean {
    const deadline = this.value.data?.quota.validUntil;
    if (!this.value.connected || !deadline || this.now() < Date.parse(deadline)) return false;
    if (!this.value.expired) { this.value = { ...this.value, expired: true }; this.changed(this.value); }
    // A countdown never grants availability. It can only request one full read for this boundary.
    if (deadline === this.expiryRequested) return false;
    this.expiryRequested = deadline; return true;
  }
}
