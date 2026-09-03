# GMS-Backend 运维系统全面学习文档

> **系统名称**: Glove Management System (手套/灵巧手/夹爪库存与机器管理系统)  
> **版本**: 4.0.0 企业版  
> **服务器**: we@10.5.51.216 (worldengine)  
> **并发能力**: 500用户  
> **技术栈**: Node.js + MySQL + Redis + WebSocket/SSE

---

## 📋 目录

1. [系统概述](#系统概述)
2. [技术架构](#技术架构)
3. [核心模块](#核心模块)
4. [数据库设计](#数据库设计)
5. [实时通信引擎](#实时通信引擎)
6. [安全机制](#安全机制)
7. [飞书集成](#飞书集成)
8. [部署架构](#部署架构)
9. [API接口](#api接口)
10. [运维操作](#运维操作)

---

## 系统概述

### 业务功能
GMS 是一个企业级库存与设备管理系统，主要管理：
- **手套/灵巧手/夹爪**库存（多仓库、多品类）
- **机器设备**状态与绑定关系
- **SN码**全生命周期跟踪
- **技术支持**工单流程
- **库存盘点**与批次管理
- **仓库间调拨**
- **用户权限**与角色管理

### 系统特点
- ✅ 500并发用户支持
- ✅ 微信级实时推送（<50ms延迟）
- ✅ 飞书多维表格自动同步
- ✅ 双通道实时通信（WebSocket + SSE）
- ✅ PM2集群模式（3实例负载均衡）
- ✅ Redis缓存 + Pub/Sub
- ✅ 企业级RBAC权限系统
- ✅ Docker完整容器化
- ✅ PWA移动端支持

---

## 技术架构

### 整体架构图
```
┌─────────────────────────────────────────────────┐
│               Nginx (反向代理)                   │
│            Port 8088 / 443 (HTTPS)              │
└────────────────┬────────────────────────────────┘
                 │
    ┌────────────┴────────────┐
    │   PM2 Cluster (3实例)    │
    │   Port 8765/8766/8767   │
    │   └─ server.js          │
    │      ├─ HTTP API        │
    │      ├─ WebSocket (/ws) │
    │      └─ SSE (/api/sse)  │
    └────┬────────────┬────────┘
         │            │
    ┌────┴──┐    ┌───┴────┐
    │ MySQL │    │ Redis  │
    │ :3306 │    │ :6379  │
    └───────┘    └────────┘
         │
    ┌────┴──────────┐
    │  飞书多维表格  │
    │  + 机器人通知  │
    └───────────────┘
```

### 技术栈详情

#### 后端核心
- **Runtime**: Node.js 18+ (支持ESM + Top-level await)
- **Web框架**: 纯HTTP模块（无Express/Koa依赖）
- **数据库**: MySQL 8.0 + mysql2驱动
- **缓存**: Redis 7 (session/cache/pubsub)
- **实时通信**: ws库 (WebSocket) + 原生SSE
- **进程管理**: PM2 (cluster mode)

#### 前端技术
- **框架**: 原生Web Components + TypeScript
- **构建**: Vite
- **PWA**: Service Worker + Manifest
- **移动端**: TWA (Trusted Web Activity) 打包APK

#### 数据库
- **主库**: MySQL (InnoDB引擎)
- **关键表**: 
  - `inventory` - 库存主表
  - `sn_registry` - SN码注册表
  - `machines` - 机器设备表
  - `tech_support` - 技术支持工单
  - `users` - 用户表
  - `roles` - 自定义角色
  - `warehouses` - 仓库表
  - `batches` - 批次台账

#### 依赖包
```json
{
  "dependencies": {
    "mysql2": "^3.22.5",      // MySQL驱动
    "redis": "^4.6.0",        // Redis客户端
    "ws": "^8.16.0",          // WebSocket服务器
    "qrcode": "^1.5.4",       // 二维码生成
    "xlsx": "^0.18.5",        // Excel导入导出
    "adm-zip": "^0.5.17",     // 压缩包处理
    "dotenv": "^17.4.2",      // 环境变量
    "web-push": "^3.6.7"      // Push通知
  }
}
```

---

## 核心模块

### 1. 认证与权限 (auth.js + rbac.js)

#### 认证流程
```javascript
// JWT Token认证
POST /api/login
Body: { username, password }
Response: { 
  token: "jwt_token",
  user: { id, username, role, customRole }
}

// Token验证
validateToken(token) → user payload
```

#### RBAC权限模型
```
权限 = 模块(module) × 动作(action) × 仓库范围(warehouseScope)

内置角色:
- superadmin: 全部权限
- admin: 业务管理权限（无角色管理）
- user: 只读 + 提交技术支持

自定义角色: 存储在 roles 表，JSON格式
```

**权限检查示例**:
```javascript
// lib/rbac.js
await rbac.can(user, 'inventory', 'adjust', { warehouseId })
// → true/false
```

**权限模块注册表**:
```javascript
PERMISSION_MODULES = {
  inventory: { label: '库存管理', actions: ['view', 'adjust', 'transfer'] },
  sn_registry: { label: 'SN管理', actions: ['view', 'manage'] },
  machines: { label: '机器管理', actions: ['view', 'manage'] },
  tech_support: { label: '技术支持', actions: ['submit', 'respond', 'manage'] },
  users: { label: '用户管理', actions: ['view', 'manage'] },
  roles: { label: '角色权限', actions: ['view', 'manage'] },
  // ...
}
```

### 2. 库存管理 (inventory.js)

#### 核心功能
- **多仓库库存**: 每个品类可在多个仓库有库存
- **双模式跟踪**: 
  - `quantity` 模式: 纯数量管理
  - `sn` 模式: 每件物品有唯一SN码
- **库存调整**: 入库/出库/调拨
- **批次管理**: FIFO (先进先出) 出库

#### 关键API
```javascript
GET  /api/inventory              // 全部库存（聚合视图）
GET  /api/inventory/:type        // 单品类库存
POST /api/inventory/:type        // 调整库存
POST /api/inventory/transfer     // 仓库间调拨
```

#### 库存调整流程
```javascript
// 入库 (delta > 0)
1. 检查仓库状态 (active)
2. 更新 inventory.quantity
3. 记录批次 (batches表)
4. 写入流水 (transactions表)
5. 广播SSE通知所有客户端

// 出库 (delta < 0)
1. 检查库存是否充足
2. FIFO扣减批次库存
3. 更新 inventory.quantity
4. 写入流水
5. 广播通知
```

### 3. SN注册表 (sn-registry.js)

#### SN生命周期
```
available → in_use → damaged/in_repair → available
    ↓          ↓           ↓
  (库存)    (机器上)    (维修中)
```

#### 核心字段
```javascript
{
  snCode: "WE-SZX3-001234",      // SN码
  invType: "glove_left",         // 品类类型
  handType: "left/right",        // 手套专用
  status: "available",           // 状态
  machineNumber: "we-059",       // 绑定机器
  warehouseId: "main",           // 所在仓库
  batchId: "B20260901-001",      // 所属批次
  expiryDate: "2027-12-31"       // 过期日期
}
```

#### 关键操作
```javascript
POST /api/sn-registry          // 批量注册SN
GET  /api/sn-registry          // 查询SN列表
POST /api/sn-registry/:sn/bind // 绑定到机器
POST /api/sn-registry/:sn/unbind // 解绑
```

### 4. 机器管理 (machines.js)

#### 机器状态
```javascript
status: {
  'online',          // 正常在线（左右手套都绑定）
  'offline',         // 离线（无手套绑定）
  'partial',         // 部分在线（只绑定一只）
  'waiting_repair',  // 等待维修
  'repairing'        // 维修中
}
```

#### 机器绑定逻辑
```javascript
// 一台机器绑定两只手套（左+右）
machineNumber: "we-059"
└─ left:  SN码1  (status: in_use)
└─ right: SN码2  (status: in_use)

// 状态自动推算
if (左 && 右) → online
if (左 || 右) → partial
if (!左 && !右) → offline
```

#### 关键API
```javascript
GET  /api/machines                    // 机器列表
POST /api/machines/:number/bind       // 绑定手套
POST /api/machines/:number/unbind     // 解绑手套
POST /api/machines/:number/sync-state // 同步状态
```

#### 机器状态同步 (最复杂事务)
```javascript
// handleSyncMachineState - 原子性保证
BEGIN TRANSACTION
  1. 行锁 SN 记录 (FOR UPDATE)
  2. 更新 SN 状态和机器绑定
  3. 重新计算库存 (_syncInventoryFromSN)
  4. 写入流水记录
  5. 插入机器状态记录
  6. 飞书同步
COMMIT
```

### 5. 技术支持 (tech-support.js)

#### 工单流程
```
submitted → responded → in_progress → completed
   ↓           ↓            ↓            ↓
 (提交)     (已响应)      (维修中)     (完成)
```

#### 自动化联动
```javascript
// 提交工单 → 机器状态自动变为 waiting_repair
// 开始维修 → 机器状态变为 repairing
// 完成维修 → 机器恢复 online/offline
// 全程飞书机器人推送通知
```

#### 关键API
```javascript
POST /api/tech-support           // 提交工单
POST /api/tech-support/:id/respond // 运维响应
POST /api/tech-support/:id/complete // 完成工单
GET  /api/tech-support           // 查询工单
```

### 6. 用户管理 (users.js)

#### 用户字段
```javascript
{
  username: "唯一登录名",
  passwordHash: "scrypt加密",
  displayName: "显示名称",
  role: "user/admin/superadmin",
  customRole: "自定义角色ID",
  warehouseAccess: ["main", "sz"],
  createdAt: "ISO时间"
}
```

#### 密码安全
- **算法**: scrypt (自动升级旧SHA-256)
- **盐值**: 随机生成
- **存储**: `scrypt$salt$hash` 格式

---

## 数据库设计

### 核心表结构

#### inventory (库存主表)
```sql
CREATE TABLE inventory (
  id INT PRIMARY KEY AUTO_INCREMENT,
  inv_type VARCHAR(50),           -- 品类类型
  warehouse_id VARCHAR(50),       -- 仓库ID
  quantity INT DEFAULT 0,         -- 数量
  updatedAt DATETIME,
  updatedBy VARCHAR(50),
  UNIQUE KEY (inv_type, warehouse_id)
);
```

#### sn_registry (SN注册表)
```sql
CREATE TABLE sn_registry (
  id INT PRIMARY KEY AUTO_INCREMENT,
  snCode VARCHAR(100) UNIQUE,
  invType VARCHAR(50),
  handType VARCHAR(10),
  status VARCHAR(20),             -- available/in_use/damaged/in_repair
  machineNumber VARCHAR(50),
  warehouseId VARCHAR(50),
  batchId VARCHAR(50),
  expiryDate DATE,
  createdAt DATETIME,
  updatedAt DATETIME,
  INDEX idx_status (status),
  INDEX idx_machine (machineNumber),
  INDEX idx_warehouse (warehouseId)
);
```

#### machines (机器表)
```sql
CREATE TABLE machines (
  id INT PRIMARY KEY AUTO_INCREMENT,
  machineNumber VARCHAR(50),
  deviceType VARCHAR(50),
  status VARCHAR(20),
  userId VARCHAR(50),
  data JSON,                      -- 完整机器信息
  updatedAt DATETIME,
  INDEX idx_machine_number (machineNumber),
  INDEX idx_user (userId)
);
```

#### tech_support (技术支持)
```sql
CREATE TABLE tech_support (
  id INT PRIMARY KEY AUTO_INCREMENT,
  machineNumber VARCHAR(50),
  issueType VARCHAR(50),
  description TEXT,
  status VARCHAR(20),
  submittedBy VARCHAR(50),
  respondedBy VARCHAR(50),
  feishuRecordId VARCHAR(100),    -- 飞书记录ID
  data JSON,
  createdAt DATETIME,
  updatedAt DATETIME
);
```

#### users (用户表)
```sql
CREATE TABLE users (
  id INT PRIMARY KEY AUTO_INCREMENT,
  username VARCHAR(50) UNIQUE,
  password_hash VARCHAR(255),
  display_name VARCHAR(100),
  role VARCHAR(20),
  custom_role VARCHAR(50),
  data JSON,
  createdAt DATETIME
);
```

#### warehouses (仓库表)
```sql
CREATE TABLE warehouses (
  id VARCHAR(50) PRIMARY KEY,
  name VARCHAR(100),
  status VARCHAR(20),             -- active/inactive
  address TEXT,
  createdAt DATETIME
);
```

#### batches (批次台账)
```sql
CREATE TABLE batches (
  id VARCHAR(50) PRIMARY KEY,
  inv_type VARCHAR(50),
  warehouse_id VARCHAR(50),
  initial_qty INT,
  remaining_qty INT,
  expiry_date DATE,
  created_at DATETIME,
  INDEX idx_type_warehouse (inv_type, warehouse_id),
  INDEX idx_expiry (expiry_date)
);
```

---

## 实时通信引擎

### Realtime Engine (realtime.js)

#### 设计目标
- 消息延迟 < 50ms (局域网)
- 500并发连接稳定
- 双通道传输: WebSocket + SSE
- 自动重连 + 离线消息队列
- 心跳保活 (15秒) + 断线检测 (45秒)

#### 双通道架构
```
WebSocket (/ws)   → 双向实时 (首选)
SSE (/api/sse)    → 单向推送 (降级兼容)
```

#### 事件类型
```javascript
{
  'data:changed':    '数据变更通知（立即刷新）',
  'tech:submit':     '新技术支持请求',
  'tech:respond':    '已响应',
  'tech:complete':   '维修完成',
  'user:online':     '用户上线',
  'user:offline':    '用户下线',
  'notify:info':     '系统通知',
  'heartbeat':       '心跳'
}
```

#### WebSocket认证流程
```javascript
// 1. 客户端连接
ws = new WebSocket('ws://10.5.51.216:8765/ws')

// 2. 服务器握手
← { type: 'connected', wsId: 'abc123' }

// 3a. Cookie认证（Web端 - 自动）
→ 升级请求携带 Cookie: gms_token=xxx
← { type: 'auth_ok', user: {...} }

// 3b. Token认证（移动端）
→ { type: 'auth', token: 'jwt_token' }
← { type: 'auth_ok', user: {...} }

// 4. 心跳保持
每15秒: → { type: 'heartbeat' }
        ← { type: 'pong' }
```

#### 广播机制
```javascript
// server.js 中的广播函数
broadcastSSE(event, data) {
  // 1. WebSocket 广播
  for (const ws of authenticatedWebSockets) {
    ws.send(JSON.stringify({ type: event, data }))
  }
  
  // 2. SSE 广播
  for (const res of sseClients) {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  }
  
  // 3. Redis Pub/Sub (跨PM2实例)
  redisClient.publish('yunwei:broadcast', JSON.stringify({ event, data }))
}
```

#### 离线消息队列
```javascript
// 用户离线时消息入队
offlineQueue.set(userId, [
  { event: 'tech:submit', data: {...}, ts: Date.now() },
  // ... 最多100条
])

// 用户重连后自动推送
for (const msg of offlineQueue.get(userId)) {
  ws.send(JSON.stringify(msg))
}
offlineQueue.delete(userId)
```

---

## 安全机制

### S1: 安全响应头
```javascript
// lib/security-headers.js
{
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'X-XSS-Protection': '1; mode=block',
  'Strict-Transport-Security': 'max-age=31536000', // HTTPS时
  'Content-Security-Policy': "default-src 'self'; ..."
}
```

### S2: 速率限制
```javascript
// lib/rate-limit.js
// Redis后端，内存降级
rateLimiter = createRateLimiter({
  redis: redisClient,
  windowMs: 60000,      // 1分钟窗口
  maxRequests: 100,     // 最多100次请求
  blockDuration: 300000 // 封禁5分钟
})
```

### S3: 输入验证
```javascript
// lib/validate.js
validate(req, {
  username: { type: 'string', minLength: 2, maxLength: 50 },
  password: { type: 'string', minLength: 6 },
  delta: { type: 'number', min: -10000, max: 10000 }
})
```

### S4: CSRF防护
```javascript
// lib/csrf.js
// 双重提交Cookie模式
POST 请求需携带:
  Cookie: csrf_token=xxx
  Header: X-CSRF-Token=xxx
```

### S5: XSS防护
- 所有用户输入转义
- CSP头限制内联脚本
- DOM操作使用textContent而非innerHTML

### S6: 密码安全
```javascript
// lib/password.js
// scrypt 加密（自动从SHA-256升级）
hashPassword(plaintext) → "scrypt$salt$hash"
verifyPassword(plaintext, hash) → boolean
```

---

## 飞书集成

### feishu.js 模块

#### 功能
1. **多维表格同步**: 技术支持工单自动同步到飞书Bitable
2. **群机器人通知**: 重要事件推送到运维通知群

#### 配置
```javascript
FEISHU_CONFIG = {
  appId: 'cli_aaa42355f0389cfc',
  appSecret: 'v2vU8YCrU0GHJdUsIa8nN1edaEGdkPm8',
  appToken: 'Lo7mb8Virax0k2smZticmh6JnAg',    // 多维表格
  tableId: 'tblJ65qGy7te8NC5',                // 表格ID
  groupWebhook: 'https://...'                  // 群机器人
}
```

#### Token管理
```javascript
// 自动缓存，2小时TTL
getAccessToken() → tenant_access_token
```

#### 同步流程
```javascript
// 提交工单
1. 数据库插入记录
2. 调用飞书API创建记录
3. 保存 feishuRecordId 到数据库
4. 发送群机器人通知

// 更新工单
1. 数据库更新
2. 调用飞书API更新记录（通过recordId）
3. 发送群机器人通知
```

#### API调用示例
```javascript
// 创建记录
createBitableRecord(fields) {
  POST /open-apis/bitable/v1/apps/{appToken}/tables/{tableId}/records
  Headers: { Authorization: `Bearer ${token}` }
  Body: { fields }
}

// 更新记录
updateBitableRecord(recordId, fields) {
  PUT /open-apis/bitable/v1/apps/{appToken}/tables/{tableId}/records/{recordId}
}

// 群机器人消息
sendGroupMessage(text) {
  POST {groupWebhook}
  Body: {
    msg_type: "text",
    content: { text }
  }
}
```

---

## 部署架构

### PM2 集群配置 (ecosystem.config.js)

```javascript
// 3个实例负载均衡
apps = [
  { name: 'yunwei-1', script: 'server.js', env: { PORT: 8765 } },
  { name: 'yunwei-2', script: 'server.js', env: { PORT: 8766 } },
  { name: 'yunwei-3', script: 'server.js', env: { PORT: 8767 } }
]

// 启动命令
pm2 start ecosystem.config.js
```

### Docker Compose 完整栈

```yaml
services:
  mysql:     # Port 3306
  redis:     # Port 6379
  app:       # Port 8765 (3实例)
  nginx:     # Port 8088/443
  prometheus:# Port 9090
  grafana:   # Port 3000
```

### 环境变量 (.env)
```bash
# 数据库
DB_HOST=127.0.0.1
DB_PORT=3306
DB_USER=root
DB_PASSWORD=强密码
DB_NAME=gms

# Redis
REDIS_HOST=127.0.0.1
REDIS_PORT=6379

# 服务器
PORT=8765
HTTPS_ENABLED=false

# 安全
ENCRYPTION_KEY=32字节随机hex
CSRF_SECRET=随机字符串

# 飞书
FEISHU_APP_ID=cli_xxx
FEISHU_APP_SECRET=密钥
FEISHU_APP_TOKEN=Lo7mb8Virax0k2smZticmh6JnAg
FEISHU_TABLE_ID=tblJ65qGy7te8NC5
```

### 启动流程
```bash
# 1. 安装依赖
npm install

# 2. 配置环境变量
cp .env.example .env
vim .env

# 3. 启动数据库
docker-compose up -d mysql redis

# 4. 初始化数据库
mysql -u root -p < mysql-init.sql

# 5. 启动应用（开发模式）
npm run dev

# 6. 启动应用（生产集群）
npm run cluster
```

---

## API接口

### 认证接口
```
POST   /api/login               登录
POST   /api/logout              登出
GET    /api/users/me            当前用户信息
```

### 库存接口
```
GET    /api/inventory           全部库存
GET    /api/inventory/:type     单品类库存
POST   /api/inventory/:type     调整库存
POST   /api/inventory/transfer  仓库调拨
GET    /api/inventory/transfer-stats  调拨统计
```

### SN管理接口
```
GET    /api/sn-registry         SN列表
POST   /api/sn-registry         批量注册SN
GET    /api/sn-registry/:sn     查询单个SN
POST   /api/sn-registry/:sn/bind    绑定到机器
POST   /api/sn-registry/:sn/unbind  解绑
```

### 机器管理接口
```
GET    /api/machines                    机器列表
POST   /api/machines                    添加机器
DELETE /api/machines/:id                删除机器
POST   /api/machines/:number/bind       绑定手套
POST   /api/machines/:number/unbind     解绑手套
POST   /api/machines/:number/sync-state 同步状态
GET    /api/machine-bindings            绑定关系
```

### 技术支持接口
```
GET    /api/tech-support           工单列表
POST   /api/tech-support           提交工单
POST   /api/tech-support/:id/respond   响应工单
POST   /api/tech-support/:id/complete  完成工单
GET    /api/tech-support/stats     统计数据
```

### 用户管理接口
```
GET    /api/users                  用户列表
POST   /api/users                  创建用户
PUT    /api/users/:id              更新用户
DELETE /api/users/:id              删除用户
POST   /api/users/:id/reset-password  重置密码
```

### 仓库管理接口
```
GET    /api/warehouses             仓库列表
POST   /api/warehouses             创建仓库
PUT    /api/warehouses/:id         更新仓库
POST   /api/warehouses/:id/deactivate  停用仓库
```

### 实时通信接口
```
WebSocket  /ws                     双向实时通信
GET        /api/sse                SSE推送
```

---

## 运维操作

### 日志查看
```bash
# 服务器日志
ssh we@10.5.51.216
tail -f /home/we/gms-backend/server.log

# PM2 日志
pm2 logs

# 特定实例日志
pm2 logs yunwei-1
```

### 系统状态
```bash
# 检查服务运行
netstat -tlnp | grep -E "(876[567]|3306|6379)"

# PM2 状态
pm2 status

# 系统资源
htop
free -h
df -h
```

### 数据库操作
```bash
# 连接数据库
mysql -uroot -p

# 查看库存
USE gms;
SELECT * FROM inventory;

# 查看SN注册
SELECT snCode, invType, status, machineNumber 
FROM sn_registry 
WHERE status = 'in_use' 
LIMIT 10;

# 查看最近工单
SELECT id, machineNumber, status, createdAt 
FROM tech_support 
ORDER BY createdAt DESC 
LIMIT 10;
```

### Redis操作
```bash
# 连接Redis
redis-cli

# 查看连接的客户端
CLIENT LIST

# 查看会话
KEYS gms:session:*

# 清除缓存
FLUSHDB
```

### 备份操作
```bash
# 数据库备份
mysqldump -uroot -p gms > /home/we/gms-backend/backups/gms_$(date +%Y%m%d).sql

# 恢复数据库
mysql -uroot -p gms < backup.sql
```

### 重启服务
```bash
# 重启PM2集群
pm2 restart ecosystem.config.js

# 优雅重启（零停机）
pm2 reload ecosystem.config.js

# 重启单个实例
pm2 restart yunwei-1
```

### 监控检查
```bash
# 健康检查端点
curl http://localhost:8765/api/health

# 实时连接数
curl http://localhost:8765/api/stats

# WebSocket测试
wscat -c ws://localhost:8765/ws
```

### 更新部署
```bash
# 拉取最新代码
cd /home/we/gms-backend
git pull

# 安装依赖
npm install

# 重新编译前端（如果有修改）
cd web
npm run build
cd ..

# 优雅重启
pm2 reload ecosystem.config.js
```

---

## 常见问题排查

### 1. 连接数过多
```bash
# 检查MySQL连接
SHOW PROCESSLIST;

# 检查Redis连接
redis-cli CLIENT LIST | wc -l
```

### 2. WebSocket断线
- 检查心跳间隔（15秒）
- 检查防火墙/反向代理超时设置
- 查看 `server.log` 中的连接日志

### 3. 飞书同步失败
- 检查 `FEISHU_APP_SECRET` 配置
- 查看 Token 是否过期
- 检查网络代理设置 `HTTPS_PROXY`

### 4. 库存不准确
```bash
# 手动触发库存重算
curl -X POST http://localhost:8765/api/sync-inventory \
  -H "Authorization: Bearer $TOKEN"
```

### 5. 性能问题
- 检查数据库慢查询日志
- 查看Redis内存使用
- 检查PM2实例负载均衡

---

## 总结

GMS-Backend 是一个功能完整、架构清晰的企业级运维系统，具备：

✅ **高性能**: 500并发 + 集群模式 + Redis缓存  
✅ **实时性**: 微信级推送延迟 + 双通道通信  
✅ **可靠性**: 事务一致性 + 离线消息队列 + 自动重连  
✅ **安全性**: 多层安全机制 + RBAC权限 + 输入验证  
✅ **可扩展**: 模块化设计 + 依赖注入 + Docker容器化  
✅ **易运维**: PM2管理 + 日志完善 + 健康检查  

系统已稳定运行，支持手套/机器全生命周期管理，实现了库存、设备、工单的数字化闭环。
