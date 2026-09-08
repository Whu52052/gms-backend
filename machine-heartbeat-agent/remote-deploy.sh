#!/bin/bash
# 远程部署脚本 - 在目标主机上运行

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "=========================================="
echo "  GMS 心跳代理 - 远程部署"
echo "=========================================="
echo ""

# 1. 导入镜像
echo "[1/4] 导入 Docker 镜像..."
if [ -f "${SCRIPT_DIR}/gms-heartbeat-agent-latest.tar.gz" ]; then
    gunzip -c "${SCRIPT_DIR}/gms-heartbeat-agent-latest.tar.gz" | docker load
    echo "✅ 镜像导入成功"
else
    echo "❌ 镜像文件不存在: ${SCRIPT_DIR}/gms-heartbeat-agent-latest.tar.gz"
    exit 1
fi
echo ""

# 2. 创建工作目录
echo "[2/4] 创建工作目录..."
mkdir -p ~/machine-heartbeat-agent
cd ~/machine-heartbeat-agent
echo "✅ 工作目录: $(pwd)"
echo ""

# 3. 复制配置文件
echo "[3/4] 配置环境..."
if [ -f "${SCRIPT_DIR}/docker-compose.yml" ]; then
    cp "${SCRIPT_DIR}/docker-compose.yml" ./
fi
if [ -f "${SCRIPT_DIR}/.env.example" ]; then
    cp "${SCRIPT_DIR}/.env.example" ./
fi

# 创建 .env 文件
if [ ! -f .env ]; then
    echo "请输入 EDGE_TOKEN（边缘代理令牌）:"
    read -r token
    cat > .env <<EOF
# GMS 心跳代理配置
EDGE_TOKEN=${token}
GMS_BACKEND_URL=http://10.5.51.216:8765
HEARTBEAT_INTERVAL=30
IMPORTER_API_URL=http://127.0.0.1:5025
HERMES_API_URL=http://127.0.0.1:5006
COLLECTOR_API_TIMEOUT=3000
EOF
    echo "✅ .env 文件已创建"
else
    echo "✅ .env 文件已存在"
fi
echo ""

# 4. 启动容器
echo "[4/4] 启动 Docker 容器..."
docker-compose down 2>/dev/null || true
docker-compose up -d
echo "✅ 容器已启动"
echo ""

# 显示状态
echo "=========================================="
echo "  部署完成！"
echo "=========================================="
echo ""
docker-compose ps
echo ""
echo "查看日志: docker-compose logs -f"
echo "停止服务: docker-compose down"
echo ""
