@echo off
setlocal
chcp 65001 >nul
title Tailect ASR v1 API 服务状态

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0api_v1_service.ps1" -Action status -ConfigPath "%~dp0api_v1_config.json"
set "EXIT_CODE=%ERRORLEVEL%"

pause
endlocal & exit /b %EXIT_CODE%
