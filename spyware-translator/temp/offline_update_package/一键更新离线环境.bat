@echo off
setlocal EnableExtensions
chcp 65001 >nul
title Spyware Translator 离线环境一键更新

set "PKG_DIR=%~dp0"
set "PAYLOAD=%PKG_DIR%payload"
set "TARGET_ROOT="

echo.
echo ===== Spyware Translator / Tailect ASR 离线环境一键更新 =====
echo.
echo 本脚本会更新以下文件，并自动备份原文件：
echo   1. Tailect_ASR_Win10\一键启动WebUI.bat
echo   2. Tailect_ASR_Win10\WPy64-312101\python\Lib\site-packages\qwen_asr\cli\demo.py
echo   3. spyware-translator\spyware-translator.user.js
echo.
echo 建议先关闭正在运行的 Tailect WebUI，再继续执行。
echo.

if not exist "%PAYLOAD%\Tailect_ASR_Win10\一键启动WebUI.bat" (
  echo [错误] 未找到 payload，请确认完整解压了更新包。
  pause
  exit /b 1
)

if not "%~1"=="" set "TARGET_ROOT=%~1"

if not defined TARGET_ROOT (
  if exist "%PKG_DIR%Tailect_ASR_Win10\WPy64-312101\python\Lib\site-packages\qwen_asr\cli\demo.py" (
    set "TARGET_ROOT=%PKG_DIR%"
  )
)

if not defined TARGET_ROOT (
  if exist "%PKG_DIR%..\Tailect_ASR_Win10\WPy64-312101\python\Lib\site-packages\qwen_asr\cli\demo.py" (
    set "TARGET_ROOT=%PKG_DIR%.."
  )
)

if not defined TARGET_ROOT (
  echo 未自动找到离线项目根目录。
  echo 请输入包含 Tailect_ASR_Win10 文件夹的目录，例如 D:\fanyiin
  set /p TARGET_ROOT=项目根目录：
)

for %%I in ("%TARGET_ROOT%") do set "TARGET_ROOT=%%~fI"
echo.
echo 目标目录：%TARGET_ROOT%
echo.

if not exist "%TARGET_ROOT%\Tailect_ASR_Win10\WPy64-312101\python\Lib\site-packages\qwen_asr\cli\demo.py" (
  echo [错误] 目标目录中未找到 Tailect 的 demo.py。
  echo 请确认目标目录是包含 Tailect_ASR_Win10 的项目根目录。
  pause
  exit /b 1
)

if not exist "%TARGET_ROOT%\Tailect_ASR_Win10\一键启动WebUI.bat" (
  echo [错误] 目标目录中未找到 Tailect_ASR_Win10\一键启动WebUI.bat。
  pause
  exit /b 1
)

if not exist "%TARGET_ROOT%\spyware-translator" mkdir "%TARGET_ROOT%\spyware-translator"
if not exist "%TARGET_ROOT%\spyware-translator\temp" mkdir "%TARGET_ROOT%\spyware-translator\temp"

for /f %%I in ('powershell -NoProfile -Command "Get-Date -Format yyyyMMdd_HHmmss" 2^>nul') do set "STAMP=%%I"
if not defined STAMP set "STAMP=%RANDOM%"

set "BACKUP_DIR=%TARGET_ROOT%\spyware-translator\temp\offline_update_backup_%STAMP%"
mkdir "%BACKUP_DIR%\Tailect_ASR_Win10\WPy64-312101\python\Lib\site-packages\qwen_asr\cli" >nul 2>nul
mkdir "%BACKUP_DIR%\Tailect_ASR_Win10" >nul 2>nul
mkdir "%BACKUP_DIR%\spyware-translator" >nul 2>nul

echo [1/5] 备份原文件...
copy /Y "%TARGET_ROOT%\Tailect_ASR_Win10\WPy64-312101\python\Lib\site-packages\qwen_asr\cli\demo.py" "%BACKUP_DIR%\Tailect_ASR_Win10\WPy64-312101\python\Lib\site-packages\qwen_asr\cli\demo.py" >nul
copy /Y "%TARGET_ROOT%\Tailect_ASR_Win10\一键启动WebUI.bat" "%BACKUP_DIR%\Tailect_ASR_Win10\一键启动WebUI.bat" >nul
if exist "%TARGET_ROOT%\spyware-translator\spyware-translator.user.js" (
  copy /Y "%TARGET_ROOT%\spyware-translator\spyware-translator.user.js" "%BACKUP_DIR%\spyware-translator\spyware-translator.user.js" >nul
)
echo       备份目录：%BACKUP_DIR%

echo [2/5] 更新 Tailect ASR 源码...
copy /Y "%PAYLOAD%\Tailect_ASR_Win10\WPy64-312101\python\Lib\site-packages\qwen_asr\cli\demo.py" "%TARGET_ROOT%\Tailect_ASR_Win10\WPy64-312101\python\Lib\site-packages\qwen_asr\cli\demo.py" >nul
if errorlevel 1 goto copy_failed

echo [3/5] 更新 WebUI 启动脚本...
copy /Y "%PAYLOAD%\Tailect_ASR_Win10\一键启动WebUI.bat" "%TARGET_ROOT%\Tailect_ASR_Win10\一键启动WebUI.bat" >nul
if errorlevel 1 goto copy_failed

echo [4/5] 更新油猴脚本文件...
copy /Y "%PAYLOAD%\spyware-translator\spyware-translator.user.js" "%TARGET_ROOT%\spyware-translator\spyware-translator.user.js" >nul
if errorlevel 1 goto copy_failed

echo [5/5] 检查并修正说话人分离离线配置...
set "SD_CONFIG=%TARGET_ROOT%\Tailect_ASR_Win10\models\models\iic\speech_campplus_speaker-diarization_common\configuration.json"
set "SD_SPEAKER=%TARGET_ROOT%\Tailect_ASR_Win10\models\models\damo\speech_campplus_sv_zh-cn_16k-common"
set "SD_CHANGE=%TARGET_ROOT%\Tailect_ASR_Win10\models\models\damo\speech_campplus-transformer_scl_zh-cn_16k-common"
set "SD_VAD=%TARGET_ROOT%\Tailect_ASR_Win10\models\models\damo\speech_fsmn_vad_zh-cn-16k-common-pytorch"

if not exist "%SD_CONFIG%" (
  echo       [警告] 未找到说话人分离 configuration.json，跳过配置修正。
  goto done
)
set "SD_MISSING="
if not exist "%SD_SPEAKER%\" (
  echo       [警告] 未找到 speaker_model 子模型目录：%SD_SPEAKER%
  set "SD_MISSING=1"
)
if not exist "%SD_CHANGE%\" (
  echo       [警告] 未找到 change_locator 子模型目录：%SD_CHANGE%
  set "SD_MISSING=1"
)
if not exist "%SD_VAD%\" (
  echo       [警告] 未找到 vad_model 子模型目录：%SD_VAD%
  set "SD_MISSING=1"
)
if defined SD_MISSING (
  echo       子模型目录不完整，已跳过 configuration.json 预修正。
  goto done
)

set "PS_CMD=$p=$env:SD_CONFIG; $json=Get-Content -Raw -Encoding UTF8 $p | ConvertFrom-Json; $json.model.speaker_model=$env:SD_SPEAKER; $json.model.change_locator=$env:SD_CHANGE; $json.model.vad_model=$env:SD_VAD; $text=$json | ConvertTo-Json -Depth 50; [System.IO.File]::WriteAllText($p, $text + [Environment]::NewLine, (New-Object System.Text.UTF8Encoding $false))"
powershell -NoProfile -ExecutionPolicy Bypass -Command "%PS_CMD%" >nul
if errorlevel 1 (
  echo       [警告] PowerShell 修正 configuration.json 失败；新版 demo.py 运行时仍会尝试自动修正。
) else (
  echo       已将 configuration.json 的子模型路径修正为本地目录。
)

:done
echo.
echo [完成] 更新已安装。
echo.
echo 后续操作：
echo   1. 重新运行 Tailect_ASR_Win10\一键启动WebUI.bat
echo   2. 如浏览器中的 Tampermonkey 没有自动同步，请将以下文件导入/复制到 Tampermonkey：
echo      %TARGET_ROOT%\spyware-translator\spyware-translator.user.js
echo.
pause
exit /b 0

:copy_failed
echo.
echo [错误] 文件复制失败。可能是 Tailect WebUI 仍在运行，或目标目录权限不足。
echo 已生成备份目录：%BACKUP_DIR%
pause
exit /b 1
