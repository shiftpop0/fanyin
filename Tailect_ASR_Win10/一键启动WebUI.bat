@echo off
setlocal EnableDelayedExpansion
title Tailect ASR 本地方言转写台
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
set "NO_PROXY=127.0.0.1,localhost"
set "no_proxy=127.0.0.1,localhost"
set "HTTP_PROXY="
set "HTTPS_PROXY="
set "ALL_PROXY="

set "MODEL_ROOT=%ROOT_DIR%models\ASR"
set "ALIGN_PATH=%ROOT_DIR%models\ForcedAligner"

if not exist "%MODEL_ROOT%" (
  echo [错误] 未找到模型目录：%MODEL_ROOT%
  echo 请把可用模型文件夹放到 models\ASR 下面。
  pause
  exit /b 1
)

set "MODEL_NAME=%~1"
if defined MODEL_NAME (
  set "ASR_PATH=%MODEL_ROOT%\%MODEL_NAME%"
  goto VALIDATE_MODEL
)

set /a MODEL_COUNT=0
for /d %%D in ("%MODEL_ROOT%\*") do (
  set /a MODEL_COUNT+=1
  set "MODEL_NAME_!MODEL_COUNT!=%%~nxD"
  set "MODEL_PATH_!MODEL_COUNT!=%%~fD"
)

if %MODEL_COUNT% EQU 0 (
  echo [错误] models\ASR 下没有检测到任何模型文件夹。
  echo 请先把模型放到该目录后再启动。
  pause
  exit /b 1
)

echo ======================================================
echo              Tailect ASR 启动器
echo ======================================================
echo 已检测到以下模型：
for /L %%I in (1,1,%MODEL_COUNT%) do echo   [%%I] !MODEL_NAME_%%I!

set /p MODEL_CHOICE=请输入要加载的模型编号后按回车: 
if not defined MODEL_CHOICE set "MODEL_CHOICE=1"

set "ASR_PATH=!MODEL_PATH_%MODEL_CHOICE%!"
set "MODEL_NAME=!MODEL_NAME_%MODEL_CHOICE%!"

:VALIDATE_MODEL
if not defined ASR_PATH (
  echo [错误] 你输入的编号无效：%MODEL_CHOICE%
  pause
  exit /b 1
)

if not exist "%ASR_PATH%" (
  echo.
  echo [错误] 未找到所选模型目录：
  echo %ASR_PATH%
  echo 请检查模型文件是否已就位。
  pause
  exit /b 1
)

echo.
echo 当前模型：%MODEL_NAME%
echo 启动中，请耐心等待模型加载...
echo 识别完成后可直接在界面下载 SRT 字幕文件。
echo Local URL: http://127.0.0.1:7867
echo LAN URL: http://YOUR_IP:7867
echo ======================================================

python -m tailect_asr.cli.demo ^
  --asr-checkpoint "%ASR_PATH%" ^
  --aligner-checkpoint "%ALIGN_PATH%" ^
  --backend transformers ^
  --ip 0.0.0.0 --port 7867
set "EXIT_CODE=%ERRORLEVEL%"

pause
endlocal & exit /b %EXIT_CODE%
