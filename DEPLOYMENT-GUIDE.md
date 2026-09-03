# GMS UI 优化部署指南

## 部署方案概述

本次更新内容：
1. ✅ 全局样式优化 (`global.css`)
2. ✅ 新增 `StatsCard` 组件
3. ✅ 新增 `MachineCard` 组件

## 方案一：自动部署（推荐）

### 准备工作
```bash
# 1. 确保可以 SSH 连接到 .216
ssh root@10.5.51.216

# 2. 检查服务器上的 gms-backend 目录
ls -la /root/gms-backend
```

### 执行部署
```bash
cd D:\HuaweiMoveData\Users\24492\Desktop\1
bash deploy-ui-update.sh deploy
```

脚本会自动：
- ✅ 备份当前版本
- ✅ 构建前端项目
- ✅ 上传文件到服务器
- ✅ 重启服务

### 如果出问题回滚
```bash
# 查看可用备份
bash deploy-ui-update.sh list

# 回滚到指定备份
bash deploy-ui-update.sh rollback
# 然后输入备份文件名，例如: gms-ui-backup-20260903_143000.tar.gz
```

---

## 方案二：手动部署（安全稳妥）

### 步骤 1: 在服务器上备份当前版本

```bash
ssh root@10.5.51.216

# 创建备份目录
mkdir -p /root/gms-backups

# 备份当前版本
cd /root
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
tar -czf gms-backups/gms-ui-backup-${TIMESTAMP}.tar.gz \
    gms-backend/web/src/common/styles/global.css \
    gms-backend/web/src/common/components/ \
    gms-backend/web/dist/ \
    gms-backend/index.html \
    gms-backend/operations.html

# 确认备份成功
ls -lh gms-backups/gms-ui-backup-*.tar.gz
echo "备份完成: gms-ui-backup-${TIMESTAMP}.tar.gz"
```

### 步骤 2: 本地构建项目

```bash
# 在本地 Windows 上执行
cd D:\HuaweiMoveData\Users\24492\Desktop\1\gms-backend\web

# 安装依赖（如果需要）
npm install

# 构建项目
npm run build

# 确认构建成功
ls dist/
```

### 步骤 3: 上传更新文件

```bash
# 方法 A: 使用 SCP 上传
# 上传 global.css
scp src/common/styles/global.css root@10.5.51.216:/root/gms-backend/web/src/common/styles/

# 上传新组件
scp src/common/components/StatsCard.tsx root@10.5.51.216:/root/gms-backend/web/src/common/components/
scp src/common/components/MachineCard.tsx root@10.5.51.216:/root/gms-backend/web/src/common/components/

# 上传构建文件（使用 rsync）
rsync -avz --delete dist/ root@10.5.51.216:/root/gms-backend/web/dist/
```

**或者**

```bash
# 方法 B: 使用 WinSCP 或 FileZilla
# 1. 连接到 10.5.51.216
# 2. 手动上传以下文件:
#    - web/src/common/styles/global.css
#    - web/src/common/components/StatsCard.tsx
#    - web/src/common/components/MachineCard.tsx
#    - web/dist/* (整个目录)
```

### 步骤 4: 重启服务

```bash
ssh root@10.5.51.216

cd /root/gms-backend
pm2 restart gms-backend

# 或者如果没有启动，则启动
pm2 start ecosystem.config.js

# 查看状态
pm2 status
pm2 logs gms-backend --lines 50
```

### 步骤 5: 验证部署

访问以下 URL 检查：
- http://10.5.51.216:8765/index.html （运维系统）
- http://10.5.51.216:8765/operations.html （运营系统）

**检查点**：
- ✅ 页面能正常加载
- ✅ 卡片有阴影和悬停效果
- ✅ 按钮有悬停动画
- ✅ 样式没有错乱

### 步骤 6: 如果有问题，立即回滚

```bash
ssh root@10.5.51.216

# 查看备份
ls -lht /root/gms-backups/

# 回滚（替换 TIMESTAMP 为实际的备份时间戳）
cd /root
tar -xzf gms-backups/gms-ui-backup-TIMESTAMP.tar.gz

# 重启服务
cd /root/gms-backend
pm2 restart gms-backend
```

---

## 方案三：渐进式部署（最安全）

### 第 1 阶段：仅部署样式（风险最小）

```bash
# 1. 备份
ssh root@10.5.51.216
cp /root/gms-backend/web/src/common/styles/global.css \
   /root/gms-backend/web/src/common/styles/global.css.backup

# 2. 上传新样式
scp gms-backend/web/src/common/styles/global.css \
    root@10.5.51.216:/root/gms-backend/web/src/common/styles/

# 3. 重新构建（在服务器上）
ssh root@10.5.51.216
cd /root/gms-backend/web
npm run build
pm2 restart gms-backend

# 4. 验证
# 访问网站，检查样式是否正常
# 如果有问题，立即回滚：
cp /root/gms-backend/web/src/common/styles/global.css.backup \
   /root/gms-backend/web/src/common/styles/global.css
npm run build
pm2 restart gms-backend
```

### 第 2 阶段：添加新组件（功能扩展）

```bash
# 上传新组件（这些是新增的，不会影响现有功能）
scp gms-backend/web/src/common/components/StatsCard.tsx \
    root@10.5.51.216:/root/gms-backend/web/src/common/components/

scp gms-backend/web/src/common/components/MachineCard.tsx \
    root@10.5.51.216:/root/gms-backend/web/src/common/components/

# 重新构建
ssh root@10.5.51.216
cd /root/gms-backend/web
npm run build
pm2 restart gms-backend
```

### 第 3 阶段：在页面中使用新组件（需要修改现有代码）

这一步需要修改 `DashboardPage.tsx` 和 `MachinesPage.tsx`，可以稍后进行。

---

## 快速回滚命令

如果部署后发现问题，快速回滚：

```bash
# 1. SSH 到服务器
ssh root@10.5.51.216

# 2. 查看最新备份
ls -lt /root/gms-backups/ | head -5

# 3. 回滚（替换文件名）
cd /root
tar -xzf gms-backups/gms-ui-backup-YYYYMMDD_HHMMSS.tar.gz

# 4. 重启
cd /root/gms-backend
pm2 restart gms-backend

# 5. 验证
curl http://localhost:8765
```

---

## 监控和日志

部署后监控服务状态：

```bash
# 查看服务状态
pm2 status

# 查看实时日志
pm2 logs gms-backend

# 查看最近 100 行日志
pm2 logs gms-backend --lines 100

# 查看错误日志
pm2 logs gms-backend --err

# 查看 nginx 日志（如果有）
tail -f /var/log/nginx/access.log
tail -f /var/log/nginx/error.log
```

---

## 常见问题排查

### 问题 1: 构建失败
```bash
# 清理缓存重新构建
cd gms-backend/web
rm -rf node_modules package-lock.json
npm install
npm run build
```

### 问题 2: 样式没有生效
```bash
# 检查浏览器缓存
# 1. 打开浏览器开发者工具 (F12)
# 2. 右键刷新按钮 -> "清空缓存并硬性重新加载"
# 或者在 URL 后加 ?t=timestamp
```

### 问题 3: 服务无法启动
```bash
ssh root@10.5.51.216
cd /root/gms-backend

# 查看详细错误
pm2 logs gms-backend --err --lines 50

# 手动启动查看错误
npm start
```

### 问题 4: 文件权限问题
```bash
ssh root@10.5.51.216
cd /root/gms-backend

# 修复权限
chown -R root:root web/
chmod -R 755 web/
```

---

## 推荐的部署流程

**最稳妥的方式**：

```bash
# 1. 先在本地测试构建
cd gms-backend/web
npm run build
# 确认无错误

# 2. 手动备份服务器
ssh root@10.5.51.216
cd /root
tar -czf gms-backups/manual-backup-$(date +%Y%m%d_%H%M%S).tar.gz gms-backend/web/

# 3. 仅上传样式文件测试
scp gms-backend/web/src/common/styles/global.css root@10.5.51.216:/root/gms-backend/web/src/common/styles/

# 4. 在服务器上重新构建
ssh root@10.5.51.216
cd /root/gms-backend/web
npm run build
pm2 restart gms-backend

# 5. 访问网站验证
# http://10.5.51.216:8765

# 6. 如果一切正常，继续上传其他文件
# 如果有问题，立即回滚
```

---

## 联系支持

如果部署过程中遇到问题：
1. 查看日志文件
2. 检查备份是否完整
3. 确认可以回滚到之前的版本
4. 记录具体的错误信息

部署前请确认：
- ✅ 已创建备份
- ✅ 知道如何回滚
- ✅ 可以访问服务器
- ✅ pm2 服务正常运行
