# 分布式部署 - 快速开始

## 当前配置

| 角色 | IP地址 | 端口 |
|------|--------|------|
| 主服务器 | 10.5.50.30 | 8765 |
| 次服务器 | 10.5.50.35 | 8765 |
| MySQL | 10.5.50.30 | 3306 |
| Redis | 10.5.50.30 | 6379 |

## 文件说明

| 文件 | 说明 |
|------|------|
| `deploy.html` | 可视化部署向导（Web界面） |
| `deploy-primary.sh` | 主服务器一键部署脚本 |
| `deploy-secondary.sh` | 次服务器一键部署脚本 |
| `health-check.sh` | 健康检查与故障转移测试脚本 |

## 部署流程（5分钟完成）

### 步骤 1: 准备工作

确保以下服务已配置好：

```bash
# 1. MySQL 主库 (两台服务器共用)
# 位置: 10.5.50.30
# 端口: 3306
# 数据库: gms

# 2. Redis (两台服务器共用)
# 位置: 10.5.50.30
# 端口: 6379

# 3. 上传代码到两台服务器
scp -r ./glove-management root@10.5.50.30:/opt/
scp -r ./glove-management root@10.5.50.35:/opt/
```

### 步骤 2: 部署主服务器

SSH 到主服务器执行：

```bash
ssh root@10.5.50.30
cd /opt/glove-management
chmod +x deploy-primary.sh
sudo bash deploy-primary.sh
```

### 步骤 3: 部署次服务器

SSH 到次服务器执行：

```bash
ssh root@10.5.50.35
cd /opt/glove-management
chmod +x deploy-secondary.sh
sudo bash deploy-secondary.sh
```

### 步骤 4: 配置 Nginx 负载均衡

在 Nginx 服务器执行：

```bash
sudo cp nginx-lb.conf /etc/nginx/sites-available/yunwei
sudo ln -s /etc/nginx/sites-available/yunwei /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

### 步骤 5: 可视化部署（推荐）

打开浏览器访问：

```
http://10.5.50.30/deploy.html
```

## 验证部署

### 1. 检查服务状态

```bash
# 主服务器
curl http://10.5.50.30:8765/api/status

# 次服务器
curl http://10.5.50.35:8765/api/status
```

## 架构说明

```
用户浏览器
    ↓
Nginx (负载均衡)
    ↓
┌─────────────────┬─────────────────┐
│   主服务器       │   次服务器       │
│ 10.5.50.30      │ 10.5.50.35      │
│ :8765           │ :8765           │
│ SERVER_ROLE=    │ SERVER_ROLE=    │
│   primary        │   secondary     │
└────────┬────────┴────────┬────────┘
         │                  │
         └────────┬─────────┘
                  ↓
         ┌────────────────┐
         │   MySQL 主库   │
         │ 10.5.50.30    │
         └───────┬────────┘
                 ↓ binlog
         ┌────────────────┐
         │     Redis      │
         │ 10.5.50.30    │
         │ Session共享    │
         └────────────────┘
```

## 运维命令

```bash
# 查看服务状态
pm2 status

# 重启服务
pm2 restart glove-management

# 查看实时日志
pm2 logs glove-management --lines 100

# 更新代码后重启
git pull
pm2 restart glove-management

# 备份数据库
mysqldump -h 10.5.50.30 -u gms_user -p gms > backup_$(date +%Y%m%d).sql
```
