#!/bin/bash
# ===================================================================
# 手套管理系统 - 次服务器一键部署脚本
# 使用: bash deploy-secondary.sh <主服务器IP> <主数据库IP> <RedisIP> <SSH密码(可选)>
# ===================================================================

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log_info() { echo -e "${BLUE}[INFO]${NC} $1"; }
log_success() { echo -e "${GREEN}[SUCCESS]${NC} $1"; }
log_warning() { echo -e "${YELLOW}[WARNING]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

echo ""
echo "============================================"
echo "   手套管理系统 - 次服务器部署脚本"
echo "============================================"
echo ""

MASTER_IP="${1:-10.5.50.30}"
DB_IP="${2:-10.5.50.30}"
REDIS_IP="${3:-10.5.50.30}"
SSH_PASSWORD="${4:-}"

# 1. 检查系统环境
log_info "步骤1: 检查系统环境..."

if command -v node &> /dev/null; then
    NODE_VERSION=$(node -v)
    log_success "Node.js 已安装: $NODE_VERSION"
else
    log_info "安装 Node.js 20.x..."
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y nodejs
    log_success "Node.js 安装完成: $(node -v)"
fi

NPM_VERSION=$(npm -v)
log_success "npm 版本: $NPM_VERSION"

if command -v pm2 &> /dev/null; then
    log_success "PM2 已安装"
else
    log_info "安装 PM2..."
    npm install -g pm2
    log_success "PM2 安装完成"
fi

# 2. 创建应用目录（使用用户主目录避免权限问题）
log_info "步骤2: 创建应用目录..."
APP_DIR="$HOME/glove-management"
if [ -d "$APP_DIR" ] && [ -f "$APP_DIR/package.json" ]; then
    log_success "应用目录已存在且包含代码: $APP_DIR"
    cd $APP_DIR
elif [ -d "$APP_DIR" ]; then
    log_warning "应用目录已存在: $APP_DIR"
    read -p "是否删除并重新创建? (y/N): " confirm
    if [ "$confirm" = "y" ]; then
        pm2 delete all 2>/dev/null || true
        rm -rf $APP_DIR
        mkdir -p $APP_DIR
        log_success "已删除旧目录"
    fi
else
    mkdir -p $APP_DIR
fi

cd $APP_DIR
log_success "应用目录: $APP_DIR"

# 3. 复制代码（从主服务器）
log_info "步骤3: 从主服务器复制应用代码..."
if [ -n "$SSH_PASSWORD" ]; then
    sshpass -p "$SSH_PASSWORD" rsync -avz --delete --exclude='node_modules' --exclude='.git' --exclude='*.log' $MASTER_IP:/opt/glove-management/ $APP_DIR/ 2>&1 || true
else
    rsync -avz --delete --exclude='node_modules' --exclude='.git' --exclude='*.log' $MASTER_IP:/opt/glove-management/ $APP_DIR/ 2>&1 || true
fi
log_success "代码复制完成"

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

cat > $ENV_FILE << EOF
# 服务器配置
PORT=8765
NODE_ENV=production
SERVER_ROLE=secondary
SERVER_ID=secondary-$(hostname)-$(date +%Y%m%d)

# MySQL 数据库配置（连接主库）
DB_HOST=$DB_IP
DB_PORT=3306
DB_USER=gms_user
DB_PASSWORD=gms_password_2024
DB_NAME=gms

# Redis 配置（连接主服务器 Redis）
REDIS_URL=redis://$REDIS_IP:6379

# 日志配置
LOG_LEVEL=info
EOF

log_success "配置文件已创建: $ENV_FILE"
log_warning "数据库密码为默认值，请根据需要修改"

# 6. 安装 MySQL 客户端（用于测试连接）
log_info "步骤6: 安装MySQL客户端..."
if ! command -v mysql &> /dev/null; then
    apt-get install -y mysql-client
    log_success "MySQL客户端安装完成"
else
    log_success "MySQL客户端已安装"
fi

# 7. 测试数据库连接
log_info "步骤7: 测试数据库连接..."
if mysql -h $DB_IP -u gms_user -pgms_password_2024 -e "SELECT 1" 2>/dev/null; then
    log_success "✅ 数据库连接测试通过!"
else
    log_warning "⚠️ 数据库连接测试失败"
    log_warning "请确保主服务器MySQL已开启远程访问"
    log_warning "可以在主服务器执行: mysql -u root -e \"GRANT ALL ON gms.* TO 'gms_user'@'%'; FLUSH PRIVILEGES;\""
fi

# 8. 启动服务
log_info "步骤8: 启动服务..."

pm2 delete glove-management 2>/dev/null || true

cd $APP_DIR
pm2 start ecosystem.config.js --name "glove-management"

pm2 save

log_info "配置开机自启..."
pm2 startup 2>/dev/null || log_warning "请手动设置开机自启: pm2 startup"

# 9. 配置防火墙
log_info "步骤9: 配置防火墙..."
if command -v ufw &> /dev/null; then
    ufw allow 8765/tcp comment 'GMS Secondary'
    log_success "防火墙规则已添加"
else
    log_warning "未检测到 UFW，请手动配置防火墙"
fi

# 10. 检查服务状态
log_info "步骤10: 检查服务状态..."
sleep 3

API_URL="http://localhost:8765/api/status"
log_info "检查 API: $API_URL"

for i in {1..5}; do
    RESPONSE=$(curl -s --connect-timeout 3 $API_URL)
    if echo "$RESPONSE" | grep -q "ok"; then
        log_success "服务启动成功!"
        echo "$RESPONSE" | head -c 300
        echo ""
        
        if echo "$RESPONSE" | grep -q '"serverRole":"secondary"'; then
            log_success "服务器角色确认: secondary (次服务器)"
        fi
        break
    else
        log_warning "等待服务启动... ($i/5)"
        sleep 2
    fi
done

# 11. 显示结果
echo ""
echo "============================================"
echo "   次服务器部署完成!"
echo "============================================"
echo ""
log_info "应用目录: $APP_DIR"
log_info "服务器角色: secondary (次服务器)"
log_info "主数据库: $DB_IP:3306"
log_info "Redis: $REDIS_IP:6379"
log_info "访问地址: http://$(hostname -I | awk '{print $1}'):8765"
log_info "API 状态: http://localhost:8765/api/status"
log_info "PM2 日志: pm2 logs glove-management"
log_info "PM2 状态: pm2 status"
echo ""
log_warning "请确保:"
log_warning "  1. MySQL 主库 ($DB_IP) 已开启远程访问"
log_warning "  2. Redis ($REDIS_IP:6379) 已正常运行"
log_warning "  3. 防火墙已开放 8765 和 3306 端口"
echo ""

pm2 status