#!/bin/bash
# 一键打包部署文件

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PACKAGE_NAME="gms-heartbeat-agent-deploy-$(date +%Y%m%d-%H%M%S)"
PACKAGE_DIR="/tmp/${PACKAGE_NAME}"

echo "=========================================="
echo "  打包部署文件"
echo "=========================================="
echo ""

# 创建临时目录
mkdir -p "${PACKAGE_DIR}"

# 复制必要文件
echo "[1/3] 复制文件..."
cp "${SCRIPT_DIR}/gms-heartbeat-agent-latest.tar.gz" "${PACKAGE_DIR}/"
cp "${SCRIPT_DIR}/docker-compose.yml" "${PACKAGE_DIR}/"
cp "${SCRIPT_DIR}/.env.example" "${PACKAGE_DIR}/"
cp "${SCRIPT_DIR}/remote-deploy.sh" "${PACKAGE_DIR}/"
echo "✅ 文件已复制"
echo ""

# 创建部署说明
echo "[2/3] 生成部署说明..."
cat > "${PACKAGE_DIR}/README.md" <<'EOF'
# GMS 心跳代理 - 部署包

## 📦 包含文件

- `gms-heartbeat-agent-latest.tar.gz` - Docker 镜像（129 MB）
- `docker-compose.yml` - Docker Compose 配置
- `.env.example` - 环境变量模板
- `remote-deploy.sh` - 自动部署脚本

## 🚀 快速部署

### 方式一：自动部署（推荐）

```bash
# 1. 解压部署包
tar -xzf gms-heartbeat-agent-deploy-*.tar.gz
cd gms-heartbeat-agent-deploy-*/

# 2. 运行自动部署脚本
bash remote-deploy.sh
```

### 方式二：手动部署

```bash
# 1. 导入镜像
gunzip -c gms-heartbeat-agent-latest.tar.gz | docker load

# 2. 创建工作目录
mkdir -p ~/machine-heartbeat-agent
cd ~/machine-heartbeat-agent

# 3. 复制配置文件
cp /path/to/docker-compose.yml ./
cp /path/to/.env.example ./.env

# 4. 配置环境变量
vim .env
# 修改 EDGE_TOKEN 为您的令牌

# 5. 启动容器
docker-compose up -d
```

## ⚙️ 配置说明

编辑 `.env` 文件：

```bash
# 边缘代理令牌（必填）
EDGE_TOKEN=your-token-here

# GMS 服务器地址
GMS_SERVER_URL=http://10.5.51.216:8765

# 心跳间隔（毫秒）
HEARTBEAT_INTERVAL=30000
```

## 📝 常用命令

```bash
# 查看容器状态
docker-compose ps

# 查看日志
docker-compose logs -f

# 重启容器
docker-compose restart

# 停止容器
docker-compose down

# 更新容器
docker-compose pull
docker-compose up -d
```

## 🔍 故障排查

### 容器无法启动
```bash
# 查看详细日志
docker-compose logs

# 检查端口占用
netstat -tlnp | grep :3000
```

### 无法连接 GMS 服务器
```bash
# 测试网络连通性
ping 10.5.51.216
curl http://10.5.51.216:8765/api/health
```

## 📞 支持

如有问题，请联系技术支持。
EOF
echo "✅ 部署说明已生成"
echo ""

# 打包
echo "[3/3] 创建压缩包..."
cd /tmp
tar -czf "${PACKAGE_NAME}.tar.gz" "${PACKAGE_NAME}/"
rm -rf "${PACKAGE_DIR}"
echo "✅ 打包完成"
echo ""

echo "=========================================="
echo "  打包完成！"
echo "=========================================="
echo ""
echo "部署包位置: /tmp/${PACKAGE_NAME}.tar.gz"
echo "文件大小: $(du -h /tmp/${PACKAGE_NAME}.tar.gz | cut -f1)"
echo ""
echo "传输到目标主机:"
echo "  scp /tmp/${PACKAGE_NAME}.tar.gz we@10.5.51.101:~/"
echo ""
