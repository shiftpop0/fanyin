@echo off
setlocal EnableDelayedExpansion
title Tailect ASR v1 API 服务
chcp 65001 >nul

set "ROOT_DIR=%~dp0"
set "PYTHON_PATH=%ROOT_DIR%WPy64-312101\python"
set "PATH=%PYTHON_PATH%;%PYTHON_PATH%\Scripts;%ROOT_DIR%bin;%PATH%"
set "TAILECT_ROOT=%ROOT_DIR%"
set "MODELSCOPE_CACHE=%ROOT_DIR%models"
set "TAILECT_SD_MODEL_PATH=%ROOT_DIR%models\models\iic\speech_campplus_speaker-diarization_common"
set "MODELSCOPE_OFFLINE=1"
set "HF_HUB_OFFLINE=1"
set "TRANSFORMERS_OFFLINE=1"
set "TRANSFORMERS_VERBOSITY=error"
set "PYTHONUNBUFFERED=1"
set "NO_PROXY=127.0.0.1,localhost"
set "no_proxy=127.0.0.1,localhost"
set "HTTP_PROXY="
set "HTTPS_PROXY="
set "ALL_PROXY="

set "MODEL_ROOT=%ROOT_DIR%models\ASR"
set "PORT=%~2"
if not defined PORT set "PORT=8885"

if not exist "%MODEL_ROOT%" (
  echo [错误] 未找到模型目录：%MODEL_ROOT%
  pause
  exit /b 1
)

set "MODEL_NAME=%~1"
if defined MODEL_NAME goto START_API

set /a MODEL_COUNT=0
for /d %%D in ("%MODEL_ROOT%\*") do (
  set /a MODEL_COUNT+=1
  set "MODEL_NAME_!MODEL_COUNT!=%%~nxD"
)

if %MODEL_COUNT% EQU 0 (
  echo [错误] models\ASR 下没有检测到任何模型文件夹。
  pause
  exit /b 1
)

echo ======================================================
echo              Tailect ASR v1 API 启动器
echo ======================================================
echo 已检测到以下模型：
for /L %%I in (1,1,%MODEL_COUNT%) do echo   [%%I] !MODEL_NAME_%%I!
echo.
set /p MODEL_CHOICE=请输入要加载的模型编号后按回车: 
if not defined MODEL_CHOICE set "MODEL_CHOICE=1"
set "MODEL_NAME=!MODEL_NAME_%MODEL_CHOICE%!"

if not defined MODEL_NAME (
  echo [错误] 你输入的编号无效：%MODEL_CHOICE%
  pause
  exit /b 1
)

:START_API
if not exist "%MODEL_ROOT%\%MODEL_NAME%" (
  echo [错误] 未找到所选模型目录：%MODEL_ROOT%\%MODEL_NAME%
  pause
  exit /b 1
)

echo.
echo 当前模型：%MODEL_NAME%
echo API URL: http://127.0.0.1:%PORT%/v1/audiototext?model=%MODEL_NAME%
echo Health URL: http://127.0.0.1:%PORT%/health
echo Runtime: uvicorn, single process, offline mode, max upload 512MB, queue timeout 600s, rate limit 60/min
echo Audio URL: enabled, timeout 30s, max redirects 5
if defined TAILECT_AUDIO_URL_ALLOW_HOSTS echo Audio URL allow hosts: %TAILECT_AUDIO_URL_ALLOW_HOSTS%
if not defined TAILECT_AUDIO_URL_ALLOW_HOSTS echo Audio URL allow hosts: unrestricted HTTP/HTTPS
if defined TAILECT_API_KEY echo Auth: enabled by TAILECT_API_KEY
if not defined TAILECT_API_KEY echo Auth: disabled for local integration
echo Log directory: %ROOT_DIR%outputs\logs
echo LAN URL: http://YOUR_IP:%PORT%
echo ======================================================

python -m tailect_asr.cli.api_v1 ^
  --model "%MODEL_NAME%" ^
  --host 0.0.0.0 ^
  --port %PORT% ^
  --server uvicorn ^
  --startup-check ^
  --max-upload-mb 512 ^
  --queue-timeout-sec 600 ^
  --rate-limit-per-minute 60 ^
  --diarize ^
  --diarization-fallback
set "EXIT_CODE=%ERRORLEVEL%"

pause
endlocal & exit /b %EXIT_CODE%
