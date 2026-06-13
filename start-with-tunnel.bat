@echo off
chcp 65001 >nul
title 手套管理系统 - Cloudflare Tunnel 公网模式

echo ========================================
echo   手套管理系统 - 公网部署模式
echo ========================================
echo.

:: Start server
echo [1/2] 启动本地服务器 (端口 8765)...
start "GMS-Server" /MIN cmd /c "node %~dp0server.js"
timeout /t 5 /nobreak >nul

:: Check if server is ready
:wait_server
echo 等待服务器就绪...
curl -s http://localhost:8765/api/health >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    timeout /t 2 /nobreak >nul
    goto wait_server
)
echo 服务器已就绪！

:: Start Cloudflare Tunnel
echo.
echo [2/2] 启动 Cloudflare Tunnel...
echo.
echo ========================================
echo   公网访问地址 (分享给其他人):
echo.
echo   请在下方输出中找到 https://*.trycloudflare.com
echo   复制该地址发给其他人即可访问
echo ========================================
echo.

:: Use installed cloudflared (via winget) or local one
where cloudflared >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    if exist "%~dp0cloudflared.exe" (
        set "CLOUDFLARED=%~dp0cloudflared.exe"
    ) else (
        echo [错误] 未找到 cloudflared
        pause
        exit /b 1
    )
) else (
    set "CLOUDFLARED=cloudflared"
)

%CLOUDFLARED% tunnel --url http://localhost:8765

echo.
echo Tunnel 已断开，按任意键退出...
pause
