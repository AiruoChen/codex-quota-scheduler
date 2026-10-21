@echo off
setlocal
cd /d "%~dp0"
if not exist "dist\src\cli.js" (
  echo Please run npm.cmd ci and npm.cmd run build first.
  pause
  exit /b 1
)
node --experimental-sqlite dist\src\cli.js ui %*
if errorlevel 1 pause
