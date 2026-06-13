@echo off
chcp 65001 >nul
title 手套管理 - frp 内网穿透

echo ========================================
echo   启动本地服务器 + frp 客户端
echo ========================================
echo.

echo [1/2] 启动本地服务器...
start "GMS-Server" /MIN cmd /c "node server.js"
timeout /t 2 /nobreak >nul

echo [2/2] 启动 frp 客户端...
echo.
echo ========================================
echo   公网访问: http://你的Linux公网IP:8765
echo ========================================
echo.
frp\frpc.exe -c frp\frpc.toml
pause
