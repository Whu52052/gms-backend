@echo off
title 手套管理系统 - 数据恢复
echo ========================================
echo   手套管理系统 - 数据库恢复脚本 (Win)
echo ========================================
echo.

set BACKUP_DIR=data\backups

if not exist "%BACKUP_DIR%" (
    echo [错误] 备份目录不存在: %BACKUP_DIR%
    pause
    exit /b 1
)

echo 可用备份文件:
dir /b "%BACKUP_DIR%\*.db" 2>nul
if %errorlevel% neq 0 (
    echo [错误] 没有找到备份文件
    pause
    exit /b 1
)

echo.
set /p BACKUP_FILE="输入要恢复的备份文件名 (如 gms-2026-06-03.db): "

if not exist "%BACKUP_DIR%\%BACKUP_FILE%" (
    echo [错误] 文件不存在: %BACKUP_DIR%\%BACKUP_FILE%
    pause
    exit /b 1
)

echo.
echo ========================================
echo   即将恢复: %BACKUP_FILE%
echo   当前数据将被覆盖！
echo ========================================
set /p CONFIRM="确认恢复？(输入 yes 继续): "
if /i not "%CONFIRM%"=="yes" (
    echo 已取消
    pause
    exit /b 0
)

echo.
echo [1/4] 停止服务器...
taskkill /F /IM node.exe >nul 2>&1
timeout /t 2 /nobreak >nul

echo [2/4] 备份当前数据库...
if exist data\gms.db (
    set TIMESTAMP=%date:~0,4%%date:~5,2%%date:~8,2%-%time:~0,2%%time:~3,2%%time:~6,2%
    set TIMESTAMP=%TIMESTAMP: =0%
    copy data\gms.db "data\gms-before-restore-%TIMESTAMP%.db" >nul
    echo   已备份到: data\gms-before-restore-%TIMESTAMP%.db
)

echo [3/4] 恢复数据库...
copy "%BACKUP_DIR%\%BACKUP_FILE%" data\gms.db >nul
del data\gms.db-wal >nul 2>&1
del data\gms.db-shm >nul 2>&1

echo [4/4] 启动服务器...
start /B node server.js >nul 2>&1
timeout /t 3 /nobreak >nul

echo.
echo ========================================
echo   恢复完成！刷新浏览器页面即可
echo ========================================
pause
