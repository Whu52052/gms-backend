# GMS Backend 心跳功能集成指南

## 文件清单

```
backend-integration/
├── machine-heartbeat.js      # 心跳处理器（完整实现）
├── integration-guide.js      # 集成代码示例
└── INTEGRATION.md            # 本文档
```

## 集成步骤

### 步骤 1: 上传心跳处理器

将 `machine-heartbeat.js` 上传到服务器：

```bash
# 在服务器上执行
cd /home/we/gms-backend/src/handlers/
# 然后上传 machine-heartbeat.js 到这个目录
```

或使用 scp：

```bash
scp machine-heartbeat.js we@10.5.51.216:/home/we/gms-backend/src/handlers/
```

### 步骤 2: 修改 server.js

#### 2.1 导入模块（在文件顶部）

找到其他 handler 的导入语句，添加：

```javascript
const createMachineHeartbeatHandlers = require('./src/handlers/machine-heartbeat');
```

应该在这个位置附近：

```javascript
const createMachinesHandlers = require('./src/handlers/machines');
const createSNRegistryHandlers = require('./src/handlers/sn-registry');
// 添加下面这行：
const createMachineHeartbeatHandlers = require('./src/handlers/machine-heartbeat');
```

#### 2.2 声明变量（在 handlers 声明区域）

找到 `let auth, users, transactions, ...` 这一行，添加 `machineHeartbeat`：

```javascript
let auth, users, transactions, inventory, machines, snRegistry, 
    techSupport, push, chat, sop, solutions, configuration, 
    replacement, storageLocations, stocktakes, warehousesDomain, 
    rbacRoles, batchesDomain, warehouseTransfers, machineHeartbeat; // 添加这个
```

#### 2.3 初始化处理器（在 startup() 函数内）

找到其他 handlers 初始化的地方，添加：

```javascript
// 在这些初始化代码之后：
machines = createMachinesHandlers({ ... });
snRegistry = createSNRegistryHandlers({ ... });

// 添加：
machineHeartbeat = createMachineHeartbeatHandlers({
  pool,
  sendJSON,
  broadcastSSE,
  saveMachine,
});

console.log('[Startup] Machine heartbeat handler initialized');
```

#### 2.4 添加路由（在路由分发部分）

找到 `/api/machines` 的路由处理，在附近添加心跳路由：

**方式A：如果使用 router 模式**

```javascript
// 公开路由（无需认证）
publicRouter.post('/api/machines/heartbeat', async (req, res) => {
  await machineHeartbeat.handleReceiveHeartbeat(req, res, req.body);
});

publicRouter.post('/api/machines/:machineNumber/offline', async (req, res) => {
  const machineNumber = req.params.machineNumber;
  await machineHeartbeat.handleMarkOffline(req, res, machineNumber);
});

// 需要认证的路由
authRouter.get('/api/machines/heartbeat-status', async (req, res, user) => {
  await machineHeartbeat.handleGetHeartbeatStatus(req, res);
});
```

**方式B：如果使用直接路由匹配**

在 `handleRequest` 函数中添加：

```javascript
async function handleRequest(req, res) {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  
  // ... 现有路由 ...
  
  // 心跳接收（公开，无需认证）
  if (req.method === 'POST' && pathname === '/api/machines/heartbeat') {
    const body = await parseBody(req);
    return await machineHeartbeat.handleReceiveHeartbeat(req, res, body);
  }
  
  // 手动标记离线（公开）
  if (req.method === 'POST' && pathname.match(/^\/api\/machines\/(.+)\/offline$/)) {
    const match = pathname.match(/^\/api\/machines\/(.+)\/offline$/);
    const machineNumber = match[1];
    return await machineHeartbeat.handleMarkOffline(req, res, machineNumber);
  }
  
  // 查询心跳状态（需要认证）
  if (req.method === 'GET' && pathname === '/api/machines/heartbeat-status') {
    const user = await authenticateRequest(req);
    if (!user) return send401(res);
    return await machineHeartbeat.handleGetHeartbeatStatus(req, res);
  }
  
  // ... 其他路由 ...
}
```

#### 2.5 添加优雅关闭支持

找到 `gracefulShutdown` 函数，添加清理逻辑：

```javascript
async function gracefulShutdown(signal) {
  console.log(`[Shutdown] Received ${signal}, shutting down gracefully...`);
  
  // 添加这段：
  if (machineHeartbeat) {
    machineHeartbeat.cleanup();
  }
  
  // ... 其他清理逻辑 ...
}
```

### 步骤 3: 重启服务

```bash
# 在服务器上
cd /home/we/gms-backend

# 方式1: PM2 重启（推荐）
pm2 reload ecosystem.config.js

# 方式2: 直接重启
npm run cluster
```

### 步骤 4: 测试接口

```bash
# 测试心跳接收
curl -X POST http://10.5.51.216:8765/api/machines/heartbeat \
  -H "Content-Type: application/json" \
  -d '{
    "machineNumber": "we-100",
    "hostname": "test-host",
    "ipAddress": "10.5.51.100",
    "deviceType": "workstation",
    "timestamp": "2026-09-03T12:00:00Z"
  }'

# 预期响应：
# {
#   "success": true,
#   "machineNumber": "we-100",
#   "status": "online",
#   "message": "心跳已接收"
# }

# 测试查询心跳状态（需要认证）
curl http://10.5.51.216:8765/api/machines/heartbeat-status \
  -H "Authorization: Bearer YOUR_TOKEN"
```

### 步骤 5: 查看日志验证

```bash
# 查看服务器日志
tail -f /home/we/gms-backend/server.log

# 应该看到类似的日志：
# [Startup] Machine heartbeat handler initialized
# [Heartbeat] 机器上线: we-100
# [Heartbeat] 检测到 1 台超时机器: ['we-100']
# [Heartbeat] 机器超时离线: we-100
```

## 功能说明

### 心跳机制

1. **接收心跳**: 
   - 端点: `POST /api/machines/heartbeat`
   - 频率: 客户端每30秒发送一次
   - 功能: 更新机器在线状态和系统信息

2. **超时检测**:
   - 定时器: 每30秒检查一次
   - 超时阈值: 60秒无心跳 → 标记离线
   - 自动广播: 状态变更实时推送到前端

3. **手动离线**:
   - 端点: `POST /api/machines/:number/offline`
   - 场景: 客户端优雅关闭时主动通知

4. **状态查询**:
   - 端点: `GET /api/machines/heartbeat-status`
   - 返回: 所有机器的心跳状态和统计信息

### 数据流

```
客户端 (每30秒)
  ↓ POST /api/machines/heartbeat
后端接收
  ↓ 更新内存缓存
  ↓ 保存到数据库 (machines表)
  ↓ 如果状态变更 → 广播 SSE
前端自动刷新

后端定时检查 (每30秒)
  ↓ 扫描心跳缓存
  ↓ 发现超时机器 (>60秒)
  ↓ 标记为离线
  ↓ 广播 SSE
前端显示离线
```

## 数据库变更

心跳功能会在 `machines` 表的 JSON data 中添加新字段：

```json
{
  "machineNumber": "we-100",
  "status": "online",
  "lastHeartbeat": "2026-09-03T12:00:00Z",
  "hostname": "workstation-100",
  "ipAddress": "10.5.51.100",
  "systemInfo": {
    "platform": "linux",
    "arch": "x64",
    "cpus": 8,
    "totalMemory": 16777216000,
    "freeMemory": 8388608000,
    "uptime": 3600
  }
}
```

无需创建新表，完全兼容现有数据结构。

## 前端集成（可选）

如果需要在前端显示心跳状态，可以订阅 SSE 事件：

```javascript
// 监听机器上线事件
eventSource.addEventListener('machine:online', (e) => {
  const { machineNumber } = JSON.parse(e.data);
  console.log(`机器上线: ${machineNumber}`);
  // 刷新机器列表
});

// 监听机器离线事件
eventSource.addEventListener('machine:offline', (e) => {
  const { machineNumber, reason } = JSON.parse(e.data);
  console.log(`机器离线: ${machineNumber}, 原因: ${reason}`);
  // 刷新机器列表
});
```

## 故障排查

### 问题1: 路由404

**检查**:
- `server.js` 是否正确导入和初始化 `machineHeartbeat`
- 路由是否添加在正确的位置（公开路由区域）
- 服务是否重启

### 问题2: 心跳没有标记为在线

**检查**:
- 查看 `server.log` 是否有错误
- 检查 `saveMachine` 函数是否正常工作
- 数据库连接是否正常

### 问题3: 超时没有标记为离线

**检查**:
- 定时器是否正常启动（日志中应该有 "检测到 X 台超时机器"）
- `broadcastSSE` 函数是否正常
- 前端是否订阅了 SSE 事件

### 调试命令

```bash
# 查看最近的心跳日志
grep "Heartbeat" /home/we/gms-backend/server.log | tail -20

# 查看机器表最新记录
mysql -uroot -p gms -e "
  SELECT machineNumber, JSON_EXTRACT(data, '$.status') as status, 
         JSON_EXTRACT(data, '$.lastHeartbeat') as lastHeartbeat 
  FROM machines 
  ORDER BY updatedAt DESC 
  LIMIT 10;
"
```

## 完成！

集成完成后，你就可以：
1. 在各主机上部署心跳客户端
2. GMS 后端自动接收心跳
3. 前端实时显示机器在线/离线状态
4. 60秒无心跳自动标记离线

如有问题，请查看日志或联系开发团队。
