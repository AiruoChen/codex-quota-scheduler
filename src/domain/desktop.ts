export interface DesktopStatus {
  trayAvailable: boolean; hidden: boolean; closeNotice: boolean; reason: string | null; notificationSupported: boolean;
  settings: { enabled: boolean; quotaReset: boolean; closeExplained: boolean } | null;
  notices: { id: string; title: string; body: string; createdAt: string; delivery: string }[];
}
