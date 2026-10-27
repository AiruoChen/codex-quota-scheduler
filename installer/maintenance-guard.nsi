!include "LogicLib.nsh"
Unicode true
SilentInstall silent
AutoCloseWindow true
RequestExecutionLevel user
Name "CodexQuotaScheduler maintenance probe"
OutFile "${OUTPUT}"
Section
  System::Call 'kernel32::OpenMutexW(i 0x100000,i 0,w "Local\CodexQuotaScheduler.Maintenance.v1") p.r0 ?e'
  Pop $1
  ${If} $0 != 0
    System::Call 'kernel32::CloseHandle(p r0)'
    SetErrorLevel 42
  ${Else}
    ${If} $1 = 2
      SetErrorLevel 0
    ${Else}
      SetErrorLevel 43
    ${EndIf}
  ${EndIf}
SectionEnd
