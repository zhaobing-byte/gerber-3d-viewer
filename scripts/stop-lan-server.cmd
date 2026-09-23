@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0stop-lan-server.ps1"
if errorlevel 1 (
  echo.
  echo FABVIEW shutdown failed. See the PowerShell output above.
  pause
  exit /b 1
)
echo.
echo FABVIEW has stopped. This window can be closed.
pause
