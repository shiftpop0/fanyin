@echo off
setlocal
chcp 65001 >nul
title Tailect ASR v1 API 服务启动

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0api_v1_service.ps1" -Action start -ConfigPath "%~dp0api_v1_config.json"

endlocal
pause
