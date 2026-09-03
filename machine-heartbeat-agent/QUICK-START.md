# 🎯 GMS 运维系统 - 心跳监控部署指南

## 系统架构

```
┌──────────────────────────────────────────────────────────────┐
│              GMS 总服务器 (10.5.51.216)                      │
│  ┌────────────────────────────────────────────────────────┐ │
│  │ GMS Backend (Port 8765)                                │ │
│  │  ├─ 机器管理                                           │ │
│  │  ├─ 心跳接收接口 (/api/machines/heartbeat)            │ │
│  │  ├─ MySQL 数据库                                       │ │
│  │  └─ SSE 实时推送                                       │ │
│  └────────────────────────────────────────────────────────┘ │
│                          ▲                                   │
└──────────────────────────┼───────────────────────────────────┘
                           │ HTTP POST (每30秒)
        ┌──────────────────┼──────────────────┐
        │                  │                  │
        │                  │                  │
┌───────┴────────┐  ┌──────┴────────┐  ┌────┴──────────┐
│  we-105        │  │  we-100       │  │  we-101       │
│  ┌──────────┐  │  │  ┌──────────┐ │  │  ┌──────────┐ │
│  │ Docker   │  │  │  │ Docker   │ │  │  │ Docker   │ │
│  │ 心跳容器 │  │  │  │ 心跳容器 │ │  │  │ 心跳容器 │ │
│  │          │  │  │  │          │ │  │  │          │ │
│  │ • 心跳   │  │  │  │ • 心跳   │ │  │  │ • 心跳   │ │
│  │ • 摄像头 │  │  │  │ • 摄像头 │ │  │  │ • 摄像头 │ │
│  └──────────┘  │  │  └──────────┘ │  │  └──────────┘ │
└────────────────┘  └───────────────┘  └───────────────┘
```

---

## 📋 部署清单

### ✅ 已准备好的文件

```
machine-heartbeat-agent/
├── 客户端部署文件（部署到各台机器）
│   ├── heartbeat-agent.js          # 心跳客户端
│   ├── camera-monitor.js           # 摄像头监控
│   ├── package.json
│   ├── Dockerfile
│   ├── docker-compose.yml
│   ├── deploy.sh                   # 自动部署脚本
│   └── quick-deploy.sh             # 快速部署脚本（新）
│
└── backend-integration/（集成到总服务器）
    ├── machine-heartbeat.js        # 后端处理器
    ├── INTEGRATION.md              # 集成详细步骤
    ├── integration-guide.js        # 代码示例
    └── install-backend.sh          # 安装脚本（新）
```

---

## 🚀 完整部署流程

### 阶段一：总服务器集成（10.5.51.216）

#### 1. 上传后端文件

```bash
# 在你的电脑上执行
cd D:\HuaweiMoveData\Users\24492\Desktop\1\machine-heartbeat-agent

# 上传后端处理器
scp backend-integration/machine-heartbeat.js \
    we@10.5.51.216:/home/we/gms-backend/src/handlers/

# 上传安装脚本
scp backend-integration/install-backend.sh \
    we@10.5.51.216:/home/we/gms-backend/
```

#### 2. 在总服务器上修改代码

SSH 登录到总服务器：
```bash
ssh we@10.5.51.216
cd /home/we/gms-backend
```

**修改 server.js**（按照 INTEGRATION.md 文档）：

**a) 导入模块（约第 60 行）**
```javascript
const createMachineHeartbeatHandlers = require('./src/handlers/machine-heartbeat');
```

**b) 声明变量（约第 90 行）**
```javascript
let machineHeartbeat; // 添加到其他 handler 声明中
```

**c) 初始化处理器（startup 函数内）**
```javascript
machineHeartbeat = createMachineHeartbeatHandlers({
  pool,
  sendJSON,
  broadcastSSE,
  saveMachine,
});
console.log('[Startup] Machine heartbeat handler initialized');
```

**d) 添加路由（路由分发区域）**
```javascript
// 心跳接收（公开路由）
if (req.method === 'POST' && pathname === '/api/machines/heartbeat') {
  return await machineHeartbeat.handleReceiveHeartbeat(req, res, await parseBody(req));
}

// 手动标记离线
if (req.method === 'POST' && pathname.match(/^\/api\/machines\/(.+)\/offline$/)) {
  const match = pathname.match(/^\/api\/machines\/(.+)\/offline$/);
  return await machineHeartbeat.handleMarkOffline(req, res, match[1]);
}

// 查询心跳状态（需要认证）
if (req.method === 'GET' && pathname === '/api/machines/heartbeat-status') {
  const user = await authenticateRequest(req);
  if (!user) return send401(res);
  return await machineHeartbeat.handleGetHeartbeatStatus(req, res);
}
```

**e) 优雅关闭（gracefulShutdown 函数）**
```javascript
if (machineHeartbeat) {
  machineHeartbeat.cleanup();
}
```

#### 3. 重启总服务器

```bash
# 在 10.5.51.216 上执行
cd /home/we/gms-backend
pm2 reload ecosystem.config.js

# 查看日志
pm2 logs | grep Heartbeat
```

#### 4. 验证后端接口

```bash
# 测试心跳接收接口
curl -X POST http://10.5.51.216:8765/api/machines/heartbeat \
  -H "Content-Type: application/json" \
  -d '{
    "machineNumber": "we-test",
    "hostname": "test-host",
    "ipAddress": "10.5.51.999",
    "timestamp": "2026-09-03T12:00:00Z"
  }'

# 预期返回：
# {"success":true,"machineNumber":"we-test","status":"online","message":"心跳已接收"}
```

---

### 阶段二：客户端部署（各台机器）

#### 方式 1: 在 .105 上部署（示例）

```bash
# 1. 复制项目到 .105
scp -r machine-heartbeat-agent/ we@10.5.51.105:~/

# 2. SSH 登录
ssh we@10.5.51.105

# 3. 进入目录
cd ~/machine-heartbeat-agent

# 4. 执行快速部署
bash quick-deploy.sh we-105

# 5. 查看日志
docker-compose logs -f
```

**预期日志**：
```
==========================================
   GMS Machine Heartbeat Agent v1.0
==========================================
Backend URL: http://10.5.51.216:8765
Heartbeat Interval: 30s
------------------------------------------
✅ 机器编号: we-105
✅ 主机名: we-105.szx3.worldengine.ai
✅ IP地址: 10.5.51.105
------------------------------------------

[Camera] 开始监控摄像头...
[Camera] 检测到 6 个摄像头设备
  - Intel RealSense Depth Camera (/dev/video0)
  - Intel RealSense Depth Camera (/dev/video1)
  ...

[Heartbeat] 发送初始心跳...
[Heartbeat] ✅ we-105 - 心跳发送成功
[Heartbeat] 心跳循环已启动 (每 30 秒)

[Camera] ✅ Intel RealSense 正常: 30.0 fps
```

#### 方式 2: 批量部署到多台机器

创建批量部署脚本：

```bash
#!/bin/bash
# batch-deploy-all.sh

MACHINES=(
  "10.5.51.105:we-105"
  "10.5.51.100:we-100"
  "10.5.51.101:we-101"
  "10.5.51.102:we-102"
)

for entry in "${MACHINES[@]}"; do
  IP="${entry%:*}"
  MACHINE="${entry#*:}"
  
  echo "========================================"
  echo "部署到 $IP ($MACHINE)"
  echo "========================================"
  
  # 复制文件
  scp -r machine-heartbeat-agent/ we@$IP:~/
  
  # 远程部署
  ssh we@$IP "cd ~/machine-heartbeat-agent && bash quick-deploy.sh $MACHINE"
  
  echo "✅ $MACHINE 部署完成"
  echo ""
done
```

---

### 阶段三：验证和监控

#### 1. 在总服务器查看心跳状态

```bash
ssh we@10.5.51.216

# 查看日志
tail -f /home/we/gms-backend/server.log | grep Heartbeat

# 预期日志：
# [Heartbeat] 机器上线: we-105
# [Heartbeat] 机器上线: we-100
```

#### 2. 在数据库查询

```bash
mysql -uroot -p gms

# 查询心跳记录
SELECT 
  machineNumber,
  JSON_EXTRACT(data, '$.status') as status,
  JSON_EXTRACT(data, '$.lastHeartbeat') as lastHeartbeat,
  JSON_EXTRACT(data, '$.cameras.count') as camera_count
FROM machines
WHERE JSON_EXTRACT(data, '$.lastHeartbeat') IS NOT NULL
ORDER BY updatedAt DESC
LIMIT 10;
```

#### 3. 在客户端机器查看状态

```bash
# 在任意客户端机器上
docker-compose ps
docker-compose logs --tail=50

# 检查健康状态
curl http://localhost:3000/health
```

---

## 🎯 测试场景

### 测试 1: 机器上线检测

```bash
# 1. 在 .105 上启动容器
docker-compose up -d

# 2. 等待 30 秒

# 3. 在 .216 查看日志
# 应该看到: [Heartbeat] 机器上线: we-105
```

### 测试 2: 机器离线检测

```bash
# 1. 停止容器
docker-compose stop

# 2. 等待 60 秒

# 3. 在 .216 查看日志
# 应该看到: [Heartbeat] 机器超时离线: we-105
```

### 测试 3: 摄像头掉帧检测

```bash
# 1. 制造高负载（模拟掉帧）
stress --cpu 8 --timeout 60s

# 2. 查看客户端日志
# 应该看到: [Camera] ⚠️  摄像头掉帧: 18.5 fps

# 3. 在 .216 查看日志
# 应该看到: [Camera Alert] we-105 摄像头掉帧
```

---

## 📊 监控效果

部署完成后，在 GMS 前端（如果有）会看到：

```
机器管理页面
┌─────────────────────────────────────────────────────────┐
│ 机器编号  │ 状态  │ 摄像头状态      │ 最后心跳         │
├─────────────────────────────────────────────────────────┤
│ we-105   │ 在线  │ ✅ 6个正常      │ 15秒前          │
│ we-100   │ 在线  │ ✅ 2个正常      │ 28秒前          │
│ we-101   │ 离线  │ ❌ 无数据       │ 3分钟前         │
└─────────────────────────────────────────────────────────┘
```

---

## 🛠️ 管理命令

### 客户端管理

```bash
# 查看状态
docker-compose ps

# 查看日志
docker-compose logs -f

# 重启
docker-compose restart

# 停止
docker-compose stop

# 删除
docker-compose down
```

### 总服务器管理

```bash
# 查看心跳日志
tail -f /home/we/gms-backend/server.log | grep Heartbeat

# 重启服务
pm2 reload ecosystem.config.js

# 查看 PM2 状态
pm2 status
```

---

## ❓ 常见问题

### Q1: 客户端无法检测机器编号

**解决**：手动指定
```bash
bash quick-deploy.sh we-105
```

### Q2: 心跳发送失败

**检查**：
```bash
# 1. 网络连接
ping 10.5.51.216

# 2. 后端服务
curl http://10.5.51.216:8765/api/health

# 3. 容器日志
docker-compose logs
```

### Q3: 摄像头检测不到

**检查**：
```bash
# 查看摄像头设备
ls -l /dev/video*

# 检查权限
sudo usermod -a -G video we

# 重启容器
docker-compose restart
```

---

## 🎉 完成！

现在你已经有了完整的机器心跳和摄像头监控系统：

✅ **总服务器** (10.5.51.216) - 接收心跳和摄像头状态  
✅ **客户端** (各台机器) - 自动上报心跳和摄像头状态  
✅ **实时监控** - 30秒心跳 + 60秒超时检测  
✅ **摄像头监控** - 10秒检查 + 掉帧告警  

需要我帮你开始部署吗？
