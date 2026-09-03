# GMS 运维系统集成指南

本文档说明如何将机器心跳监控系统集成到现有的 GMS 运维系统中。

## 目录

1. [系统架构](#系统架构)
2. [后端集成](#后端集成)
3. [数据库配置](#数据库配置)
4. [SN 注册表管理](#sn-注册表管理)
5. [前端集成](#前端集成)
6. [客户端部署](#客户端部署)
7. [测试验证](#测试验证)

---

## 系统架构

```
┌─────────────────────────────────────────────────────────────┐
│                    GMS 运维系统 (10.5.51.216)                │
│                                                               │
│  ┌─────────────┐  ┌──────────────┐  ┌──────────────────┐   │
│  │  Web 前端   │  │  后端 API    │  │  MySQL 数据库    │   │
│  │             │◄─┤              │◄─┤                  │   │
│  │  - 机器列表 │  │  - 心跳接收  │  │  - machines      │   │
│  │  - 状态监控 │  │  - 离线检测  │  │  - sn_registry   │   │
│  │  - SN 管理  │  │  - SN 验证   │  │  - tech_support  │   │
│  └─────────────┘  └──────────────┘  └──────────────────┘   │
│                           ▲                                  │
└───────────────────────────┼──────────────────────────────────┘
                            │ HTTP POST /api/machines/heartbeat
                            │
        ┌───────────────────┴───────────────────┐
        │                   │                   │
   ┌────▼─────┐       ┌────▼─────┐       ┌────▼─────┐
   │ we-105   │       │ we-106   │       │ we-107   │
   │          │       │          │       │          │
   │ Docker:  │       │ Docker:  │       │ Docker:  │
   │ heartbeat│       │ heartbeat│       │ heartbeat│
   │ -agent   │       │ -agent   │       │ -agent   │
   └──────────┘       └──────────┘       └──────────┘
```

---

## 后端集成

### 1. 导入所需模块

在你的 `server.js` 中添加：

```javascript
const MachineHeartbeatHandler = require('./backend-integration/machine-heartbeat');
const SNRegistryAPI = require('./backend-integration/sn-registry-api');

// 初始化
const heartbeatHandler = new MachineHeartbeatHandler(dbPool);
const snRegistryAPI = new SNRegistryAPI(dbPool);
```

### 2. 初始化数据库表

在服务器启动时：

```javascript
async function initDatabase() {
  // 初始化心跳处理器
  await heartbeatHandler.initDatabase();
  
  // 初始化 SN 注册表
  await snRegistryAPI.initDatabase();
  
  console.log('数据库初始化完成');
}

initDatabase().catch(err => {
  console.error('数据库初始化失败:', err);
  process.exit(1);
});
```

### 3. 注册路由

```javascript
// Express body parser
app.use(express.json());

// 心跳路由
heartbeatHandler.setupRoutes(app);

// SN 注册表路由
snRegistryAPI.setupRoutes(app);

// SSE 心跳流（可选，用于实时推送）
app.get('/api/machines/stream', (req, res) => {
  heartbeatHandler.addSSEClient(req, res);
});
```

### 4. 启动离线检测

```javascript
// 启动定时检测离线机器（每30秒检查一次）
heartbeatHandler.startOfflineChecker(30000);
```

---

## 数据库配置

### 连接配置

确保你的 MySQL 连接池配置正确：

```javascript
const mysql = require('mysql2/promise');

const dbPool = mysql.createPool({
  host: 'localhost',
  user: 'gms_user',
  password: 'your_password',
  database: 'gms_operations',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});
```

### 数据表结构

系统会自动创建两个表：

#### 1. `machines` - 机器状态表

```sql
CREATE TABLE machines (
  id INT AUTO_INCREMENT PRIMARY KEY,
  machineNumber VARCHAR(50) UNIQUE NOT NULL,
  hostname VARCHAR(255),
  ipAddress VARCHAR(50),
  deviceType VARCHAR(50) DEFAULT 'workstation',
  status VARCHAR(50) DEFAULT 'offline',
  lastHeartbeat TIMESTAMP NULL,
  data JSON,  -- 包含摄像头、手套等详细信息
  createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updatedAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);
```

`data` 字段 JSON 结构示例：

```json
{
  "platform": "linux",
  "uptime": 3600,
  "cameras": {
    "status": "normal",
    "count": 2,
    "dropping": 0,
    "details": [
      {
        "device": "/dev/video0",
        "camera": "Camera 1",
        "fps": 30,
        "isDropping": false
      }
    ]
  },
  "gloves": {
    "left": {
      "connected": true,
      "snCode": "WGJ001234",
      "validation": {
        "valid": true,
        "status": "bound_current",
        "message": "已正确绑定到当前机器 we-105"
      }
    },
    "right": {
      "connected": true,
      "snCode": "WGJ001235",
      "validation": {
        "valid": true,
        "status": "bound_current",
        "message": "已正确绑定到当前机器 we-105"
      }
    }
  }
}
```

#### 2. `sn_registry` - SN 注册表

```sql
CREATE TABLE sn_registry (
  id INT AUTO_INCREMENT PRIMARY KEY,
  snCode VARCHAR(50) UNIQUE NOT NULL,
  equipmentType VARCHAR(50) DEFAULT 'glove',
  status VARCHAR(50) DEFAULT 'available',
  machineNumber VARCHAR(50) DEFAULT NULL,
  handType VARCHAR(10) DEFAULT NULL,
  manufacturer VARCHAR(100),
  manufactureDate DATE,
  purchaseDate DATE,
  warrantyEndDate DATE,
  damageReason TEXT,
  repairStatus VARCHAR(50),
  trackingNumber VARCHAR(100),
  notes TEXT,
  createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updatedAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);
```

**状态说明**：
- `available`: 可用，未绑定
- `in_use`: 使用中，已绑定到某机器
- `damaged`: 已损坏
- `in_repair`: 维修中
- `shipped`: 已发货

---

## SN 注册表管理

### API 接口

#### 1. 查询单个 SN

```bash
GET /api/sn-registry/:snCode

# 示例
curl http://10.5.51.216:8765/api/sn-registry/WGJ001234
```

响应：
```json
{
  "id": 1,
  "snCode": "WGJ001234",
  "equipmentType": "glove",
  "status": "in_use",
  "machineNumber": "we-105",
  "handType": "left",
  "manufacturer": "某厂商",
  "createdAt": "2024-01-01T00:00:00.000Z",
  "updatedAt": "2024-01-15T10:30:00.000Z"
}
```

#### 2. 查询 SN 列表

```bash
GET /api/sn-registry?status=available&limit=50

# 查询所有可用的手套
curl "http://10.5.51.216:8765/api/sn-registry?status=available"

# 查询某机器绑定的手套
curl "http://10.5.51.216:8765/api/sn-registry?machineNumber=we-105"
```

#### 3. 注册新 SN

```bash
POST /api/sn-registry
Content-Type: application/json

{
  "snCode": "WGJ001234",
  "equipmentType": "glove",
  "manufacturer": "某厂商",
  "purchaseDate": "2024-01-01"
}
```

#### 4. 更新 SN 信息

```bash
PUT /api/sn-registry/:snCode
Content-Type: application/json

{
  "status": "in_use",
  "machineNumber": "we-105",
  "handType": "left"
}
```

#### 5. 绑定到机器

```bash
POST /api/sn-registry/:snCode/bind
Content-Type: application/json

{
  "machineNumber": "we-105",
  "handType": "left"
}
```

#### 6. 解绑

```bash
POST /api/sn-registry/:snCode/unbind
```

#### 7. 标记为损坏

```bash
POST /api/sn-registry/:snCode/damage
Content-Type: application/json

{
  "damageReason": "传感器失灵"
}
```

### 批量导入 SN

创建脚本 `import-sn.js`：

```javascript
const mysql = require('mysql2/promise');
const SNRegistryAPI = require('./backend-integration/sn-registry-api');

const dbPool = mysql.createPool({
  host: 'localhost',
  user: 'gms_user',
  password: 'your_password',
  database: 'gms_operations'
});

const snAPI = new SNRegistryAPI(dbPool);

const snList = [
  { snCode: 'WGJ001234', equipmentType: 'glove', manufacturer: 'A厂商' },
  { snCode: 'WGJ001235', equipmentType: 'glove', manufacturer: 'A厂商' },
  { snCode: 'WGK002001', equipmentType: 'glove', manufacturer: 'B厂商' },
  // ... 更多
];

(async () => {
  await snAPI.initDatabase();
  
  for (const sn of snList) {
    try {
      await snAPI.registerSN(sn);
      console.log(`✅ 导入成功: ${sn.snCode}`);
    } catch (err) {
      console.error(`❌ 导入失败: ${sn.snCode} - ${err.message}`);
    }
  }
  
  process.exit(0);
})();
```

---

## 前端集成

### 1. 机器列表显示 SN 信息

```javascript
// 获取机器列表
fetch('http://10.5.51.216:8765/api/machines')
  .then(res => res.json())
  .then(data => {
    data.machines.forEach(machine => {
      const gloves = machine.data?.gloves || {};
      
      console.log(`机器: ${machine.machineNumber}`);
      console.log(`左手: ${gloves.left?.snCode || '未检测'}`);
      console.log(`右手: ${gloves.right?.snCode || '未检测'}`);
      
      // 显示验证状态
      if (gloves.left?.validation) {
        const v = gloves.left.validation;
        console.log(`  状态: ${v.valid ? '✅' : '❌'} ${v.message}`);
      }
    });
  });
```

### 2. SN 验证状态展示

在机器详情页面显示：

```html
<div class="glove-info">
  <h3>手套信息</h3>
  
  <div class="glove-item">
    <span class="hand-label">左手:</span>
    <span class="sn-code">WGJ001234</span>
    <span class="status-badge valid">✅ 已绑定</span>
  </div>
  
  <div class="glove-item">
    <span class="hand-label">右手:</span>
    <span class="sn-code">WGJ001235</span>
    <span class="status-badge invalid">❌ 已绑定到其他机器 we-106</span>
  </div>
</div>
```

### 3. SN 管理界面

创建一个 SN 管理页面：

```html
<div class="sn-registry">
  <h2>SN 注册表管理</h2>
  
  <table>
    <thead>
      <tr>
        <th>SN 码</th>
        <th>设备类型</th>
        <th>状态</th>
        <th>绑定机器</th>
        <th>左/右手</th>
        <th>操作</th>
      </tr>
    </thead>
    <tbody id="sn-list">
      <!-- 动态填充 -->
    </tbody>
  </table>
  
  <button onclick="showAddSNDialog()">+ 添加 SN</button>
</div>

<script>
async function loadSNList() {
  const res = await fetch('http://10.5.51.216:8765/api/sn-registry?limit=100');
  const data = await res.json();
  
  const tbody = document.getElementById('sn-list');
  tbody.innerHTML = data.items.map(sn => `
    <tr>
      <td>${sn.snCode}</td>
      <td>${sn.equipmentType}</td>
      <td><span class="status-${sn.status}">${sn.status}</span></td>
      <td>${sn.machineNumber || '-'}</td>
      <td>${sn.handType || '-'}</td>
      <td>
        <button onclick="editSN('${sn.snCode}')">编辑</button>
        <button onclick="unbindSN('${sn.snCode}')">解绑</button>
      </td>
    </tr>
  `).join('');
}

loadSNList();
</script>
```

---

## 客户端部署

### 1. 在单台机器上部署

```bash
# SSH 到目标机器
ssh we-105

# 下载部署包
cd /tmp
git clone <your-repo-url> machine-heartbeat-agent
cd machine-heartbeat-agent

# 快速部署
./quick-deploy.sh
```

### 2. 批量部署到所有机器

创建 `batch-deploy.sh`：

```bash
#!/bin/bash

MACHINES=(
  "we-105"
  "we-106"
  "we-107"
  # ... 更多机器
)

for machine in "${MACHINES[@]}"; do
  echo "部署到 $machine..."
  
  ssh "$machine" "
    cd /tmp &&
    git clone <your-repo-url> machine-heartbeat-agent-temp &&
    cd machine-heartbeat-agent-temp &&
    ./quick-deploy.sh &&
    cd .. &&
    rm -rf machine-heartbeat-agent-temp
  "
  
  if [ $? -eq 0 ]; then
    echo "✅ $machine 部署成功"
  else
    echo "❌ $machine 部署失败"
  fi
done
```

### 3. 使用 Ansible 部署（推荐）

创建 `deploy-playbook.yml`：

```yaml
---
- name: Deploy Heartbeat Agent to all machines
  hosts: workstations
  become: yes
  
  tasks:
    - name: Copy deployment files
      copy:
        src: ./machine-heartbeat-agent
        dest: /opt/
    
    - name: Build Docker image
      command: docker-compose build
      args:
        chdir: /opt/machine-heartbeat-agent
    
    - name: Start container
      command: docker-compose up -d
      args:
        chdir: /opt/machine-heartbeat-agent
```

执行：

```bash
ansible-playbook -i inventory.ini deploy-playbook.yml
```

---

## 测试验证

### 1. 测试心跳发送

在客户端机器上：

```bash
# 查看容器日志
docker logs -f gms-heartbeat-agent

# 应该看到类似输出：
# [Heartbeat] ✅ we-105 - 心跳发送成功
```

### 2. 验证后端接收

在服务器上查询：

```bash
# 查看机器列表
curl http://10.5.51.216:8765/api/machines

# 查看特定机器
curl http://10.5.51.216:8765/api/machines/we-105
```

### 3. 测试 SN 验证

```bash
# 1. 注册测试 SN
curl -X POST http://10.5.51.216:8765/api/sn-registry \
  -H "Content-Type: application/json" \
  -d '{"snCode":"WGJ999999","equipmentType":"glove"}'

# 2. 在客户端机器上手动触发 SN 检测
docker exec -it gms-heartbeat-agent node sn-validator.js

# 3. 查看验证结果
# 应该在日志中看到验证状态
```

### 4. 测试摄像头监控

```bash
# 在客户端机器上
docker exec -it gms-heartbeat-agent node camera-monitor.js

# 应该输出检测到的摄像头列表和 FPS
```

### 5. 测试手套连接监控

```bash
# 在客户端机器上
docker exec -it gms-heartbeat-agent node glove-monitor.js

# 应该输出左右手套的连接状态
```

### 6. 测试离线检测

```bash
# 停止某台机器的容器
docker stop gms-heartbeat-agent

# 等待 60 秒后，在服务器查询
curl http://10.5.51.216:8765/api/machines/we-105

# 状态应该变为 offline
```

---

## 故障排查

### 问题1: 心跳发送失败

**症状**：客户端日志显示 `❌ 心跳发送失败`

**排查**：
```bash
# 检查网络连通性
ping 10.5.51.216

# 检查后端服务是否运行
curl http://10.5.51.216:8765/health

# 检查防火墙
sudo iptables -L | grep 8765
```

### 问题2: 无法检测机器编号

**症状**：启动失败，提示 `无法检测机器编号`

**解决**：
```bash
# 手动指定机器编号
docker run -e MACHINE_NUMBER=we-105 gms-heartbeat-agent
```

### 问题3: SN 验证失败

**症状**：日志显示 `SN 码不在数据库中`

**解决**：
```bash
# 先在后端注册该 SN
curl -X POST http://10.5.51.216:8765/api/sn-registry \
  -H "Content-Type: application/json" \
  -d '{"snCode":"WGJ001234","equipmentType":"glove"}'
```

### 问题4: 摄像头检测失败

**症状**：没有检测到摄像头

**排查**：
```bash
# Linux
ls -l /dev/video*

# Windows  
ffmpeg -list_devices true -f dshow -i dummy

# macOS
ffmpeg -f avfoundation -list_devices true -i ""
```

---

## 性能优化

### 1. 心跳间隔调整

根据机器数量调整：
- < 50 台：30秒
- 50-200 台：60秒
- > 200 台：120秒

### 2. 数据库索引

确保有这些索引：
```sql
ALTER TABLE machines ADD INDEX idx_status (status);
ALTER TABLE machines ADD INDEX idx_lastHeartbeat (lastHeartbeat);
ALTER TABLE sn_registry ADD INDEX idx_snCode (snCode);
ALTER TABLE sn_registry ADD INDEX idx_machineNumber (machineNumber);
```

### 3. 日志清理

定期清理旧的心跳记录：
```sql
DELETE FROM machines WHERE status = 'offline' AND updatedAt < DATE_SUB(NOW(), INTERVAL 30 DAY);
```

---

## 安全建议

1. **使用 HTTPS**：生产环境应使用 HTTPS
2. **API 认证**：添加 API Key 或 JWT 认证
3. **限流**：防止恶意请求
4. **日志审计**：记录所有 SN 操作

---

## 联系支持

如有问题，请联系运维团队。
