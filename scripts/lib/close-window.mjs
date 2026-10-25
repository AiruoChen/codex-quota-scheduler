import { execFileSync } from "node:child_process";
import { join } from "node:path";

/** Send WM_CLOSE only to the one visible management window of this owned test process. */
export async function closeWindow(page, processId) {
  if (process.platform !== "win32" || !Number.isSafeInteger(processId) || processId < 1) {
    throw new Error("Native close acceptance requires an owned Windows process");
  }
  await page.call("Page.bringToFront");
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
  if (!systemRoot) throw new Error("Windows system directory unavailable");
  const native = `using System;using System.Text;using System.Runtime.InteropServices;
public static class SchedulerCloseProbe {
 delegate bool EnumProc(IntPtr h,IntPtr p);
 [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb,IntPtr p);
 [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h,out uint p);
 [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr h,StringBuilder t,int n);
 [DllImport("user32.dll")] static extern bool PostMessage(IntPtr h,uint m,IntPtr w,IntPtr l);
 public static bool Close(uint owner) {
  IntPtr target=IntPtr.Zero;int count=0;
  EnumWindows(delegate(IntPtr h,IntPtr p){uint id;GetWindowThreadProcessId(h,out id);
   if(id==owner && IsWindowVisible(h)){var title=new StringBuilder(256);GetWindowText(h,title,256);
    if(title.ToString().StartsWith("Codex",StringComparison.Ordinal)){target=h;count++;}}return true;},IntPtr.Zero);
  return count==1 && PostMessage(target,0x10,IntPtr.Zero,IntPtr.Zero);
 }
}`;
  const script = "$ErrorActionPreference='Stop';Add-Type -TypeDefinition @'\n" + native
    + "\n'@;\nif(-not [SchedulerCloseProbe]::Close(" + processId + ")){throw 'Owned management window not uniquely identified'}";
  execFileSync(join(systemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe"),
    ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", script],
    { windowsHide: true, timeout: 10000, stdio: ["ignore", "pipe", "pipe"] });
}
