#!/bin/bash
# ============================================================
#  GMS 自动备份 - 一键安装脚本
#  在 Linux 服务器上运行此脚本即可完成配置
#
#  用法: chmod +x setup-backup.sh && sudo ./setup-backup.sh
# ============================================================
set -e

echo "============================================"
echo "  GMS 手套管理系统 - 自动备份安装"
echo "  备份时间: 每天 22:00"
echo "  备份目录: /home/backup"
echo "============================================"
echo ""

# ==================== 配置区 ====================
# 项目部署路径（根据实际情况修改）
PROJECT_DIR="/opt/gms-backend"

# ==================== 检查 ====================
if [ "$(id -u)" != "0" ]; then
    echo "⚠️  建议使用 sudo 运行此脚本，以确保 cron 权限正确"
fi

# 检查 mysqldump
if ! command -v mysqldump &> /dev/null; then
    echo "❌ 未找到 mysqldump，请先安装 MySQL 客户端:"
    echo "   Ubuntu/Debian: sudo apt install mysql-client"
    echo "   CentOS/RHEL:   sudo yum install mysql"
    exit 1
fi
echo "✅ mysqldump 可用"

# ==================== 创建备份目录 ====================
echo ""
echo "📁 创建备份目录 /home/backup ..."
mkdir -p /home/backup
chmod 750 /home/backup
echo "✅ 备份目录已创建"

# ==================== 部署备份脚本 ====================
echo ""
echo "📜 部署备份脚本..."

# 查找 backup-daily.sh（优先使用脚本所在目录）
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
if [ -f "${SCRIPT_DIR}/backup-daily.sh" ]; then
    cp "${SCRIPT_DIR}/backup-daily.sh" /home/backup/backup-daily.sh
else
    echo "⚠️  未找到 backup-daily.sh，请确保该文件与本脚本在同一目录"
    echo "   正在从项目目录查找..."
    if [ -f "${PROJECT_DIR}/backup-daily.sh" ]; then
        cp "${PROJECT_DIR}/backup-daily.sh" /home/backup/backup-daily.sh
    else
        echo "❌ 找不到 backup-daily.sh，安装失败"
        exit 1
    fi
fi

chmod +x /home/backup/backup-daily.sh

# 将 PROJECT_DIR 写入备份脚本配置
sed -i "s|PROJECT_DIR=\"/opt/gms-backend\"|PROJECT_DIR=\"${PROJECT_DIR}\"|" /home/backup/backup-daily.sh
echo "✅ 备份脚本已部署到 /home/backup/backup-daily.sh"

# ==================== 设置 Cron 任务 ====================
echo ""
echo "⏰ 配置定时任务（每天 22:00 自动备份）..."

CRON_JOB="0 22 * * * /bin/bash /home/backup/backup-daily.sh >> /home/backup/backup.log 2>&1"

# 检查是否已存在
if crontab -l 2>/dev/null | grep -q "backup-daily.sh"; then
    echo "⚠️  cron 任务已存在，跳过添加"
else
    (crontab -l 2>/dev/null; echo "$CRON_JOB") | crontab -
    echo "✅ cron 任务已添加"
fi

# ==================== 首次测试运行 ====================
echo ""
echo "🧪 是否立即运行一次备份测试？(y/n)"
read -r answer
if [ "$answer" = "y" ] || [ "$answer" = "Y" ]; then
    echo ""
    echo "🔄 运行首次备份..."
    /bin/bash /home/backup/backup-daily.sh
    echo ""
    echo "✅ 测试备份完成！检查 /home/backup/ 查看备份文件"
fi

# ==================== 完成 ====================
echo ""
echo "============================================"
echo "  ✅ 自动备份安装完成！"
echo "============================================"
echo ""
echo "📋 安装信息："
echo "   📁 备份目录:   /home/backup/"
echo "   📜 备份脚本:   /home/backup/backup-daily.sh"
echo "   🕙 备份时间:   每天 22:00"
echo "   📅 保留天数:   30 天"
echo "   📝 日志文件:   /home/backup/backup.log"
echo ""
echo "🔧 手动命令："
echo "   手动备份:     bash /home/backup/backup-daily.sh"
echo "   查看日志:     tail -f /home/backup/backup.log"
echo "   查看备份:     ls -lh /home/backup/"
echo "   查看cron:     crontab -l"
echo "   恢复数据库:   zcat /home/backup/gms-XXXXX.tar.gz | ... "
echo ""
