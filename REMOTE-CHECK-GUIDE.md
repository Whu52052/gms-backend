# GMS 远程设备检测功能使用指南

本文档说明如何在机器管理界面中查看设备状态和触发远程检测。

---

## 🎯 功能概述

### 1. **实时状态查看**
- 点击机器卡片查看该机器的完整设备状态
- 包括：手套、Quest、摄像头、灵巧手、机械臂等
- 显示连接状态、电量、FPS 等详细信息

### 2. **远程设备检测**
- 点击"检测设备"按钮触发远程检测
- 客户端在10秒内响应并执行完整的设备扫描
- 检测结果自动刷新到界面

---

## 🏗️ 系统架构

```
┌─────────────────────────────────────────────────────────────┐
│                    前端界面 (浏览器)                         │
│                  machine-status.html                        │
│                                                             │
│  ┌──────────────┐  ┌──────────────┐  ┌─────────────────┐ │
│  │ 机器列表     │  │ 设备详情面板 │  │ 检测按钮        │ │
│  │ • we-105     │  │ • 手套状态   │  │ "检测设备"      │ │
│  │ • we-20      │  │ • Quest状态  │  │                 │ │
│  │ • ...        │  │ • 摄像头FPS  │  │                 │ │
│  └──────────────┘  └──────────────┘  └─────────────────┘ │
└────────────────────────┬────────────────────────────────────┘
                         │ HTTP REST API
                         │
┌────────────────────────▼────────────────────────────────────┐
│                  GMS 后端服务器                              │
│               (10.5.51.216:8765)                            │
│                                                             │
│  ┌───────────────────────────────────────────────────────┐ │
│  │          machine-status-api.js                        │ │
│  │                                                       │ │
│  │  API端点:                                             │ │
│  │  • GET  /api/machines              查询所有机器      │ │
│  │  • GET  /api/machines/:id          查询单台机器      │ │
│  │  • POST /api/machines/:id/check    触发设备检测      │ │
│  │  • GET  /api/check-requests/:id    查询检测结果      │ │
│  │  • GET  /api/poll-check/:machine   客户端轮询        │ │
│  │  • POST /api/check-requests/:id/result 提交结果      │ │
│  └───────────────────────────────────────────────────────┘ │
│                                                             │
│  ┌───────────────────────────────────────────────────────┐ │
│  │                MySQL 数据库                            │ │
│  │  • machine_heartbeats        (完整心跳数据)          │ │
│  │  • machine_status_summary    (状态摘要)              │ │
│  │  • device_check_requests     (检测请求队列)          │ │
│  └───────────────────────────────────────────────────────┘ │
└────────────────────────┬────────────────────────────────────┘
                         │ 轮询 (每10秒)
                         │
        ┌────────────────┼────────────────┐
        │                │                │
┌───────▼───────┐ ┌──────▼──────┐ ┌──────▼──────┐
│  we-105       │ │   we-20     │ │   we-XXX    │
│  (客户端)     │ │  (客户端)   │ │  (客户端)   │
│               │ │             │ │             │
│ heartbeat-    │ │ heartbeat-  │ │ heartbeat-  │
│ agent.js      │ │ agent.js    │ │ agent.js    │
│               │ │             │ │             │
│ device-check- │ │ device-     │ │ device-     │
│ poller.js     │ │ check-      │ │ check-      │
│               │ │ poller.js   │ │ poller.js   │
└───────────────┘ └─────────────┘ └─────────────┘
```

---

## 📡 工作流程

### 1. **查看机器状态**

```
用户 → 打开前端页面
     → 页面加载所有机器列表
     → 点击某台机器
     → 显示该机器的详细设备状态
```

**API 调用**：
```javascript
GET /api/machines           // 获取机器列表
GET /api/machines/we-105    // 获取 we-105 详细状态
```

**响应示例**：
```json
{
  "machineNumber": "we-105",
  "machineType": "dexterous",
  "status": "online",
  "healthScore": 85,
  "lastHeartbeat": "2026-09-03T13:45:30Z",
  "devices": {
    "machineType": "dexterous",
    "gloves": { "left": true, "right": true },
    "quest": { "connected": true, "battery": 85 },
    "dexterousHands": { "left": true, "right": false },
    "roboticArm": { "connected": true }
  },
  "cameras": [
    { "device": "/dev/video0", "name": "RealSense", "fps": 60, "status": "ok" }
  ],
  "gloves": {
    "left": {
      "connected": true,
      "snCode": "SN123456",
      "validation": { "valid": true, "status": "valid" }
    },
    "right": {
      "connected": true,
      "snCode": "SN123457",
      "validation": { "valid": true, "status": "valid" }
    }
  }
}
```

---

### 2. **触发远程设备检测**

```
用户 → 点击"检测设备"按钮
     → 前端向后端发送检测请求
     → 后端创建检测任务并存入数据库
     → 客户端轮询到检测请求
     → 客户端执行设备检测 (device-detector.js)
     → 客户端上报检测结果
     → 前端轮询并获取结果
     → 界面刷新显示最新状态
```

**详细流程**：

#### 第1步：前端触发检测
```javascript
POST /api/machines/we-105/check
```

**响应**：
```json
{
  "success": true,
  "requestId": 123,
  "message": "设备检测请求已创建，等待客户端执行"
}
```

#### 第2步：客户端轮询检测请求
客户端每10秒调用：
```javascript
GET /api/poll-check/we-105
```

**响应**：
```json
{
  "requestId": 123  // 有待处理的检测请求
}
```

#### 第3步：客户端执行检测
```javascript
// device-check-poller.js
const detectionResult = await deviceDetector.detectAll();
```

#### 第4步：客户端上报结果
```javascript
POST /api/check-requests/123/result
Body: { /* 完整的设备检测结果 */ }
```

#### 第5步：前端获取结果
前端每秒轮询：
```javascript
GET /api/check-requests/123
```

**响应**：
```json
{
  "id": 123,
  "machineNumber": "we-105",
  "status": "completed",
  "createdAt": "2026-09-03T13:45:00Z",
  "completedAt": "2026-09-03T13:45:08Z",
  "result": { /* 完整的设备状态 */ }
}
```

---

## 🔧 部署配置

### 1. **后端服务器**

**安装依赖**：
```bash
cd backend-integration
npm install express mysql2
```

**启动服务**：
```bash
node machine-status-api.js
```

**环境变量**：
```bash
export DB_HOST=localhost
export DB_PORT=3306
export DB_USER=gms
export DB_PASSWORD=gms123
export DB_NAME=gms
export PORT=8765
```

---

### 2. **客户端配置**

**更新 heartbeat-agent.js**，添加检测轮询器：

```javascript
const DeviceCheckPoller = require('./device-check-poller');

// 在 main() 函数中初始化
const checkPoller = new DeviceCheckPoller({
  backendUrl: CONFIG.backendUrl,
  machineNumber: machineInfo.machineNumber,
  deviceDetector: deviceDetector,
  pollInterval: 10000, // 10秒
});

// 启动轮询
checkPoller.start();
```

**完整的客户端流程**：
1. 每30秒发送心跳
2. 每10秒轮询检测请求
3. 收到检测请求后立即执行
4. 上报检测结果

---

### 3. **前端部署**

**方式1：直接打开 HTML**
```bash
# 在浏览器中打开
file:///path/to/frontend-demo/machine-status.html
```

**方式2：通过 HTTP 服务器**
```bash
cd frontend-demo
python3 -m http.server 8080
# 访问 http://localhost:8080/machine-status.html
```

**修改 API 地址**（如果需要）：
```javascript
// machine-status.html 第154行
const API_BASE = 'http://10.5.51.216:8765/api';
```

---

## 📊 数据库表结构

### 1. **machine_heartbeats** - 完整心跳数据
```sql
CREATE TABLE machine_heartbeats (
  id INT PRIMARY KEY AUTO_INCREMENT,
  machineNumber VARCHAR(50) NOT NULL,
  heartbeatData JSON NOT NULL,           -- 完整的心跳JSON
  receivedAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_machine (machineNumber),
  INDEX idx_time (receivedAt)
);
```

### 2. **machine_status_summary** - 状态摘要
```sql
CREATE TABLE machine_status_summary (
  machineNumber VARCHAR(50) PRIMARY KEY,
  machineType VARCHAR(50),               -- glove_only / dexterous
  status VARCHAR(50) DEFAULT 'online',   -- online / offline
  healthScore INT DEFAULT 100,           -- 健康度评分 0-100
  lastHeartbeat TIMESTAMP,
  devices JSON,                          -- 设备状态摘要
  cameras JSON,                          -- 摄像头状态
  gloves JSON,                           -- 手套状态
  updatedAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);
```

### 3. **device_check_requests** - 检测请求队列
```sql
CREATE TABLE device_check_requests (
  id INT PRIMARY KEY AUTO_INCREMENT,
  machineNumber VARCHAR(50) NOT NULL,
  status VARCHAR(50) DEFAULT 'pending',  -- pending / processing / completed
  createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  completedAt TIMESTAMP NULL,
  result JSON NULL,                      -- 检测结果
  INDEX idx_machine_status (machineNumber, status)
);
```

---

## 🧪 测试流程

### 1. **启动后端服务**
```bash
cd backend-integration
node machine-status-api.js
```

**预期输出**：
```
[Machine Status API] 数据库连接池已创建
[Machine Status API] 数据库表结构检查完成
[Machine Status API] 服务器运行在 http://localhost:8765

API 端点:
  POST   /api/heartbeat
  GET    /api/machines
  GET    /api/machines/:machineNumber
  ...
```

---

### 2. **启动客户端**
```bash
cd machine-heartbeat-agent
node heartbeat-agent.js
```

**预期输出**：
```
[Heartbeat] 机器编号: we-105
[Device] 初始化设备状态检测器...
[Device Check Poller] 启动轮询: 间隔 10000ms
[Heartbeat] ✅ 心跳发送成功
```

---

### 3. **打开前端界面**
浏览器访问：`http://localhost:8080/machine-status.html`

**预期效果**：
- 看到机器列表（we-105, we-20 等）
- 每个机器显示健康度评分
- 点击机器查看详细状态
- 点击"检测设备"按钮触发检测

---

### 4. **测试远程检测**

**操作步骤**：
1. 点击 we-105 机器卡片
2. 查看设备详情面板
3. 点击"检测设备"按钮
4. 观察状态变化：
   - "检测中..." → "等待客户端响应..." → "检测完成！"
5. 界面自动刷新显示最新状态

**后端日志**：
```
[Machine Status API] 已创建设备检测请求: we-105, ID: 1
```

**客户端日志**：
```
[Device Check Poller] 收到检测请求: 1
[Device Check Poller] 开始执行设备检测...
[Device Detector] ==========================================
[Device Detector] 开始检测设备状态
[Device Detector] ==========================================
...
[Device Check Poller] ✅ 检测结果已上报: 请求ID 1
```

---

## 🎨 前端界面功能

### 机器列表卡片
- **机器编号**：we-105, we-20 等
- **在线状态**：在线/离线（绿色/红色标签）
- **健康度评分**：0-100%（绿色/黄色/红色）
- **机器类型**：灵巧手机器/纯手套机器
- **最后心跳**：相对时间（刚刚、5分钟前等）

### 设备详情面板
- **手套状态**：
  - 左右手连接状态
  - SN 码
  - 验证状态
  
- **Quest 状态**：
  - 连接状态
  - 头显电量
  - 左右手柄电量
  
- **摄像头状态**：
  - 设备名称
  - 实时 FPS
  - 状态（正常/掉帧）
  
- **灵巧手 & 机械臂**（仅灵巧手机器）：
  - 左右手灵巧手状态
  - 机械臂连接状态

### 检测按钮
- **状态提示**：
  - 检测中...
  - 等待客户端响应...
  - 检测完成！
  - 检测失败

---

## 💡 使用建议

### 1. **定期检查**
- 每天早上检查所有机器状态
- 发现离线或异常立即处理

### 2. **主动检测**
- 设备更换后手动触发检测
- 故障排查时使用检测功能
- 验证修复结果

### 3. **健康度监控**
- 健康度 < 80% 需要关注
- 健康度 < 50% 需要立即处理
- 关注健康度趋势变化

### 4. **告警处理**
- 手套离线：检查网络和电源
- Quest 离线：检查 USB 连接和 ADB
- 摄像头掉帧：检查 USB 带宽
- 灵巧手离线：检查控制器和网络

---

## 🔍 故障排查

### 前端无法加载机器列表
**检查**：
1. 后端服务是否启动
2. API 地址是否正确
3. 浏览器控制台是否有错误
4. 网络连接是否正常

### 检测按钮无响应
**检查**：
1. 客户端是否在线
2. 客户端是否启动了检测轮询器
3. 数据库 `device_check_requests` 表是否创建成功
4. 客户端日志是否有错误

### 检测超时
**原因**：
- 客户端离线或未启动
- 客户端网络异常
- 检测轮询器未启动

**解决**：
1. 检查客户端进程状态
2. 检查客户端网络连接
3. 重启客户端服务

---

## 📈 性能优化

### 1. **心跳频率**
- 默认30秒合理
- 可根据需求调整（最低10秒）

### 2. **检测轮询**
- 默认10秒合理
- 过快会增加服务器负载

### 3. **历史数据清理**
定期清理旧的心跳数据：
```sql
-- 清理30天前的心跳数据
DELETE FROM machine_heartbeats 
WHERE receivedAt < DATE_SUB(NOW(), INTERVAL 30 DAY);

-- 清理已完成的检测请求（7天前）
DELETE FROM device_check_requests 
WHERE status = 'completed' 
  AND completedAt < DATE_SUB(NOW(), INTERVAL 7 DAY);
```

---

## ✅ 总结

通过这套系统，你可以：

1. ✅ **实时查看**所有机器的设备状态
2. ✅ **远程触发**设备检测，无需登录机器
3. ✅ **健康度评分**快速识别问题机器
4. ✅ **历史记录**追溯设备状态变化
5. ✅ **自动告警**设备异常立即通知

系统已准备就绪，可以投入使用！🎉
