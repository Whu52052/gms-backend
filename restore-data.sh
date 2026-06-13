#!/bin/bash
# 手套管理系统 - 数据库恢复脚本 (Linux/Mac)

set -e

BACKUP_DIR="data/backups"
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo "========================================"
echo "  手套管理系统 - 数据库恢复脚本 (Linux)"
echo "========================================"
echo ""

if [ ! -d "$BACKUP_DIR" ]; then
    echo -e "${RED}[错误] 备份目录不存在: $BACKUP_DIR${NC}"
    exit 1
fi

echo "可用备份文件:"
ls -1 "$BACKUP_DIR"/*.db 2>/dev/null || { echo -e "${RED}[错误] 没有找到备份文件${NC}"; exit 1; }
echo ""

read -p "输入要恢复的备份文件名 (如 gms-2026-06-03.db): " BACKUP_FILE

if [ ! -f "$BACKUP_DIR/$BACKUP_FILE" ]; then
    echo -e "${RED}[错误] 文件不存在: $BACKUP_DIR/$BACKUP_FILE${NC}"
    exit 1
fi

echo ""
echo "========================================"
echo "  即将恢复: $BACKUP_FILE"
echo "  当前数据将被覆盖！"
echo "========================================"
read -p "确认恢复？(输入 yes 继续): " CONFIRM
if [ "$CONFIRM" != "yes" ]; then
    echo "已取消"
    exit 0
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

echo ""
echo "[1/4] 停止服务器..."
pkill -f "node server.js" 2>/dev/null || true
sleep 2

echo "[2/4] 备份当前数据库..."
if [ -f "data/gms.db" ]; then
    TIMESTAMP=$(date +%Y%m%d-%H%M%S)
    cp data/gms.db "data/gms-before-restore-$TIMESTAMP.db"
    echo "   已备份到: data/gms-before-restore-$TIMESTAMP.db"
fi

echo "[3/4] 恢复数据库..."
cp "$BACKUP_DIR/$BACKUP_FILE" data/gms.db
rm -f data/gms.db-wal data/gms.db-shm

echo "[4/4] 启动服务器..."
node server.js &
sleep 3

echo ""
echo "========================================"
echo -e "${GREEN}  恢复完成！刷新浏览器页面即可${NC}"
echo "========================================"
