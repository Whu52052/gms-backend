@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo ========================================
echo   GMS 手套管理系统 - 自动启动
echo   %date% %time%
echo ========================================

:: Start Node.js server in background
echo [启动] 本地服务器...
start "GMS-Server" /MIN cmd /c "node %~dp0server.js"
timeout /t 5 /nobreak >nul

:: Start Cloudflare Tunnel and capture URL
echo [启动] Cloudflare Tunnel...
for /f "tokens=*" %%a in ('cloudflared tunnel --url http://localhost:8765 2^>^&1 ^| findstr "trycloudflare.com"') do (
    set TUNNEL_URL=%%a
)

:: Extract URL (it's in the line like: |  https://xxx.trycloudflare.com  |)
for /f "tokens=2 delims=|" %%u in ("%TUNNEL_URL%") do (
    for /f "tokens=*" %%v in ("%%u") do (
        set CLEAN_URL=%%v
    )
)

:: Update config.js with new URL
if defined CLEAN_URL (
    echo [URL] %CLEAN_URL%
    echo // 当前公网地址（自动生成） > "%~dp0js\config_url.js"
    echo window.__GMS_SERVER_URL__ = '%CLEAN_URL%'; >> "%~dp0js\config_url.js"
    echo [完成] 公网地址已更新
) else (
    echo [警告] 未能获取到 tunnel URL
)

echo.
echo 系统已启动。按任意键查看当前地址...
pause >nul
