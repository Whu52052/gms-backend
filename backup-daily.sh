#!/bin/bash
# ============================================================
#  GMS 手套管理系统 - 每日自动备份脚本
#  运行于 Linux 服务器，每天 22:00 由 cron 触发
#  备份目标：/home/backup/
# ============================================================
set -e

# ==================== 配置 ====================
# MySQL 数据库配置（从 server.js 读取）
DB_HOST="sh-cynosdbmysql-grp-pbo2ohcm.sql.tencentcdb.com"
DB_PORT="22387"
DB_USER="Wuzhenyu"
DB_PASSWORD="Wh111852"
DB_NAME="gms"

# 项目目录（部署路径，根据实际情况修改）
PROJECT_DIR="/opt/gms-backend"

# 备份目录
BACKUP_ROOT="/home/backup"

# 日志文件
LOG_FILE="${BACKUP_ROOT}/backup.log"

# 保留天数
KEEP_DAYS=30

# 时间戳
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
DATE_STR=$(date +%Y-%m-%d_%H:%M:%S)
BACKUP_DIR="${BACKUP_ROOT}/gms-${TIMESTAMP}"

# ==================== 函数 ====================
log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" | tee -a "$LOG_FILE"
}

# ==================== 开始 ====================
mkdir -p "$BACKUP_ROOT"
mkdir -p "$BACKUP_DIR"

log "========== 备份开始 =========="

# --- 1. MySQL 数据库导出 ---
log "[1/4] 导出 MySQL 数据库 ${DB_NAME}..."
if mysqldump \
    --host="${DB_HOST}" \
    --port="${DB_PORT}" \
    --user="${DB_USER}" \
    --password="${DB_PASSWORD}" \
    --single-transaction \
    --routines \
    --triggers \
    --events \
    --default-character-set=utf8mb4 \
    --no-tablespaces \
    "${DB_NAME}" > "${BACKUP_DIR}/database.sql" 2>/dev/null; then

    # 压缩
    gzip -f "${BACKUP_DIR}/database.sql"
    DB_SIZE=$(du -h "${BACKUP_DIR}/database.sql.gz" | cut -f1)
    log "   ✅ 数据库导出成功 (${DB_SIZE})"
else
    log "   ❌ 数据库导出失败！"
    # 不退出，继续备份文件
fi

# --- 2. 项目文件备份 ---
log "[2/4] 备份项目文件..."
if [ -d "$PROJECT_DIR" ]; then
    # 备份关键配置文件
    FILES_TO_BACKUP=(
        "server.js"
        "package.json"
        "package-lock.json"
        "Dockerfile"
        "cloudbaserc.json"
        "feishu.js"
        ".dockerignore"
        ".gitignore"
        "k8s-deployment.yaml"
        "render.yaml"
        "glove-management.service"
        "start-server.sh"
    )

    for f in "${FILES_TO_BACKUP[@]}"; do
        if [ -f "${PROJECT_DIR}/${f}" ]; then
            mkdir -p "$(dirname "${BACKUP_DIR}/project/${f}")"
            cp "${PROJECT_DIR}/${f}" "${BACKUP_DIR}/project/${f}"
        fi
    done

    # 备份 uploads 目录（用户上传的图片）
    if [ -d "${PROJECT_DIR}/uploads" ]; then
        cp -r "${PROJECT_DIR}/uploads" "${BACKUP_DIR}/uploads" 2>/dev/null || true
        UPLOAD_COUNT=$(find "${BACKUP_DIR}/uploads" -type f 2>/dev/null | wc -l)
        log "   📁 uploads: ${UPLOAD_COUNT} 个文件"
    fi

    # 备份 data 目录（JSON兜底数据 + SQLite）
    if [ -d "${PROJECT_DIR}/data" ]; then
        cp -r "${PROJECT_DIR}/data" "${BACKUP_DIR}/data" 2>/dev/null || true
        log "   📁 data 目录已备份"
    fi

    # 备份 css 目录
    if [ -d "${PROJECT_DIR}/css" ]; then
        cp -r "${PROJECT_DIR}/css" "${BACKUP_DIR}/css" 2>/dev/null || true
    fi

    # 备份 js 目录
    if [ -d "${PROJECT_DIR}/js" ]; then
        cp -r "${PROJECT_DIR}/js" "${BACKUP_DIR}/js" 2>/dev/null || true
    fi

    # 备份 HTML 文件
    cp "${PROJECT_DIR}"/*.html "${BACKUP_DIR}/project/" 2>/dev/null || true

    log "   ✅ 项目文件备份完成"
else
    log "   ⚠️ 项目目录 ${PROJECT_DIR} 不存在，跳过文件备份"
fi

# --- 3. 生成备份信息文件 ---
log "[3/4] 生成备份元信息..."
cat > "${BACKUP_DIR}/backup-info.txt" << EOF
备份时间: ${DATE_STR}
服务器: $(hostname)
数据库: ${DB_HOST}:${DB_PORT}/${DB_NAME}
项目目录: ${PROJECT_DIR}
备份脚本版本: 1.0
EOF

# --- 4. 打包压缩 ---
log "[4/4] 打包压缩..."
cd "$BACKUP_ROOT"
tar -czf "gms-${TIMESTAMP}.tar.gz" "gms-${TIMESTAMP}" 2>/dev/null
rm -rf "gms-${TIMESTAMP}"
BACKUP_SIZE=$(du -h "gms-${TIMESTAMP}.tar.gz" | cut -f1)
log "   📦 备份包: gms-${TIMESTAMP}.tar.gz (${BACKUP_SIZE})"

# --- 清理旧备份 ---
log "🧹 清理 ${KEEP_DAYS} 天前的旧备份..."
DELETED=$(find "$BACKUP_ROOT" -name "gms-*.tar.gz" -mtime +${KEEP_DAYS} -delete -print 2>/dev/null | wc -l)
if [ "$DELETED" -gt 0 ]; then
    log "   🗑️ 已删除 ${DELETED} 个旧备份"
else
    log "   ✨ 无需清理"
fi

# --- 统计 ---
BACKUP_COUNT=$(find "$BACKUP_ROOT" -name "gms-*.tar.gz" | wc -l)
TOTAL_SIZE=$(du -sh "$BACKUP_ROOT" | cut -f1)
log "========== 备份完成 =========="
log "📊 当前备份总数: ${BACKUP_COUNT} 个"
log "💾 备份目录大小: ${TOTAL_SIZE}"
log "📁 备份目录位置: ${BACKUP_ROOT}"
log ""
