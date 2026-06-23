@echo off
setlocal
cd /d "%~dp0"

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0build_offline_client.ps1"
set "BUILD_EXIT=%ERRORLEVEL%"

if not "%BUILD_EXIT%"=="0" (
  echo.
  echo [ERROR] Offline package build failed with exit code %BUILD_EXIT%.
  echo Set FANYIN_NODE_EXE to the full path of an offline Windows x64 node.exe if auto-detection fails.
)

echo.
pause
endlocal & exit /b %BUILD_EXIT%
