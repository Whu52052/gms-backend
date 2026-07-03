#!/bin/bash
# =============================================
#  Yunwei 手套管理系统 — 一键部署脚本
#  适用: Ubuntu 20.04+ / 内网环境
# =============================================
set -e

echo "========================================="
echo "  🚀 Yunwei 手套管理系统 — 一键部署"
echo "========================================="
echo ""

# 1. 检查/安装 Docker
if ! command -v docker &> /dev/null; then
    echo "[1/5] 安装 Docker..."
    curl -fsSL https://get.docker.com | sudo bash
    sudo usermod -aG docker $USER
    echo "  ✅ Docker 安装完成（请重新登录使权限生效）"
else
    echo "[1/5] Docker 已安装 ✅"
fi

# 2. 检查/安装 Docker Compose
if ! command -v docker-compose &> /dev/null; then
    echo "[2/5] 安装 Docker Compose..."
    sudo apt update -qq && sudo apt install docker-compose -y -qq
    echo "  ✅ Docker Compose 安装完成"
else
    echo "[2/5] Docker Compose 已安装 ✅"
fi

# 3. 创建必要目录
echo "[3/5] 创建目录..."
mkdir -p data uploads
echo "  ✅ 目录已就绪"

# 4. 拉取镜像并构建
echo "[4/5] 构建并启动服务..."
docker-compose pull mysql redis nginx 2>/dev/null || true
docker-compose build --quiet app
echo "  ✅ 镜像构建完成"

# 5. 启动所有服务
echo "[5/5] 启动服务..."
docker-compose up -d

# 等待服务就绪
echo ""
echo "⏳ 等待服务就绪..."
sleep 10

# 健康检查
if curl -s -o /dev/null -w "%{http_code}" http://localhost:8088/api/health | grep -q 200; then
    echo ""
    echo "========================================="
    echo "  ✅ 部署成功！"
    echo "========================================="
    echo ""
    echo "  访问地址: http://$(hostname -I | awk '{print $1}')"
    echo ""
    echo "  默认账户:"
    echo "    运维超管: Yunwei / yunwei1025"
    echo "    运营超管: yunying / yunying1025"
    echo "    管理员:   admin  / admin123"
    echo ""
    echo "  常用命令:"
    echo "    docker-compose ps          查看服务状态"
    echo "    docker-compose logs -f app 查看应用日志"
    echo "    docker-compose restart app 重启应用"
    echo "    docker-compose down        停止所有服务"
    echo ""
else
    echo ""
    echo "⚠️  服务可能尚未完全启动，请稍等后检查："
    echo "  docker-compose ps"
    echo "  curl http://localhost:8088/api/health"
fi
