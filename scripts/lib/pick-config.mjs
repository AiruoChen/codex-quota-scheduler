import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isAbsolute, join } from "node:path";

/** Drive controls in the owned chooser without global keyboard input or foreground access. */
export async function pickConfig(processId, configPath) {
  if (process.platform !== "win32" || !Number.isSafeInteger(processId) || processId < 1
    || typeof configPath !== "string" || !isAbsolute(configPath) || configPath.includes("\0")) throw new Error("Owned Windows picker required");
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
    if($nested -and $nested.Current.ProcessId -eq $ownerPid){$dialog=$nested;break}
  }
  if($dialog){break};Start-Sleep -Milliseconds 100
}
if(-not $dialog -or $dialog.Current.ProcessId -ne $ownerPid){throw 'Owned config picker missing'}
$editCondition=New-Object System.Windows.Automation.AndCondition(
  (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::AutomationIdProperty,'1148')),
  (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ClassNameProperty,'Edit')))
$openCondition=New-Object System.Windows.Automation.AndCondition(
  (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::AutomationIdProperty,'1')),
  (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ClassNameProperty,'Button')))
$edit=$null;$open=$null
for($attempt=0;$attempt -lt 50;$attempt++) {
  $edit=$dialog.FindFirst([System.Windows.Automation.TreeScope]::Descendants,$editCondition)
  $open=$dialog.FindFirst([System.Windows.Automation.TreeScope]::Descendants,$openCondition)
  if($edit -and $open){break};Start-Sleep -Milliseconds 100
}
if(-not $edit -or -not $open){throw 'Owned native controls missing'}
Add-Type -TypeDefinition @'
using System;using System.Text;using System.Runtime.InteropServices;
public static class SchedulerPickerProbe {
 [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h,out uint pid);
 [DllImport("user32.dll")] static extern bool IsChild(IntPtr parent,IntPtr child);
 [DllImport("user32.dll")] static extern IntPtr SendMessage(IntPtr h,uint message,IntPtr w,IntPtr l);
 [DllImport("user32.dll",CharSet=CharSet.Unicode,EntryPoint="SendMessageW")] static extern IntPtr SetText(IntPtr h,uint message,IntPtr w,string text);
 [DllImport("user32.dll",CharSet=CharSet.Unicode,EntryPoint="SendMessageW")] static extern IntPtr ReadText(IntPtr h,uint message,IntPtr w,StringBuilder text);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr h,StringBuilder t,int n);
 public static void Fill(long dialogValue,long editValue,long buttonValue,uint owner,string path) {
  var dialog=new IntPtr(dialogValue);var edit=new IntPtr(editValue);var button=new IntPtr(buttonValue);
  foreach(var handle in new[]{dialog,edit,button}){uint pid;GetWindowThreadProcessId(handle,out pid);if(pid!=owner)throw new Exception("Owned picker identity changed");}
  if(!IsChild(dialog,edit)||!IsChild(dialog,button))throw new Exception("Owned picker controls changed");
  var kind=new StringBuilder(100);GetClassName(edit,kind,100);if(kind.ToString()!="Edit")throw new Exception("Owned filename control changed");
  kind.Clear();GetClassName(button,kind,100);if(kind.ToString()!="Button")throw new Exception("Owned open button changed");
  SetText(edit,0x000C,IntPtr.Zero,path);
  var value=new StringBuilder(32768);ReadText(edit,0x000D,new IntPtr(32768),value);
  if(value.ToString()!=path)throw new Exception("Owned filename value not applied");
  SendMessage(button,0xF5,IntPtr.Zero,IntPtr.Zero);
 }
}
'@
[SchedulerPickerProbe]::Fill($dialog.Current.NativeWindowHandle,$edit.Current.NativeWindowHandle,$open.Current.NativeWindowHandle,$ownerPid,$env:CQS_ACCEPTANCE_CONFIG)
`;
  try { await promisify(execFile)(join(process.env.SystemRoot ?? "C:/Windows", "System32/WindowsPowerShell/v1.0/powershell.exe"),
    ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
    { windowsHide: true, timeout: 20000, env: { ...process.env, CQS_ACCEPTANCE_CONFIG: configPath } }); }
  catch (error) {
    const reason = String(error.stderr).match(/Owned [a-z ]+(?:missing|changed|foreground|focused|applied|input)/)?.[0];
    throw new Error("Native config picker automation failed: " + (reason ?? "UI Automation unavailable"));
  }
}
