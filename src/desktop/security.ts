/** No page gets privileged Node or preload APIs. All mutations retain the HTTP session and CSRF checks. */
export const desktopWebPreferences = {
  nodeIntegration: false, nodeIntegrationInWorker: false, nodeIntegrationInSubFrames: false,
  contextIsolation: true, sandbox: true, webSecurity: true, webviewTag: false,
} as const;

export function isManagementNavigation(value: string, origin: string): boolean {
  try {
    const url = new URL(value);
    return url.origin === origin && url.pathname === "/" && url.search === "" && !url.username && !url.password;
  } catch { return false; }
}
