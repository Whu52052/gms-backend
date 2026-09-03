#!/bin/bash
# 一键构建镜像并运行容器的脚本

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IMAGE_NAME="gms-heartbeat-agent"
IMAGE_TAG="latest"
CONTAINER_NAME="gms-heartbeat-agent"

echo "=========================================="
echo "  GMS 心跳代理 - 构建与部署脚本"
echo "=========================================="
echo ""

# 1. 检查 Docker
if ! command -v docker &> /dev/null; then
    echo "❌ 错误: 未安装 Docker"
    exit 1
fi

# 2. 检查 EDGE_TOKEN
if [ -z "$EDGE_TOKEN" ] && [ ! -f "$SCRIPT_DIR/.env" ]; then
    echo "⚠️  警告: 未设置 EDGE_TOKEN 环境变量"
    echo "   请创建 .env 文件并添加: EDGE_TOKEN=你的令牌"
    echo ""
    read -p "是否继续（容器将无法认证）? [y/N] " -n 1 -r
    echo ""
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        exit 1
    fi
fi

# 3. 停止并删除旧容器
echo "[1/4] 停止旧容器..."
if docker ps -a | grep -q "$CONTAINER_NAME"; then
    docker stop "$CONTAINER_NAME" 2>/dev/null || true
    docker rm "$CONTAINER_NAME" 2>/dev/null || true
    echo "✅ 旧容器已删除"
else
    echo "✅ 无旧容器"
fi
echo ""

# 4. 构建镜像
echo "[2/4] 构建 Docker 镜像..."
cd "$SCRIPT_DIR"
docker build -t "$IMAGE_NAME:$IMAGE_TAG" .
echo "✅ 镜像构建完成"
echo ""

# 5. 启动容器
echo "[3/4] 启动容器..."
docker-compose up -d
echo "✅ 容器已启动"
echo ""

# 6. 等待启动并检查状态
echo "[4/4] 检查运行状态..."
sleep 3
if docker ps | grep -q "$CONTAINER_NAME"; then
    echo "✅ 容器运行正常"
    echo ""
    docker logs "$CONTAINER_NAME" --tail 20
else
    echo "❌ 容器启动失败"
    docker logs "$CONTAINER_NAME"
    exit 1
fi

echo ""
echo "=========================================="
echo "  部署完成！"
echo "=========================================="
echo ""
echo "管理命令:"
echo "  查看日志:   docker logs -f $CONTAINER_NAME"
echo "  重启容器:   docker restart $CONTAINER_NAME"
echo "  停止容器:   docker stop $CONTAINER_NAME"
echo "  健康检查:   curl http://localhost:3000/health"
echo "  机器信息:   curl http://localhost:3000/info"
echo ""
