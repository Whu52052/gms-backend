#!/bin/bash
#
# GMS Machine Heartbeat Agent - 一键部署脚本
#
# 使用方法:
#   sudo bash deploy.sh              # 自动检测机器编号
#   sudo bash deploy.sh we-100       # 指定机器编号
#

set -e

MACHINE_NUMBER="${1:-}"
BACKEND_URL="${GMS_BACKEND_URL:-http://10.5.51.216:8765}"

echo "========================================"
echo "  GMS Machine Heartbeat Agent 部署"
echo "========================================"
echo

# 检查 Docker
if ! command -v docker &> /dev/null; then
    echo "❌ Docker 未安装，请先安装 Docker"
    exit 1
fi

# 检查 docker-compose
if ! command -v docker-compose &> /dev/null; then
    echo "❌ docker-compose 未安装，请先安装"
    exit 1
fi

# 创建 .env 文件
cat > .env << EOF
GMS_BACKEND_URL=${BACKEND_URL}
HEARTBEAT_INTERVAL=30
DEVICE_TYPE=workstation
EOF

if [ -n "$MACHINE_NUMBER" ]; then
    echo "MACHINE_NUMBER=${MACHINE_NUMBER}" >> .env
    echo "✅ 使用指定的机器编号: ${MACHINE_NUMBER}"
else
    echo "✅ 将自动检测机器编号"
fi

echo
echo "开始构建和启动容器..."
echo

# 构建镜像
docker-compose build

# 启动容器
docker-compose up -d

echo
echo "========================================"
echo "  部署完成！"
echo "========================================"
echo
echo "查看状态: docker-compose ps"
echo "查看日志: docker-compose logs -f"
echo "停止服务: docker-compose down"
echo
echo "健康检查: curl http://localhost:3000/health"
echo

# 等待容器启动
sleep 3

# 显示状态
docker-compose ps

echo
echo "正在检查心跳日志..."
docker-compose logs --tail=20
