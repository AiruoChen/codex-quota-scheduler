import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";

/** Drive only the native file chooser belonging to this test's owned desktop PID. */
export async function pickConfig(processId, configPath) {
  if (process.platform !== "win32" || !Number.isSafeInteger(processId) || processId < 1) throw new Error("Owned Windows picker required");
  const script = `
$ErrorActionPreference='Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$ownerPid=${processId}
$condition=New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ProcessIdProperty,$ownerPid)
$dialog=$null
for($attempt=0;$attempt -lt 100;$attempt++) {
  $windows=[System.Windows.Automation.AutomationElement]::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children,$condition)
  $title=New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty,'选择旧项目配置或备份中的 config.json')
  foreach($candidate in $windows) {
    if($candidate.Current.Name -eq '选择旧项目配置或备份中的 config.json') {$dialog=$candidate;break}
    $nested=$candidate.FindFirst([System.Windows.Automation.TreeScope]::Descendants,$title)
    if($nested){$dialog=$nested;break}
  }
  if($dialog){break};Start-Sleep -Milliseconds 100
}
if(-not $dialog){throw 'Owned config picker missing'}
Add-Type -TypeDefinition @'
using System;using System.Text;using System.Threading;using System.Runtime.InteropServices;
public static class SchedulerPickerProbe {
 [StructLayout(LayoutKind.Sequential)] struct GuiInfo {public int Size;public uint Flags;public IntPtr Active,Focus,Capture,Menu,Move,Caret;public int L,T,R,B;}
 [DllImport("user32.dll")] static extern bool GetGUIThreadInfo(uint id,ref GuiInfo info);
 [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h,out uint pid);
 [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
 [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")] static extern void keybd_event(byte key,byte scan,uint flags,IntPtr extra);
 [DllImport("user32.dll")] static extern IntPtr SendMessage(IntPtr h,uint message,IntPtr w,IntPtr l);
 [DllImport("user32.dll",CharSet=CharSet.Unicode,EntryPoint="SendMessageW")] static extern IntPtr SetText(IntPtr h,uint message,IntPtr w,string text);
 [DllImport("user32.dll",CharSet=CharSet.Unicode,EntryPoint="SendMessageW")] static extern IntPtr ReadText(IntPtr h,uint message,IntPtr w,StringBuilder text);
 [DllImport("user32.dll")] static extern IntPtr GetDlgItem(IntPtr h,int id);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr h,StringBuilder t,int n);
 static void Key(byte key,bool up){keybd_event(key,0,up?2u:0u,IntPtr.Zero);}
 public static string Fill(long handle,uint owner,string path) {
  var dialog=new IntPtr(handle);uint pid;var thread=GetWindowThreadProcessId(dialog,out pid);
  if(pid!=owner)throw new Exception("Owned picker identity changed");
  SetForegroundWindow(dialog);Thread.Sleep(100);
  if(GetForegroundWindow()!=dialog)throw new Exception("Owned picker is not foreground");
  Key(0x12,false);Key(0x4E,false);Key(0x4E,true);Key(0x12,true);Thread.Sleep(150);
  var info=new GuiInfo();info.Size=Marshal.SizeOf(typeof(GuiInfo));
  if(!GetGUIThreadInfo(thread,ref info))throw new Exception("Owned filename focus missing");
  GetWindowThreadProcessId(info.Focus,out pid);var kind=new StringBuilder(100);GetClassName(info.Focus,kind,100);
  if(pid!=owner||kind.ToString()!="Edit")throw new Exception("Owned filename edit not focused");
  SetText(info.Focus,0x000C,IntPtr.Zero,path);
  var value=new StringBuilder(32768);ReadText(info.Focus,0x000D,new IntPtr(32768),value);
  if(value.ToString()!=path||GetForegroundWindow()!=dialog)throw new Exception("Owned filename value not applied");
  var button=GetDlgItem(dialog,1);if(button==IntPtr.Zero)throw new Exception("Owned open button missing");
  SendMessage(button,0xF5,IntPtr.Zero,IntPtr.Zero);return "filled";
 }
}
'@
$nativeResult=[SchedulerPickerProbe]::Fill($dialog.Current.NativeWindowHandle,${processId},$env:CQS_ACCEPTANCE_CONFIG)
if($nativeResult -ne 'filled'){throw 'Owned picker did not accept input'}
`;
  try { await promisify(execFile)(join(process.env.SystemRoot ?? "C:/Windows", "System32/WindowsPowerShell/v1.0/powershell.exe"),
    ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
    { windowsHide: true, timeout: 20000, env: { ...process.env, CQS_ACCEPTANCE_CONFIG: configPath } }); }
  catch (error) {
    const reason = String(error.stderr).match(/Owned [a-z ]+(?:missing|changed|foreground|focused|applied|input)/)?.[0];
    throw new Error("Native config picker automation failed: " + (reason ?? "UI Automation unavailable"));
  }
}
