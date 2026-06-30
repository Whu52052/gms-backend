# 分布式部署 - 快速开始

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
# 位置: 192.168.1.233
# 端口: 3306
# 数据库: gms

# 2. Redis (两台服务器共用)
# 位置: 192.168.1.233
# 端口: 6379

# 3. 上传代码到两台服务器
scp -r ./glove-management root@192.168.1.233:/opt/
scp -r ./glove-management root@192.168.1.234:/opt/
```

### 步骤 2: 部署主服务器

SSH 到主服务器执行：

```bash
cd /opt/glove-management
chmod +x deploy-primary.sh
sudo bash deploy-primary.sh
```

### 步骤 3: 部署次服务器

SSH 到次服务器执行：

```bash
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
http://你的服务器IP/deploy.html
```

在这个页面你可以：
- 填写服务器 IP 和端口
- 配置数据库连接
- 一键部署
- 查看实时日志

## 验证部署

### 1. 检查服务状态

```bash
# 主服务器
curl http://192.168.1.233:8765/api/status

# 次服务器
curl http://192.168.1.234:8765/api/status
```

应该返回：
```json
{
  "status": "ok",
  "onlineUsers": 0,
  "serverRole": "primary",  // 或 "secondary"
  "version": "3.9.0"
}
```

### 2. 故障转移测试

```bash
# SSH 到主服务器，关闭服务
ssh root@192.168.1.233
pm2 stop glove-management

# 观察 Nginx 日志，应该看到请求切换到次服务器
tail -f /var/log/nginx/access.log
```

### 3. 健康检查脚本

```bash
chmod +x health-check.sh
./health-check.sh
```

## 故障排查

### 问题: 服务启动失败

```bash
# 查看日志
pm2 logs glove-management

# 常见错误:
# - 数据库连接失败: 检查 .env 中的 DB_HOST, DB_PASSWORD
# - 端口被占用: lsof -i :8765
```

### 问题: 无法连接 Redis

```bash
# 测试 Redis 连接
redis-cli -h 192.168.1.233 -p 6379 ping
# 应该返回: PONG
```

### 问题: MySQL 主从不同步

```sql
-- 登录从库
mysql -h 192.168.1.234 -u root -p

-- 检查复制状态
SHOW SLAVE STATUS\G

-- 常见错误:
-- - Slave_IO_Running: No -> 检查网络和主库 binlog
-- - Slave_SQL_Running: No -> 检查从库 relay log
```

## 运维命令

```bash
# 查看所有服务器状态
pm2 status

# 重启服务
pm2 restart glove-management

# 查看实时日志
pm2 logs glove-management --lines 100

# 更新代码后重启
git pull
pm2 restart glove-management

# 备份数据库
mysqldump -h 192.168.1.233 -u gms_user -p gms > backup_$(date +%Y%m%d).sql
```

## 架构说明

```
用户浏览器
    ↓
Nginx (负载均衡)
    ↓
┌─────────────────┬─────────────────┐
│   主服务器       │   次服务器       │
│ 192.168.1.233   │ 192.168.1.234   │
│ :8765           │ :8765           │
│ SERVER_ROLE=    │ SERVER_ROLE=    │
│   primary        │   secondary     │
└────────┬────────┴────────┬────────┘
         │                  │
         └────────┬─────────┘
                  ↓
         ┌────────────────┐
         │   MySQL 主库   │
         │ 192.168.1.233  │
         │ (写操作)       │
         └───────┬────────┘
                 ↓ binlog
         ┌────────────────┐
         │  MySQL 从库     │
         │ 192.168.1.234  │
         │ (读操作)       │
         └────────────────┘
                 
         ┌────────────────┐
         │     Redis      │
         │ 192.168.1.233  │
         │ Session共享    │
         └────────────────┘
```

## 自动化运维

### 定时健康检查

```bash
# 添加到 crontab
crontab -e

# 每分钟检查一次
* * * * * /opt/glove-management/health-check.sh >> /var/log/gms-health.log 2>&1

# 每小时自动重启（防止内存泄漏）
0 * * * * pm2 restart glove-management
```

### 自动故障恢复

如果主服务器宕机后恢复，可以设置自动开机自启：

```bash
# 主服务器
pm2 startup
pm2 save

# 次服务器同样配置
```

## 技术支持

如遇问题，请检查：

1. 所有服务器时间是否同步：`ntpdate -q pool.ntp.org`
2. 防火墙是否放行端口：`ufw status`
3. 磁盘空间是否充足：`df -h`
4. 内存是否足够：`free -m`