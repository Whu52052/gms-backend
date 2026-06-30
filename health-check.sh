#!/bin/bash
# ===================================================================
# 手套管理系统 - 健康检查与故障转移测试
# 使用: bash health-check.sh
# ===================================================================

set -e

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

log_info() { echo -e "${BLUE}[INFO]${NC} $1"; }
log_success() { echo -e "${GREEN}[SUCCESS]${NC} $1"; }
log_warning() { echo -e "${YELLOW}[WARNING]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

# 服务器列表
PRIMARY_URL="http://192.168.1.233:8765"
SECONDARY_URL="http://192.168.1.233:8765"  # 通过 Nginx 或直连

# 模拟分布式健康检查
check_server() {
    local name=$1
    local url=$2
    
    echo ""
    echo "========================================"
    echo -e "  检查: ${CYAN}$name${NC}"
    echo "========================================"
    
    # 检查 HTTP 连接
    log_info "HTTP 连接检查..."
    HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" --connect-timeout 5 "$url/api/status" 2>/dev/null || echo "000")
    
    if [ "$HTTP_CODE" = "200" ]; then
        log_success "HTTP 状态: 200 OK"
        
        # 获取详细信息
        RESPONSE=$(curl -s --connect-timeout 5 "$url/api/status")
        echo "$RESPONSE" | python3 -c "import sys,json; d=json.load(sys.stdin); print(f'  服务器角色: {d.get(\"serverRole\", \"unknown\")}'); print(f'  在线用户: {d.get(\"onlineUsers\", 0)}'); print(f'  负载级别: {d.get(\"loadLabel\", \"unknown\")}'); print(f'  版本: {d.get(\"version\", \"unknown\")}')"
        
        return 0
    else
        log_error "HTTP 状态: $HTTP_CODE"
        return 1
    fi
}

# 模拟故障转移
test_failover() {
    echo ""
    echo "========================================"
    echo -e "  故障转移测试"
    echo "========================================"
    
    log_info "模拟主服务器故障..."
    log_warning "在实际环境中，你应该:"
    echo ""
    echo "  1. 关闭主服务器: pm2 stop glove-management"
    echo "  2. 等待 Nginx 检测到故障 (约 30 秒)"
    echo "  3. 观察流量自动切换到次服务器"
    echo "  4. 测试功能是否正常"
    echo "  5. 恢复主服务器: pm2 start glove-management"
    echo "  6. 等待主服务器恢复 (约 60 秒)"
    echo "  7. 观察流量自动切回主服务器"
    echo ""
    
    read -p "是否执行故障转移测试? (y/N): " confirm
    if [ "$confirm" = "y" ]; then
        log_warning "执行故障转移测试..."
        log_warning "请在另一终端执行: pm2 stop glove-management"
        log_info "按 Ctrl+C 退出测试"
        
        # 持续监控
        while true; do
            PRIMARY_CODE=$(curl -s -o /dev/null -w "%{http_code}" --connect-timeout 3 "$PRIMARY_URL/api/status" 2>/dev/null || echo "000")
            
            if [ "$PRIMARY_CODE" = "200" ]; then
                echo -ne "\r$(date '+%H:%M:%S') | 主服务器: ${GREEN}在线${NC} | "
            else
                echo -ne "\r$(date '+%H:%M:%S') | 主服务器: ${RED}离线${NC} | "
            fi
            
            SECONDARY_CODE=$(curl -s -o /dev/null -w "%{http_code}" --connect-timeout 3 "$SECONDARY_URL/api/status" 2>/dev/null || echo "000")
            if [ "$SECONDARY_CODE" = "200" ]; then
                echo -e "次服务器: ${GREEN}在线${NC}"
            else
                echo -e "次服务器: ${RED}离线${NC}"
            fi
            
            sleep 5
        done
    fi
}

# 数据库同步检查
check_database() {
    echo ""
    echo "========================================"
    echo -e "  数据库同步检查"
    echo "========================================"
    
    log_info "检查 MySQL 主从复制状态..."
    
    # 这里需要 SSH 到 MySQL 服务器
    # mysql -h 192.168.1.233 -u gms_user -p -e "SHOW SLAVE STATUS\G"
    
    log_info "请手动检查 MySQL 主从复制:"
    echo ""
    echo "  登录主库: mysql -h 192.168.1.233 -u root -p"
    echo "  执行命令: SHOW MASTER STATUS;"
    echo ""
    echo "  登录从库: mysql -h 192.168.1.234 -u root -p"
    echo "  执行命令: SHOW SLAVE STATUS\G"
    echo ""
    echo "  确认以下状态:"
    echo "    - Slave_IO_Running: Yes"
    echo "    - Slave_SQL_Running: Yes"
    echo "    - Seconds_Behind_Master: 0 (或很小)"
}

# Redis 检查
check_redis() {
    echo ""
    echo "========================================"
    echo -e "  Redis 检查"
    echo "========================================"
    
    log_info "检查 Redis 连接..."
    
    # 测试 Redis 连接
    if command -v redis-cli &> /dev/null; then
        if redis-cli -h 192.168.1.233 -p 6379 ping 2>/dev/null | grep -q PONG; then
            log_success "Redis 连接成功"
        else
            log_error "Redis 连接失败"
        fi
    else
        log_warning "未安装 redis-cli，请手动检查"
        echo "  redis-cli -h 192.168.1.233 -p 6379 ping"
    fi
}

# 显示菜单
show_menu() {
    echo ""
    echo "============================================"
    echo "   手套管理系统 - 健康检查"
    echo "============================================"
    echo ""
    echo "  1. 检查主服务器"
    echo "  2. 检查次服务器"
    echo "  3. 检查两台服务器"
    echo "  4. 数据库同步检查"
    echo "  5. Redis 检查"
    echo "  6. 故障转移测试"
    echo "  7. 完整健康检查"
    echo "  0. 退出"
    echo ""
}

# 主菜单
while true; do
    show_menu
    read -p "请选择 (0-7): " choice
    
    case $choice in
        1)
            check_server "主服务器" "$PRIMARY_URL"
            ;;
        2)
            check_server "次服务器" "$SECONDARY_URL"
            ;;
        3)
            check_server "主服务器" "$PRIMARY_URL"
            check_server "次服务器" "$SECONDARY_URL"
            ;;
        4)
            check_database
            ;;
        5)
            check_redis
            ;;
        6)
            test_failover
            ;;
        7)
            check_server "主服务器" "$PRIMARY_URL"
            check_server "次服务器" "$SECONDARY_URL"
            check_database
            check_redis
            log_success "健康检查完成!"
            ;;
        0)
            echo "退出"
            exit 0
            ;;
        *)
            log_error "无效选择"
            ;;
    esac
done