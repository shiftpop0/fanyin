@echo off
setlocal
cd /d "%~dp0"

echo Building the Windows x64 offline userscript client package...
echo The package will include the current userscript, local helper, and portable node.exe.
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0build_offline_client.ps1"
set "BUILD_EXIT=%ERRORLEVEL%"

if not "%BUILD_EXIT%"=="0" (
  echo.
  echo [ERROR] Offline package build failed with exit code %BUILD_EXIT%.
  echo You can set FANYIN_NODE_EXE to the full path of an offline Windows x64 node.exe.
)

echo.
pause
endlocal & exit /b %BUILD_EXIT%
