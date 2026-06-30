# 分布式高可用部署指南

## 架构概览

```
                     ┌─────────────┐
                     │   Nginx     │
                     │  负载均衡   │
                     └──────┬──────┘
                            │
         ┌──────────────────┼──────────────────┐
         │                  │                  │
    ┌────▼────┐        ┌────▼────┐        ┌────▼────┐
    │ 主服务器 │        │次服务器1 │        │次服务器2 │
    │ :8765   │        │ :8765   │        │ :8765   │
    │(primary)│        │(secondary)│       │(可选)   │
    └────┬────┘        └────┬────┘        └────┬────┘
         │                  │                  │
         └──────────────────┼──────────────────┘
                            │
                     ┌──────▼──────┐
                     │ MySQL 主库  │
                     │  写操作    │
                     └──────┬──────┘
                            │ binlog 同步
                     ┌──────▼──────┐
                     │ MySQL 从库  │
                     │  读操作    │
                     └─────────────┘
                            
                     ┌─────────────┐
                     │   Redis     │
                     │ Session共享 │
                     │  Pub/Sub    │
                     └─────────────┘
```

## 1. MySQL 主从复制配置

### 主库配置（192.168.1.233）

```bash
# /etc/mysql/mysql.conf.d/mysqld.cnf
[mysqld]
server-id = 1
log-bin = mysql-bin
binlog_format = ROW
binlog-do-db = gms

# 性能优化
innodb_buffer_pool_size = 2G
max_connections = 800
```

```sql
-- 创建复制用户
CREATE USER 'replica'@'192.168.1.234' IDENTIFIED BY 'replica_pass_2024';
GRANT REPLICATION SLAVE ON *.* TO 'replica'@'192.168.1.234';
FLUSH PRIVILEGES;
SHOW MASTER STATUS; -- 记下 File 和 Position
```

### 从库配置（192.168.1.234）

```bash
# /etc/mysql/mysql.conf.d/mysqld.cnf
[mysqld]
server-id = 2
relay-log = mysql-relay-bin
read_only = ON
```

```sql
CHANGE MASTER TO
  MASTER_HOST = '192.168.1.233',
  MASTER_USER = 'replica',
  MASTER_PASSWORD = 'replica_pass_2024',
  MASTER_LOG_FILE = 'mysql-bin.000001',
  MASTER_LOG_POS = 0;

START SLAVE;
SHOW SLAVE STATUS\G  -- 确认 Slave_IO_Running = Yes, Slave_SQL_Running = Yes
```

## 2. Redis 配置

所有服务器连接同一个 Redis，用于 Session 共享和 Pub/Sub：

```bash
# 安装 Redis
sudo apt install redis-server

# 配置 /etc/redis/redis.conf
bind 0.0.0.0
protected-mode no
maxmemory 2gb
maxmemory-policy allkeys-lru
```

## 3. 服务器环境变量

### 主服务器（primary）

```bash
# .env 或 systemd service 文件
PORT=8765
SERVER_ROLE=primary
SERVER_ID=primary-233

# 主库（写）
DB_HOST=192.168.1.233
DB_PORT=3306
DB_USER=gms_user
DB_PASSWORD=your_password
DB_NAME=gms

# Redis
REDIS_URL=redis://192.168.1.233:6379
```

### 次服务器（secondary）

```bash
# .env 或 systemd service 文件
PORT=8765
SERVER_ROLE=secondary
SERVER_ID=secondary-234

# 主库（写）- 所有写操作必须走主库
DB_HOST=192.168.1.233
DB_PORT=3306
DB_USER=gms_user
DB_PASSWORD=your_password
DB_NAME=gms

# 从库（读）- 可选，减轻主库压力
DB_HOST_READ=192.168.1.234
DB_PORT_READ=3306
DB_USER_READ=gms_readonly
DB_PASSWORD_READ=readonly_password

# Redis（同一台）
REDIS_URL=redis://192.168.1.233:6379
```

## 4. Nginx 负载均衡

```nginx
# /etc/nginx/sites-available/yunwei
upstream yunwei_backend {
    least_conn;  # 最少连接算法
    
    server 192.168.1.233:8765 weight=3 max_fails=3 fail_timeout=30s;
    server 192.168.1.234:8765 weight=2 max_fails=3 fail_timeout=30s;
    
    keepalive 256;
}

server {
    listen 80;
    server_name yunwei.example.com;
    
    # API 代理
    location /api/ {
        proxy_pass http://yunwei_backend;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_next_upstream error timeout http_502 http_503;
        proxy_next_upstream_tries 3;
    }
    
    # SSE（需要 sticky session）
    location /api/events {
        proxy_pass http://yunwei_backend;
        proxy_http_version 1.1;
        proxy_buffering off;
        proxy_read_timeout 86400s;
        proxy_next_upstream off;
    }
    
    # WebSocket
    location /ws {
        proxy_pass http://yunwei_backend;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 86400s;
    }
    
    # 静态文件
    location / {
        proxy_pass http://yunwei_backend;
    }
}
```

## 5. 前端分布式配置

前端会自动检测服务器状态并切换。在浏览器控制台可查看：

```javascript
// 查看当前服务器
DistributedConfig.getCurrentServer()

// 查看所有服务器状态
DistributedConfig.getServerStatus()

// 手动添加次服务器（测试用）
DistributedConfig.addServer({
  name: '次服务器1',
  url: 'http://192.168.1.234:8765'
})

// 手动切换服务器
DistributedConfig.manualSwitch('secondary-1')
```

## 6. 故障转移流程

```
1. 主服务器故障（连续3次健康检查失败）
   ↓
2. 前端自动切换到次服务器（延迟 ~30秒）
   ↓
3. SSE/WebSocket 重连到次服务器
   ↓
4. 所有请求走次服务器
   ↓
5. 主服务器恢复（连续2次成功）
   ↓
6. 前端自动切回主服务器（优先级高）
```

## 7. 健康检查

前端每30秒检查所有服务器 `/api/status`：

```javascript
// 返回格式
{
  status: 'ok',
  onlineUsers: 50,
  loadLevel: 'smooth',
  serverRole: 'primary',  // 服务器角色
  serverId: 'primary-233', // 服务器ID
  dbConnected: true,       // 数据库状态
  readPoolConnected: true  // 从库状态
}
```

## 8. 数据一致性保证

- **写操作**：所有服务器都连接主库，写操作直接同步
- **读操作**：可走从库，MySQL 主从复制延迟通常 <1秒
- **Session**：Redis 共享，切换服务器后无需重新登录
- **实时推送**：Redis Pub/Sub 跨服务器广播

## 9. 部署步骤

### 步骤1：配置 MySQL 主从复制
参考 `mysql-replication.md`

### 步骤2：启动 Redis
```bash
sudo systemctl start redis-server
sudo systemctl enable redis-server
```

### 步骤3：部署主服务器
```bash
git clone https://github.com/your-repo/glove-management-system.git
cd glove-management-system
npm install

# 配置环境变量
cp .env.example .env
nano .env  # 设置 SERVER_ROLE=primary

# 启动
pm2 start ecosystem.config.js
```

### 步骤4：部署次服务器
```bash
# 同上，但 .env 设置
SERVER_ROLE=secondary
DB_HOST_READ=192.168.1.234  # 从库地址
```

### 步骤5：配置 Nginx
```bash
sudo ln -s /etc/nginx/sites-available/yunwei /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

### 步骤6：验证
- 打开浏览器访问 Nginx 地址
- 控制台查看 `[Distributed]` 日志
- 关闭主服务器，观察自动切换
- 恢复主服务器，观察自动切回

## 10. 常见问题

### Q: 切换后 Session 丢失？
A: 检查 Redis 是否正常运行，所有服务器 REDIS_URL 是否一致。

### Q: 数据不一致？
A: 检查 MySQL 主从复制状态 `SHOW SLAVE STATUS\G`，确认 `Slave_IO_Running` 和 `Slave_SQL_Running` 都是 Yes。

### Q: SSE 断开后不重连？
A: 检查 Nginx SSE 配置，确保 `proxy_next_upstream off`。

### Q: 所有服务器都挂了怎么办？
A: 前端进入降级模式，使用 localStorage 缓存。恢复后自动同步。