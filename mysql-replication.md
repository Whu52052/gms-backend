# MySQL 主从复制 + 读写分离配置

## 架构

```
写操作 → 主库(192.168.1.233:3306) → binlog → 从库(192.168.1.234:3306)
读操作 → 从库(192.168.1.234:3306) 或 主库
Redis  → 192.168.1.233:6379 (Session/缓存共用)
```

## 1. 主库配置 (192.168.1.233)

```bash
# /etc/mysql/mysql.conf.d/mysqld.cnf
[mysqld]
server-id = 1
log-bin = mysql-bin
binlog_format = ROW
binlog_row_image = FULL
binlog_expire_logs_days = 7
max_binlog_size = 500M

# 要同步的数据库
binlog-do-db = gms

# 性能
innodb_buffer_pool_size = 2G
innodb_flush_log_at_trx_commit = 1
sync_binlog = 1
max_connections = 800

# 重启 MySQL
sudo systemctl restart mysql
```

## 2. 创建复制用户

```sql
-- 在主库执行
CREATE USER 'replica'@'192.168.1.234' IDENTIFIED BY 'replica_pass_2024';
GRANT REPLICATION SLAVE ON *.* TO 'replica'@'192.168.1.234';
FLUSH PRIVILEGES;

-- 查看主库状态 (记下 File 和 Position)
SHOW MASTER STATUS;
```

## 3. 从库配置 (192.168.1.234)

```bash
# /etc/mysql/mysql.conf.d/mysqld.cnf
[mysqld]
server-id = 2
relay-log = mysql-relay-bin
read_only = ON  # 从库只读
```

```sql
-- 在从库执行
CHANGE MASTER TO
  MASTER_HOST = '192.168.1.233',
  MASTER_USER = 'replica',
  MASTER_PASSWORD = 'replica_pass_2024',
  MASTER_LOG_FILE = 'mysql-bin.000001',  -- 改成 SHOW MASTER STATUS 的结果
  MASTER_LOG_POS = 0;                     -- 改成 SHOW MASTER STATUS 的结果

START SLAVE;
SHOW SLAVE STATUS\G  -- 确认 Slave_IO_Running 和 Slave_SQL_Running 都是 Yes
```

## 4. Server.js 读写分离配置

```javascript
// server.js 中新增读写分离池
const readPool = mysql.createPool({
  host: process.env.DB_HOST_READ || '192.168.1.234',  // 从库
  port: 3306,
  user: 'Wuzhenyu',
  password: 'Wh111852',
  database: 'gms',
  connectionLimit: 50,
});

const writePool = mysql.createPool({
  host: process.env.DB_HOST_WRITE || '192.168.1.233',  // 主库
  port: 3306,
  user: 'Wuzhenyu',
  password: 'Wh111852',
  database: 'gms',
  connectionLimit: 80,
});
```

## 5. 验证同步

```sql
-- 主库插入测试
INSERT INTO gms.settings (skey, value) VALUES ('repl_test', '"ok"');

-- 从库查询 (1-2秒内应出现)
SELECT * FROM gms.settings WHERE skey = 'repl_test';

-- 清理
DELETE FROM gms.settings WHERE skey = 'repl_test';
```
