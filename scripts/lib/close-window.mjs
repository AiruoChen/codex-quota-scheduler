import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";

const executeFile = promisify(execFile);

/** Send WM_CLOSE only to the one visible management window of this owned test process. */
export async function closeWindow(page, processId, {
  platform = process.platform, systemRoot = process.env.SystemRoot ?? process.env.WINDIR, execute = executeFile,
} = {}) {
  if (platform !== "win32" || !Number.isSafeInteger(processId) || processId < 1) {
    throw new Error("NATIVE_CLOSE_UNSUPPORTED");
  }
  await page.call("Page.bringToFront");
  if (!systemRoot) throw new Error("NATIVE_CLOSE_SYSTEM_UNAVAILABLE");
  const native = `using System;using System.Text;using System.Runtime.InteropServices;
public static class SchedulerCloseProbe {
 delegate bool EnumProc(IntPtr h,IntPtr p);
 [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb,IntPtr p);
 [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h,out uint p);
 [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr h,StringBuilder t,int n);
 [DllImport("user32.dll")] static extern bool PostMessage(IntPtr h,uint m,IntPtr w,IntPtr l);
 public static int Close(uint owner) {
  IntPtr target=IntPtr.Zero;int count=0;
  EnumWindows(delegate(IntPtr h,IntPtr p){uint id;GetWindowThreadProcessId(h,out id);
   if(id==owner && IsWindowVisible(h)){var title=new StringBuilder(256);GetWindowText(h,title,256);
    if(title.ToString().StartsWith("Codex",StringComparison.Ordinal)){target=h;count++;}}return true;},IntPtr.Zero);
  if(count==0)return 10;
  if(count!=1)return 11;
  return PostMessage(target,0x10,IntPtr.Zero,IntPtr.Zero)?0:12;
 }
}`;
  const script = "$ErrorActionPreference='Stop';Add-Type -TypeDefinition @'\n" + native
    + "\n'@;\nexit [SchedulerCloseProbe]::Close(" + processId + ")";
  try {
    // Cold PowerShell/Add-Type startup shares the CI worker with Windows services.
    // Keep a bounded deadline without blocking CDP events in this process.
    await execute(join(systemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe"),
      ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", script],
      { windowsHide: true, timeout: 30000, maxBuffer: 65536 });
  } catch (error) {
    const code = error?.killed || error?.code === "ETIMEDOUT" ? "TIMEOUT"
      : error?.code === 10 ? "WINDOW_MISSING" : error?.code === 11 ? "WINDOW_AMBIGUOUS"
      : error?.code === 12 ? "POST_FAILED" : "FAILED";
    // Never forward the command, stderr, title, private path or raw child error.
    throw new Error("NATIVE_CLOSE_" + code);
  }
}
