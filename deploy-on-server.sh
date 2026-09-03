#!/bin/bash
# 在服务器上执行的部署脚本

echo "=== GMS UI 优化部署 ==="
echo ""

# 1. 检查 gms-backend 位置
echo "步骤 1: 检查 gms-backend 目录..."
if [ -d "/root/gms-backend" ]; then
    GMS_PATH="/root/gms-backend"
elif [ -d "$HOME/gms-backend" ]; then
    GMS_PATH="$HOME/gms-backend"
else
    echo "错误: 找不到 gms-backend 目录"
    echo "请手动指定路径，或者执行: find ~ -name gms-backend -type d"
    exit 1
fi

echo "✅ 找到 gms-backend: $GMS_PATH"
echo ""

# 2. 创建备份
echo "步骤 2: 备份当前版本..."
mkdir -p $HOME/gms-backups
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_NAME="gms-ui-backup-${TIMESTAMP}"

cd $HOME
tar -czf gms-backups/${BACKUP_NAME}.tar.gz \
    ${GMS_PATH#$HOME/}/web/src/common/styles/global.css \
    ${GMS_PATH#$HOME/}/web/src/common/components/ \
    ${GMS_PATH#$HOME/}/web/dist/ \
    2>/dev/null

echo "✅ 备份完成: ${BACKUP_NAME}.tar.gz"
ls -lh gms-backups/${BACKUP_NAME}.tar.gz
echo ""

# 3. 等待文件上传
echo "步骤 3: 请在本地上传以下文件到服务器:"
echo ""
echo "  文件 1: gms-backend/web/src/common/styles/global.css"
echo "  目标位置: ${GMS_PATH}/web/src/common/styles/"
echo ""
echo "  文件 2: gms-backend/web/src/common/components/StatsCard.tsx"
echo "  目标位置: ${GMS_PATH}/web/src/common/components/"
echo ""
echo "  文件 3: gms-backend/web/src/common/components/MachineCard.tsx"
echo "  目标位置: ${GMS_PATH}/web/src/common/components/"
echo ""
echo "上传完成后，按回车继续..."
read

# 4. 重新构建
echo "步骤 4: 重新构建前端..."
cd ${GMS_PATH}/web

if [ ! -d "node_modules" ]; then
    echo "安装依赖..."
    npm install
fi

npm run build

if [ $? -ne 0 ]; then
    echo "❌ 构建失败"
    exit 1
fi

echo "✅ 构建成功"
echo ""

# 5. 重启服务
echo "步骤 5: 重启服务..."
cd ${GMS_PATH}

pm2 restart gms-backend || pm2 start ecosystem.config.js

pm2 status

echo ""
echo "=== 部署完成 ==="
echo ""
echo "访问: http://10.5.51.216:8765"
echo "备份文件: ${BACKUP_NAME}.tar.gz"
echo ""
echo "如果有问题，回滚命令:"
echo "cd $HOME && tar -xzf gms-backups/${BACKUP_NAME}.tar.gz && cd ${GMS_PATH} && pm2 restart gms-backend"
