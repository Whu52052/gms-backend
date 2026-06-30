#!/bin/bash
# ===================================================================
# 手套管理系统 - 主服务器一键部署脚本
# 使用: bash deploy-primary.sh
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
echo "   手套管理系统 - 主服务器部署脚本"
echo "============================================"
echo ""

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

# 3. 复制代码
log_info "步骤3: 复制应用代码..."
SRC_DIR=""
if [ -f "$(pwd)/package.json" ]; then
    SRC_DIR="$(pwd)"
elif [ -f "$HOME/gms-backend/package.json" ]; then
    SRC_DIR="$HOME/gms-backend"
elif [ -f "/workspace/package.json" ]; then
    SRC_DIR="/workspace"
elif [ -f "/opt/glove-management/package.json" ]; then
    SRC_DIR="/opt/glove-management"
fi

if [ -n "$SRC_DIR" ] && [ "$SRC_DIR" != "$APP_DIR" ]; then
    log_info "从 $SRC_DIR 复制代码..."
    cp -r "$SRC_DIR"/* $APP_DIR/
    log_success "代码复制完成 ($SRC_DIR → $APP_DIR)"
else
    log_info "请将代码包上传到: $APP_DIR"
    log_info "当前目录: $(pwd)"
    log_info "当前目录文件: $(ls -1 | head -5)"
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

cat > $ENV_FILE << EOF
# 服务器配置
PORT=8765
NODE_ENV=production
SERVER_ROLE=primary
SERVER_ID=primary-$(hostname)-$(date +%Y%m%d)

# MySQL 数据库配置
DB_HOST=localhost
DB_PORT=3306
DB_USER=gms_user
DB_PASSWORD=gms_password_2024
DB_NAME=gms

# Redis 配置
REDIS_URL=redis://localhost:6379

# 日志配置
LOG_LEVEL=info
EOF

log_success "配置文件已创建: $ENV_FILE"
log_warning "数据库密码为默认值，请根据需要修改"

# 6. 配置 MySQL 远程访问（允许次服务器连接）
log_info "步骤6: 配置MySQL远程访问..."
if command -v mysql &> /dev/null; then
    log_info "创建远程访问用户..."
    mysql -u root -e "CREATE USER IF NOT EXISTS 'gms_user'@'%' IDENTIFIED BY 'gms_password_2024'; GRANT ALL PRIVILEGES ON gms.* TO 'gms_user'@'%'; FLUSH PRIVILEGES;" 2>/dev/null || log_warning "MySQL用户创建可能已存在"
    
    log_info "检查MySQL绑定地址..."
    if grep -q "^bind-address.*127.0.0.1" /etc/mysql/mysql.conf.d/mysqld.cnf 2>/dev/null; then
        log_info "修改MySQL绑定地址..."
        sed -i "s/^bind-address.*/bind-address = 0.0.0.0/" /etc/mysql/mysql.conf.d/mysqld.cnf
        log_success "已修改绑定地址为 0.0.0.0"
    elif grep -q "^bind-address.*0.0.0.0" /etc/mysql/mysql.conf.d/mysqld.cnf 2>/dev/null; then
        log_success "MySQL已绑定到所有地址"
    else
        log_info "MySQL配置未找到bind-address（可能已默认监听所有地址）"
    fi
    
    log_info "开放MySQL端口(3306)防火墙..."
    if command -v ufw &> /dev/null; then
        ufw allow 3306/tcp comment 'MySQL Remote'
    fi
    
    log_info "重启MySQL服务..."
    systemctl restart mysql 2>/dev/null || service mysql restart 2>/dev/null || true
    log_success "MySQL远程访问配置完成"
else
    log_warning "MySQL未安装，请手动配置远程访问"
fi

# 7. 安装 Redis（如果未安装）
log_info "步骤7: 检查Redis..."
if command -v redis-server &> /dev/null; then
    log_success "Redis已安装"
else
    log_info "安装Redis..."
    apt-get install -y redis-server
    systemctl enable redis-server
    systemctl start redis-server
    log_success "Redis安装完成"
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
    ufw allow 8765/tcp comment 'GMS Main'
    ufw allow 80/tcp comment 'HTTP'
    ufw allow 443/tcp comment 'HTTPS'
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
        
        if echo "$RESPONSE" | grep -q '"serverRole":"primary"'; then
            log_success "服务器角色确认: primary (主服务器)"
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
echo "   主服务器部署完成!"
echo "============================================"
echo ""
log_info "应用目录: $APP_DIR"
log_info "服务器角色: primary (主服务器)"
log_info "访问地址: http://$(hostname -I | awk '{print $1}'):8765"
log_info "API 状态: http://localhost:8765/api/status"
log_info "PM2 日志: pm2 logs glove-management"
log_info "PM2 状态: pm2 status"
echo ""
log_info "📋 次服务器部署信息:"
log_info "   - 主数据库IP: $(hostname -I | awk '{print $1}'):3306"
log_info "   - Redis: $(hostname -I | awk '{print $1}'):6379"
log_info "   - 部署命令: bash deploy-secondary.sh $(hostname -I | awk '{print $1}')"
echo ""
log_warning "请确保:"
log_warning "  1. MySQL用户 'gms_user'@'%' 已创建"
log_warning "  2. Redis已正常运行"
log_warning "  3. 防火墙已开放 8765, 3306 端口"
echo ""

pm2 status