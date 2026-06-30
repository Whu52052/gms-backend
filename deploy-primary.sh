#!/bin/bash
# ===================================================================
# 手套管理系统 - 主服务器一键部署脚本
# 使用: bash deploy-primary.sh
# ===================================================================

set -e

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# 日志函数
log_info() { echo -e "${BLUE}[INFO]${NC} $1"; }
log_success() { echo -e "${GREEN}[SUCCESS]${NC} $1"; }
log_warning() { echo -e "${YELLOW}[WARNING]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

echo ""
echo "============================================"
echo "   手套管理系统 - 主服务器部署脚本"
echo "============================================"
echo ""

# 检查 root 权限
if [ "$EUID" -ne 0 ]; then
    log_warning "建议使用 root 权限运行: sudo bash $0"
fi

# 1. 检查系统环境
log_info "步骤1: 检查系统环境..."

# 检查 Node.js
if command -v node &> /dev/null; then
    NODE_VERSION=$(node -v)
    log_success "Node.js 已安装: $NODE_VERSION"
else
    log_info "安装 Node.js 20.x..."
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y nodejs
    log_success "Node.js 安装完成: $(node -v)"
fi

# 检查 npm
NPM_VERSION=$(npm -v)
log_success "npm 版本: $NPM_VERSION"

# 检查 PM2
if command -v pm2 &> /dev/null; then
    log_success "PM2 已安装"
else
    log_info "安装 PM2..."
    npm install -g pm2
    log_success "PM2 安装完成"
fi

# 2. 创建应用目录
log_info "步骤2: 创建应用目录..."
APP_DIR="/opt/glove-management"
if [ -d "$APP_DIR" ]; then
    log_warning "应用目录已存在: $APP_DIR"
    read -p "是否删除并重新创建? (y/N): " confirm
    if [ "$confirm" = "y" ]; then
        pm2 delete all 2>/dev/null || true
        rm -rf $APP_DIR
        log_success "已删除旧目录"
    fi
fi

mkdir -p $APP_DIR
cd $APP_DIR
log_success "应用目录: $APP_DIR"

# 3. 复制代码
log_info "步骤3: 复制应用代码..."
# 检查当前目录是否有 package.json
if [ -f "/workspace/package.json" ]; then
    log_info "从 /workspace 复制代码..."
    cp -r /workspace/* $APP_DIR/
    log_success "代码复制完成"
else
    log_info "请将代码包上传到: $APP_DIR"
    log_info "可以使用: scp -r ./glove-management.tar.gz root@$(hostname -I | awk '{print $1}'):/opt/"
fi

# 4. 安装依赖
log_info "步骤4: 安装应用依赖..."
if [ -f "$APP_DIR/package.json" ]; then
    cd $APP_DIR
    npm install --production
    log_success "依赖安装完成"
else
    log_error "未找到 package.json"
    exit 1
fi

# 5. 配置环境变量
log_info "步骤5: 配置环境变量..."
ENV_FILE="$APP_DIR/.env"

cat > $ENV_FILE << 'EOF'
# ===================================================================
# 手套管理系统 - 环境配置 (主服务器)
# ===================================================================

# 服务器配置
PORT=8765
NODE_ENV=production

# 服务器角色
SERVER_ROLE=primary
SERVER_ID=primary-$(hostname)-$(date +%Y%m%d)

# ===================================================================
# MySQL 数据库配置
# ===================================================================
DB_HOST=10.5.50.30
DB_PORT=3306
DB_USER=gms_user
DB_PASSWORD=your_password_here
DB_NAME=gms

# 可选: MySQL 从库 (用于读写分离)
# DB_HOST_READ=192.168.1.234
# DB_PORT_READ=3306

# ===================================================================
# Redis 配置
# ===================================================================
REDIS_URL=redis://10.5.50.30:6379
# REDIS_PASSWORD=your_redis_password

# ===================================================================
# 日志配置
# ===================================================================
LOG_LEVEL=info
EOF

log_success "配置文件已创建: $ENV_FILE"
log_warning "请编辑 $ENV_FILE 设置数据库密码"

# 6. 启动服务
log_info "步骤6: 启动服务..."

# 如果已有进程，先删除
pm2 delete glove-management 2>/dev/null || true

# 启动服务
cd $APP_DIR
pm2 start ecosystem.config.js --name "glove-management"

# 保存 PM2 配置
pm2 save

# 设置开机自启
log_info "配置开机自启..."
pm2 startup 2>/dev/null || log_warning "请手动设置开机自启: pm2 startup"

# 7. 配置防火墙
log_info "步骤7: 配置防火墙..."
if command -v ufw &> /dev/null; then
    ufw allow 8765/tcp comment 'GMS Main'
    ufw allow 80/tcp comment 'HTTP'
    ufw allow 443/tcp comment 'HTTPS'
    log_success "防火墙规则已添加"
else
    log_warning "未检测到 UFW，请手动配置防火墙"
fi

# 8. 检查服务状态
log_info "步骤8: 检查服务状态..."
sleep 2

# 检查 API 状态
API_URL="http://localhost:8765/api/status"
log_info "检查 API: $API_URL"

for i in {1..5}; do
    if curl -s --connect-timeout 3 $API_URL | grep -q "ok"; then
        log_success "服务启动成功!"
        curl -s $API_URL | head -c 200
        echo ""
        break
    else
        log_warning "等待服务启动... ($i/5)"
        sleep 2
    fi
done

# 9. 显示结果
echo ""
echo "============================================"
echo "   部署完成!"
echo "============================================"
echo ""
log_info "应用目录: $APP_DIR"
log_info "访问地址: http://localhost:8765"
log_info "API 状态: http://localhost:8765/api/status"
log_info "PM2 日志: pm2 logs glove-management"
log_info "PM2 状态: pm2 status"
echo ""
log_warning "请编辑 $ENV_FILE 设置数据库密码"
log_warning "然后重启服务: pm2 restart glove-management"
echo ""

# 显示 PM2 状态
pm2 status