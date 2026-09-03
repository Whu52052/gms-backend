#!/bin/bash
#
# 在客户端机器上快速部署心跳监控容器
# 用法: bash quick-deploy.sh [机器编号]
# 示例: bash quick-deploy.sh we-105
#

set -e

MACHINE_NUMBER="${1:-}"
GMS_BACKEND="10.5.51.216:8765"

echo "========================================"
echo "  GMS 心跳客户端快速部署"
echo "========================================"
echo ""

# 检查 Docker
if ! command -v docker &> /dev/null; then
    echo "❌ Docker 未安装"
    exit 1
fi

# 检查 docker-compose
if ! command -v docker-compose &> /dev/null; then
    echo "❌ docker-compose 未安装"
    exit 1
fi

# 停止旧容器（如果存在）
echo "[1/4] 停止旧容器..."
docker-compose down 2>/dev/null || true
echo "  ✓ 完成"
echo ""

# 设置环境变量
echo "[2/4] 配置环境..."
cat > .env << EOF
GMS_BACKEND_URL=http://${GMS_BACKEND}
HEARTBEAT_INTERVAL=30
DEVICE_TYPE=workstation
CAMERA_CHECK_INTERVAL=10
CAMERA_EXPECTED_FPS=30
CAMERA_FPS_THRESHOLD=0.8
EOF

if [ -n "$MACHINE_NUMBER" ]; then
    echo "MACHINE_NUMBER=${MACHINE_NUMBER}" >> .env
    echo "  ✓ 机器编号: ${MACHINE_NUMBER}"
else
    echo "  ✓ 将自动检测机器编号"
fi
echo ""

# 构建镜像
echo "[3/4] 构建 Docker 镜像..."
docker-compose build
echo "  ✓ 完成"
echo ""

# 启动容器
echo "[4/4] 启动容器..."
docker-compose up -d
echo "  ✓ 完成"
echo ""

# 等待启动
sleep 3

# 显示状态
echo "========================================"
echo "  部署完成！"
echo "========================================"
echo ""
docker-compose ps
echo ""
echo "查看日志: docker-compose logs -f"
echo "停止服务: docker-compose down"
echo ""
