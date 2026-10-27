; -*- coding: utf-8 -*-
!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "FileFunc.nsh"
!include "WordFunc.nsh"
!insertmacro VersionCompare
Unicode true
RequestExecutionLevel user
ManifestDPIAware true
Name "Codex 任务助手"
OutFile "${OUTPUT}"
InstallDir "${INSTALL_DIR}"
InstallDirRegKey HKCU "Software\${PRODUCT_KEY}" "InstallLocation"
VIProductVersion "${VERSION}.0"
VIAddVersionKey "ProductName" "Codex Quota Scheduler"
VIAddVersionKey "ProductVersion" "${VERSION}"
VIAddVersionKey "FileDescription" "Codex Quota Scheduler per-user installer"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "LegalCopyright" "Codex Quota Scheduler contributors"
SetCompressor /SOLID ${COMPRESSION}
ShowInstDetails show
ShowUninstDetails show
BrandingText "Codex Quota Scheduler · 当前用户安装"
Var MaintenanceMutex

!define MUI_WELCOMEPAGE_TEXT "安装到当前用户目录，无需管理员权限。安装包自带运行时。$\r$\n$\r$\n升级前，请在客户端选择“安装与数据迁移 → 备份并安全退出，准备升级”。安装器不会强制结束任务。$\r$\n$\r$\n安装与卸载均保留用户数据、外部项目和 Codex 登录目录。"
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_COMPONENTS
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "SimpChinese"
!insertmacro MUI_LANGUAGE "English"

!macro RejectReparse Path
  System::Call 'kernel32::GetFileAttributesW(w "${Path}") i.r0'
  ${If} $0 != -1
    IntOp $1 $0 & 0x400
    ${If} $1 != 0
      MessageBox MB_OK "安装路径含目录联接或符号链接，无法安全验证，不会继续。" /SD IDOK
      SetErrorLevel 43
      Quit
    ${EndIf}
  ${EndIf}
!macroend

!macro Guard Prefix
Function ${Prefix}Guard
  ; Hold the mutex until process termination. New installed clients refuse startup while it exists.
  System::Call 'kernel32::CreateMutexW(p 0,i 0,w "Local\CodexQuotaScheduler.Maintenance.v1") p.r0 ?e'
  Pop $1
  StrCpy $MaintenanceMutex $0
  ${If} $0 = 0
  ${OrIf} $1 = 183
    MessageBox MB_OK|MB_ICONEXCLAMATION "另一个安装或卸载正在运行。" /SD IDOK
    SetErrorLevel 42
    Quit
  ${EndIf}
  Call ${Prefix}CheckProcesses
FunctionEnd
Function ${Prefix}CheckProcesses
  ; Find only. Never call the plugin's CloseProcess or KillProcess operations.
  nsProcess::_FindProcess "CodexQuotaScheduler.exe"
  Pop $0
  ${If} $0 != 603
    MessageBox MB_OK|MB_ICONEXCLAMATION "客户端或后台仍在运行，或无法确认进程状态。请先从客户端备份并安全退出，再运行安装/卸载；不会强制终止任务。" /SD IDOK
    SetErrorLevel 42
    Quit
  ${EndIf}
FunctionEnd
Function ${Prefix}CheckPaths
  StrCpy $4 "$INSTDIR"
parentPath:
  !insertmacro RejectReparse "$4"
  ${GetParent} "$4" $5
  ${If} $5 != ""
  ${AndIf} $5 != $4
    StrCpy $4 $5
    Goto parentPath
  ${EndIf}
  !include "${VERIFY_PATHS}"
FunctionEnd
!macroend
!insertmacro Guard ""
!insertmacro Guard "un."

Function .onInit
  SetShellVarContext current
  SetRegView 64
  Call Guard
  Call CheckPaths
  ${GetFileName} "$INSTDIR" $0
  ${If} $0 != "CodexQuotaScheduler"
    MessageBox MB_OK "安装目录必须使用独立的 CodexQuotaScheduler 文件夹。" /SD IDOK
    SetErrorLevel 43
    Quit
  ${EndIf}
  ; A fixed leaf and product marker prevent taking over arbitrary folders, including a user data root.
  IfFileExists "$INSTDIR\install-product.ini" marker
  FindFirst $2 $3 "$INSTDIR\*"
inspectDirectory:
  ${If} $3 != ""
  ${AndIf} $3 != "."
  ${AndIf} $3 != ".."
    FindClose $2
    MessageBox MB_OK "目标目录已有其他内容，不能覆盖。" /SD IDOK
    SetErrorLevel 43
    Quit
  ${EndIf}
  ClearErrors
  FindNext $2 $3
  IfErrors directoryEmpty inspectDirectory
directoryEmpty:
  FindClose $2
  Goto empty
marker:
  ReadINIStr $0 "$INSTDIR\install-product.ini" "Product" "Id"
  ${If} $0 != "${PRODUCT_KEY}"
    MessageBox MB_OK "目标目录已有其他内容，不能覆盖。" /SD IDOK
    SetErrorLevel 43
    Quit
  ${EndIf}
empty:
  ReadRegStr $0 HKCU "Software\${PRODUCT_KEY}" "Version"
  ${If} $0 != ""
    ${VersionCompare} "$0" "${VERSION}" $1
    ${If} $1 = 1
      MessageBox MB_OK "已安装更新版本，不能直接降级。请先备份并使用匹配版本。" /SD IDOK
      SetErrorLevel 44
      Quit
    ${EndIf}
  ${EndIf}
FunctionEnd

Function un.onInit
  SetShellVarContext current
  SetRegView 64
  Call un.Guard
  Call un.CheckPaths
  ReadINIStr $0 "$INSTDIR\install-product.ini" "Product" "Id"
  ${If} $0 != "${PRODUCT_KEY}"
    MessageBox MB_OK "安装身份无法验证，不会删除文件。" /SD IDOK
    SetErrorLevel 43
    Quit
  ${EndIf}
FunctionEnd

Section "程序与开始菜单（必需）" Main
  SectionIn RO
  Call CheckProcesses
  Call CheckPaths
  SetOutPath "$INSTDIR"
  ; The generated include contains the exact build manifest, never a recursive user-data wildcard.
  !include "${INSTALL_FILES}"
  WriteINIStr "$INSTDIR\install-product.ini" "Product" "Id" "${PRODUCT_KEY}"
  WriteINIStr "$INSTDIR\install-product.ini" "Product" "Version" "${VERSION}"
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  CreateDirectory "$SMPROGRAMS\${SHORTCUT_GROUP}"
  CreateShortCut "$SMPROGRAMS\${SHORTCUT_GROUP}\Codex 任务助手.lnk" "$INSTDIR\CodexQuotaScheduler.exe"
  WinShell::SetLnkAUMI "$SMPROGRAMS\${SHORTCUT_GROUP}\Codex 任务助手.lnk" "local.codex-quota-scheduler"
  WriteRegStr HKCU "Software\${PRODUCT_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "Software\${PRODUCT_KEY}" "Version" "${VERSION}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCT_KEY}" "DisplayName" "Codex Quota Scheduler"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCT_KEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCT_KEY}" "UninstallString" '$\"$INSTDIR\Uninstall.exe$\"'
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCT_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCT_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCT_KEY}" "NoRepair" 1
SectionEnd

Section /o "桌面快捷方式" DesktopShortcut
  CreateShortCut "$DESKTOP\${SHORTCUT_GROUP}.lnk" "$INSTDIR\CodexQuotaScheduler.exe"
  WinShell::SetLnkAUMI "$DESKTOP\${SHORTCUT_GROUP}.lnk" "local.codex-quota-scheduler"
SectionEnd

Section "Uninstall"
  Call un.CheckProcesses
  Call un.CheckPaths
  ; No user data path appears in delete operations. Unknown files are retained.
  !include "${UNINSTALL_FILES}"
  Delete "$INSTDIR\install-product.ini"
  Delete "$INSTDIR\Uninstall.exe"
  RMDir "$INSTDIR"
  Delete "$SMPROGRAMS\${SHORTCUT_GROUP}\Codex 任务助手.lnk"
  RMDir "$SMPROGRAMS\${SHORTCUT_GROUP}"
  Delete "$DESKTOP\${SHORTCUT_GROUP}.lnk"
  DeleteRegKey HKCU "Software\${PRODUCT_KEY}"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCT_KEY}"
SectionEnd
