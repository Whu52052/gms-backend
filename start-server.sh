#!/bin/bash
# 手套管理系统 v3.5 - Linux 自动重启脚本
# 用法: ./start-server.sh

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# 加载环境变量（.env 文件）
set -a && . .env 2>/dev/null && set +a || true

echo "========================================"
echo "  手套管理系统 v3.5 - Linux 自动重启"
echo "  崩溃自动恢复，每24小时自动重启"
echo "========================================"

RESTART_COUNT=0
LAST_RESTART=$(date +%s)

while true; do
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] 启动服务器 (重启次数: $RESTART_COUNT)..."
    node server.js
    EXIT_CODE=$?
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] 服务器退出 (code: $EXIT_CODE)"

    # If running less than 10 seconds, delay longer (rapid crash loop)
    NOW=$(date +%s)
    UPTIME=$((NOW - LAST_RESTART))
    if [ $UPTIME -lt 10 ]; then
        echo "服务器快速崩溃，等待30秒后重试..."
        sleep 30
    else
        echo "5秒后自动重启..."
        sleep 5
    fi

    RESTART_COUNT=$((RESTART_COUNT + 1))
    LAST_RESTART=$(date +%s)
done
