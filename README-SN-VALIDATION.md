# 手套 SN 码验证与匹配系统

完整的手套 SN 码自动检测、验证和数据库匹配功能。

## 🎯 功能概览

### ✅ 已实现功能

1. **SN 码自动检测**
   - 从多个数据源检测 SN 码
   - 支持手套和灵巧手设备
   - 智能设备类型识别

2. **数据库验证与匹配**
   - 与 GMS 数据库 sn_registry 表匹配
   - 验证 SN 状态（available/in_use/damaged/in_repair）
   - 检查机器绑定关系
   - 验证左右手类型匹配

3. **自动修复与告警**
   - 自动绑定可用的 SN
   - 检测异常情况并告警
   - 集成到心跳系统实时上报

4. **完整的 API 接口**
   - RESTful API 管理 SN 注册表
   - 支持查询、注册、绑定、解绑等操作

---

## 📁 文件结构

```
.
├── machine-heartbeat-agent/
│   ├── heartbeat-agent.js          # 心跳客户端（已集成 SN 验证）
│   ├── camera-monitor.js           # 摄像头监控
│   ├── glove-monitor.js            # 手套连接监控
│   ├── glove-sn-detector.js        # SN 码检测器
│   ├── sn-validator.js             # ⭐ SN 验证器（新增）
│   └── smart-device-detector.js    # 智能设备检测
│
├── backend-integration/
│   ├── machine-heartbeat.js        # 后端心跳处理器
│   └── sn-registry-api.js          # ⭐ SN 注册表 API（新增）
│
├── test-sn-validation.js           # ⭐ SN 验证功能演示脚本
├── INTEGRATION.md                  # ⭐ 集成指南（已更新）
├── DEVICE-IP-CONFIG.md             # 设备 IP 配置说明
├── Dockerfile
├── docker-compose.yml
├── deploy.sh
└── README.md                       # 本文件
```

---

## 🚀 快速开始

### 1. 后端集成

在你的 GMS 运维系统后端 `server.js` 中添加：

```javascript
const SNRegistryAPI = require('./backend-integration/sn-registry-api');

// 初始化
const snRegistryAPI = new SNRegistryAPI(dbPool);

// 初始化数据库表
await snRegistryAPI.initDatabase();

// 注册路由
snRegistryAPI.setupRoutes(app);
```

详细步骤见 [INTEGRATION.md](./INTEGRATION.md)

### 2. 批量导入现有 SN

```bash
# 准备 SN 列表
cat > sn-list.json <<EOF
[
  {"snCode": "WGJ001234", "equipmentType": "glove"},
  {"snCode": "WGJ001235", "equipmentType": "glove"},
  {"snCode": "WGK002001", "equipmentType": "glove"}
]
EOF

# 批量导入
node import-sn.js sn-list.json
```

### 3. 部署客户端

```bash
# 单台机器
./quick-deploy.sh

# 批量部署
./batch-deploy.sh
```

### 4. 测试验证

```bash
# 运行演示脚本
node test-sn-validation.js
```

---

## 🔍 SN 验证流程

### 检测阶段

1. **从本地文件检测**
   - `/var/.rdc2/wuji_calib/` 配置文件
   - `/exchange/machine.jsonc` 容器配置

2. **从 GMS 后端查询**
   - 查询已绑定到当前机器的 SN

3. **从设备 API 查询**（如果支持）
   - 直接查询手套设备的 SN 信息

### 验证阶段

对每个检测到的 SN 执行：

```
检测到 SN: WGJ001234
    ↓
查询数据库
    ↓
┌─────────────────────────────────────┐
│ SN 存在？                           │
├─────────────────────────────────────┤
│ 否 → ❌ not_found                   │
│      建议: 需要在系统中注册此 SN    │
│                                     │
│ 是 → 检查状态                       │
│   ├─ available                      │
│   │   → ✅ 可用，建议自动绑定       │
│   │                                 │
│   ├─ in_use                         │
│   │   ├─ 绑定到本机？               │
│   │   │   是 → ✅ bound_current     │
│   │   │   否 → ❌ bound_other       │
│   │   │                             │
│   │   └─ 左右手匹配？               │
│   │       是 → ✅                   │
│   │       否 → ❌ hand_mismatch     │
│   │                                 │
│   ├─ damaged                        │
│   │   → ❌ 已损坏，需要更换         │
│   │                                 │
│   └─ in_repair                      │
│       → ⚠️  维修中                  │
└─────────────────────────────────────┘
```

### 修复阶段

- **自动修复**：可用的 SN 自动绑定到当前机器
- **告警上报**：异常情况立即通过心跳上报
- **人工处理**：需要管理员权限的操作提示用户

---

## 📊 数据库结构

### sn_registry 表

| 字段 | 类型 | 说明 |
|------|------|------|
| id | INT | 主键 |
| snCode | VARCHAR(50) | SN 码，如 WGJ001234 |
| equipmentType | VARCHAR(50) | 设备类型：glove/dexterous_hand |
| status | VARCHAR(50) | 状态：available/in_use/damaged/in_repair/shipped |
| machineNumber | VARCHAR(50) | 绑定的机器编号 |
| handType | VARCHAR(10) | 左右手：left/right |
| manufacturer | VARCHAR(100) | 制造商 |
| manufactureDate | DATE | 生产日期 |
| purchaseDate | DATE | 采购日期 |
| warrantyEndDate | DATE | 保修结束日期 |
| damageReason | TEXT | 损坏原因 |
| repairStatus | VARCHAR(50) | 维修状态 |
| trackingNumber | VARCHAR(100) | 物流单号 |
| notes | TEXT | 备注 |
| createdAt | TIMESTAMP | 创建时间 |
| updatedAt | TIMESTAMP | 更新时间 |

### 状态说明

- `available`: 可用，未绑定到任何机器
- `in_use`: 使用中，已绑定到某台机器
- `damaged`: 已损坏，不可使用
- `in_repair`: 维修中
- `shipped`: 已发货（用于物流追踪）

---

## 🔌 API 接口

### 查询 SN

```bash
# 查询单个
GET /api/sn-registry/:snCode

# 查询列表（支持过滤）
GET /api/sn-registry?status=available&machineNumber=we-105&limit=50
```

### 注册 SN

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

### 更新 SN

```bash
PUT /api/sn-registry/:snCode
Content-Type: application/json

{
  "status": "in_use",
  "machineNumber": "we-105",
  "handType": "left"
}
```

### 绑定操作

```bash
# 绑定到机器
POST /api/sn-registry/:snCode/bind
{"machineNumber": "we-105", "handType": "left"}

# 解绑
POST /api/sn-registry/:snCode/unbind

# 标记为损坏
POST /api/sn-registry/:snCode/damage
{"damageReason": "传感器失灵"}
```

### 删除 SN

```bash
DELETE /api/sn-registry/:snCode
```

完整 API 文档见 [INTEGRATION.md](./INTEGRATION.md#api-接口)

---

## 📡 心跳数据格式

客户端发送的心跳数据包含完整的 SN 验证信息：

```json
{
  "machineNumber": "we-105",
  "timestamp": "2024-01-15T10:30:00Z",
  "gloves": {
    "left": {
      "connected": true,
      "snCode": "WGJ001234",
      "validation": {
        "valid": true,
        "status": "bound_current",
        "message": "已正确绑定到当前机器 we-105",
        "dbMachine": "we-105"
      }
    },
    "right": {
      "connected": true,
      "snCode": "WGJ001235",
      "validation": {
        "valid": false,
        "status": "bound_other",
        "message": "已绑定到其他机器 we-106",
        "dbMachine": "we-106"
      }
    }
  }
}
```

**后端可以根据 `validation.valid` 字段判断是否需要告警。**

---

## 🎬 使用场景

### 场景 1: 新手套首次使用

1. 检测到 SN: `WGJ001234`
2. 数据库状态: `available`（已注册但未绑定）
3. **自动操作**: 绑定到当前机器 `we-105`
4. 结果: ✅ `bound_current`

### 场景 2: 手套移到了其他机器

1. `we-105` 检测到 SN: `WGJ001234`
2. 数据库显示: 已绑定到 `we-106`
3. **告警**: ❌ `bound_other`
4. **建议**: 人工确认后解绑并重新绑定

### 场景 3: 左右手接反

1. 左手位置检测到: `WGJ001235`
2. 数据库记录: `WGJ001235` 是右手
3. **告警**: ❌ `hand_mismatch`
4. **建议**: 检查物理连接，交换左右手网线

### 场景 4: 使用了损坏的手套

1. 检测到 SN: `WGJ001234`
2. 数据库状态: `damaged`
3. **告警**: ❌ `已损坏，需要更换`
4. **操作**: 自动创建技术支持工单

### 场景 5: 未注册的 SN

1. 检测到 SN: `WGJ999999`
2. 数据库: 不存在
3. **告警**: ❌ `not_found`
4. **建议**: 在系统中注册此 SN

---

## ⚙️ 配置说明

### 客户端配置

环境变量：

```bash
GMS_BACKEND_URL=http://10.5.51.216:8765  # GMS 后端地址
MACHINE_NUMBER=we-105                    # 机器编号（可自动检测）
HEARTBEAT_INTERVAL=30                    # 心跳间隔（秒）
```

### 后端配置

数据库连接：

```javascript
const dbPool = mysql.createPool({
  host: 'localhost',
  user: 'gms_user',
  password: 'your_password',
  database: 'gms_operations',
  connectionLimit: 10
});
```

---

## 🧪 测试

### 运行完整测试

```bash
node test-sn-validation.js
```

这个脚本会演示：
- ✅ 正常的 SN 验证流程
- ❌ 各种异常场景的处理
- 📊 心跳数据格式示例
- 🔧 API 使用示例

### 单独测试 SN 验证器

```bash
# 在客户端机器上
cd machine-heartbeat-agent
node sn-validator.js
```

### 测试后端 API

```bash
# 查询 SN
curl http://10.5.51.216:8765/api/sn-registry/WGJ001234

# 注册 SN
curl -X POST http://10.5.51.216:8765/api/sn-registry \
  -H "Content-Type: application/json" \
  -d '{"snCode":"WGJ001234","equipmentType":"glove"}'

# 绑定 SN
curl -X POST http://10.5.51.216:8765/api/sn-registry/WGJ001234/bind \
  -H "Content-Type: application/json" \
  -d '{"machineNumber":"we-105","handType":"left"}'
```

---

## 📋 部署清单

- [ ] 1. 后端集成 SN 注册表 API
- [ ] 2. 初始化数据库表（自动）
- [ ] 3. 批量导入现有手套 SN
- [ ] 4. 更新客户端到各机器
- [ ] 5. 验证心跳数据包含 SN 信息
- [ ] 6. 前端添加 SN 管理界面
- [ ] 7. 配置告警规则

---

## 🔧 故障排查

### 问题：SN 验证失败

**症状**: 日志显示 `SN 码不在数据库中`

**解决**:
```bash
# 检查 SN 是否已注册
curl http://10.5.51.216:8765/api/sn-registry/WGJ001234

# 如果不存在，注册它
curl -X POST http://10.5.51.216:8765/api/sn-registry \
  -H "Content-Type: application/json" \
  -d '{"snCode":"WGJ001234","equipmentType":"glove"}'
```

### 问题：无法连接后端

**症状**: `Request timeout`

**排查**:
```bash
# 检查网络
ping 10.5.51.216

# 检查后端服务
curl http://10.5.51.216:8765/health

# 检查防火墙
sudo iptables -L | grep 8765
```

### 问题：左右手接反

**症状**: `hand_mismatch` 告警

**解决**: 交换左右手手套的网线连接
- 左手应连接: `192.168.1.100:50001`
- 右手应连接: `192.168.1.101:50001`

更多问题见 [INTEGRATION.md](./INTEGRATION.md#故障排查)

---

## 📚 相关文档

- [INTEGRATION.md](./INTEGRATION.md) - 完整集成指南
- [DEVICE-IP-CONFIG.md](./DEVICE-IP-CONFIG.md) - 设备 IP 配置
- [backend-integration/sn-registry-api.js](./backend-integration/sn-registry-api.js) - API 实现代码
- [machine-heartbeat-agent/sn-validator.js](./machine-heartbeat-agent/sn-validator.js) - 验证器代码

---

## 📞 支持

如有问题，请联系运维团队。

---

## 📝 更新日志

### v1.2 - 2024-01-15
- ✨ 新增: SN 码验证与数据库匹配功能
- ✨ 新增: SN 注册表 API
- ✨ 新增: 自动绑定和告警功能
- 📝 更新: 集成文档

### v1.1 - 2024-01-10
- ✨ 新增: 手套 SN 码自动检测
- ✨ 新增: 智能设备类型识别

### v1.0 - 2024-01-01
- 🎉 初始版本
- ✅ 机器心跳监控
- ✅ 摄像头掉帧检测
- ✅ 手套连接监控
