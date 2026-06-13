@echo off
chcp 65001 >nul
title 手套管理系统 - 内网穿透模式

echo ========================================
echo   手套管理系统 - 内网穿透
echo ========================================
echo.
echo 此脚本将启动本地服务器并通过 Cloudflare Tunnel
echo 生成公网访问地址，任何联网设备均可访问。
echo.
echo 首次使用需下载 cloudflared.exe：
echo   https://github.com/cloudflare/cloudflared/releases/latest
echo   下载 cloudflared-windows-amd64.exe → 重命名为 cloudflared.exe
echo   放到此目录下
echo.

:: Check cloudflared
where cloudflared >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    if exist "%~dp0cloudflared.exe" (
        set "CLOUDFLARED=%~dp0cloudflared.exe"
    ) else (
        echo [错误] 未找到 cloudflared，请先下载。
        echo.
        pause
        exit /b 1
    )
) else (
    set "CLOUDFLARED=cloudflared"
)

echo [1/2] 启动本地服务器 (端口 8765)...
start "GMS-Server" /MIN cmd /c "node server.js"
timeout /t 3 /nobreak >nul

echo [2/2] 启动 Cloudflare Tunnel...
echo.
echo ========================================
echo   复制下面的 https:// 地址发给其他人即可访问
echo ========================================
echo.
%CLOUDFLARED% tunnel --url http://localhost:8765

echo.
echo Tunnel 已断开。
pause
