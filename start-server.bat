@echo off
title 手套管理系统 - 自动重启
echo ========================================
echo   手套管理系统 v3.5 - Windows 自动重启
echo   崩溃自动恢复，每24小时自动重启
echo ========================================
echo.

:loop
echo [%date% %time%] 启动服务器...
node server.js
echo [%date% %time%] 服务器退出 (code: %errorlevel%)，5秒后自动重启...
timeout /t 5 /nobreak >nul
goto loop
