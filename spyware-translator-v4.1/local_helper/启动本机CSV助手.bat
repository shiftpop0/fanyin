@echo off
setlocal EnableExtensions
cd /d "%~dp0"

if "%FANYIN_LOCAL_HELPER_PORT%"=="" set FANYIN_LOCAL_HELPER_PORT=18885
if "%FANYIN_OUTPUT_DIR%"=="" set FANYIN_OUTPUT_DIR=C:\fanyin_output

set "NODE_EXE="
set "NODE_SOURCE="
if exist "%~dp0runtime\node.exe" (
  set "NODE_EXE=%~dp0runtime\node.exe"
  set "NODE_SOURCE=offline bundled runtime"
)

if not defined NODE_EXE (
  for /f "delims=" %%I in ('where node.exe 2^>nul') do if not defined NODE_EXE set "NODE_EXE=%%I"
  if defined NODE_EXE set "NODE_SOURCE=system PATH fallback"
)

if not defined NODE_EXE (
  echo [ERROR] Portable Node.js runtime was not found:
  echo         %~dp0runtime\node.exe
  echo.
  echo Please use the complete offline package. No online installation is required.
  pause
  exit /b 1
)

for /f "delims=" %%I in ('""%NODE_EXE%" --version 2^>nul"') do set "NODE_VERSION=%%I"
for /f "delims=" %%I in ('""%NODE_EXE%" -p "process.arch" 2^>nul"') do set "NODE_ARCH=%%I"
if /I not "%NODE_ARCH%"=="x64" (
  echo [ERROR] This package requires Windows x64 Node.js, detected: %NODE_ARCH%
  pause
  exit /b 1
)
set "NODE_MAJOR=%NODE_VERSION:v=%"
for /f "tokens=1 delims=." %%I in ("%NODE_MAJOR%") do set "NODE_MAJOR=%%I"
if not defined NODE_MAJOR (
  echo [ERROR] Failed to read the Node.js version.
  pause
  exit /b 1
)
if %NODE_MAJOR% LSS 18 (
  echo [ERROR] Node.js 18 or later is required, detected: %NODE_VERSION%
  pause
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -Command "try { $r=Invoke-RestMethod -Uri 'http://127.0.0.1:%FANYIN_LOCAL_HELPER_PORT%/local/health' -TimeoutSec 2; if($r.service -eq 'fanyin-local-csv-helper'){exit 0}else{exit 2} } catch { exit 1 }"
set "PORT_CHECK=%ERRORLEVEL%"
if "%PORT_CHECK%"=="0" (
  echo Fanyin local CSV helper is already running.
  echo URL: http://127.0.0.1:%FANYIN_LOCAL_HELPER_PORT%
  pause
  exit /b 0
)
if "%PORT_CHECK%"=="2" (
  echo [ERROR] Port %FANYIN_LOCAL_HELPER_PORT% is occupied by another HTTP service.
  pause
  exit /b 2
)

echo Starting Fanyin local CSV helper...
echo Keep this window open while the userscript is running.
echo URL:    http://127.0.0.1:%FANYIN_LOCAL_HELPER_PORT%
echo Output: %FANYIN_OUTPUT_DIR%
echo Node:   %NODE_VERSION% x64 (%NODE_SOURCE%)
echo.
"%NODE_EXE%" "%~dp0local_csv_helper.mjs"
set "HELPER_EXIT=%ERRORLEVEL%"

if not "%HELPER_EXIT%"=="0" (
  echo.
  echo [ERROR] Local CSV helper stopped with exit code %HELPER_EXIT%.
  pause
)
endlocal & exit /b %HELPER_EXIT%
