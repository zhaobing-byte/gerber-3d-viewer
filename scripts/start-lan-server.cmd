@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-lan-server.ps1"
if errorlevel 1 (
  echo.
  echo FABVIEW deployment failed. See the PowerShell output above.
  pause
  exit /b 1
)
echo.
echo FABVIEW is running in the background. This window can be closed.
pause
