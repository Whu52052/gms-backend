#!/bin/bash
#
# GMS Backend 心跳功能集成脚本
# 在 10.5.51.216 上执行
#

set -e

echo "========================================"
echo "  GMS Backend 心跳功能集成"
echo "========================================"
echo ""

# 检查目录
if [ ! -d "/home/we/gms-backend" ]; then
    echo "❌ 错误: /home/we/gms-backend 目录不存在"
    exit 1
fi

cd /home/we/gms-backend

# 备份 server.js
echo "[1/3] 备份 server.js..."
cp server.js server.js.backup.$(date +%Y%m%d_%H%M%S)
echo "  ✓ 已备份到 server.js.backup.*"
echo ""

# 检查 machine-heartbeat.js 是否存在
if [ ! -f "src/handlers/machine-heartbeat.js" ]; then
    echo "❌ 错误: src/handlers/machine-heartbeat.js 未找到"
    echo "请先上传 backend-integration/machine-heartbeat.js 到 src/handlers/ 目录"
    exit 1
fi

echo "[2/3] 心跳处理器已就位"
echo "  ✓ src/handlers/machine-heartbeat.js"
echo ""

echo "[3/3] 接下来需要手动修改 server.js"
echo ""
echo "请按照 backend-integration/INTEGRATION.md 文档："
echo "  1. 导入模块"
echo "  2. 声明变量"
echo "  3. 初始化处理器"
echo "  4. 添加路由"
echo "  5. 优雅关闭清理"
echo ""
echo "修改完成后执行："
echo "  pm2 reload ecosystem.config.js"
echo ""
