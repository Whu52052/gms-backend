# 📘 Yunwei 手套管理系统 — 完整 API 文档 v4.0

> 基础 URL: `http://服务器IP`  
> 认证方式: `Authorization: Bearer <token>`  
> Content-Type: `application/json`

---

## 目录

1. [认证接口](#1-认证接口)
2. [用户管理](#2-用户管理)
3. [库存管理](#3-库存管理)
4. [机器管理](#4-机器管理)
5. [流水记录](#5-流水记录)
6. [SN码注册表](#6-sn码注册表)
7. [技术支持(维修日志)](#7-技术支持维修日志)
8. [运营系统](#8-运营系统)
9. [配置管理](#9-配置管理)
10. [实时推送 (SSE/WebSocket)](#10-实时推送-ssewebsocket)
11. [导出与备份](#11-导出与备份)
12. [监控指标](#12-监控指标)

---

## 1. 认证接口

### POST `/api/auth/login` — 用户登录

**请求体:**
```json
{
  "username": "Yunwei",
  "password": "yunwei1025"
}
```

**成功响应 (200):**
```json
{
  "token": "a1b2c3...",
  "user": {
    "id": "sa-001",
    "username": "Yunwei",
    "displayName": "运维超管",
    "role": "superadmin",
    "system": "maintenance"
  }
}
```

**错误响应 (401):**
```json
{
  "error": "用户名或密码错误"
}
```

**限流:** 每IP 10次/分钟  
**爆破防护:** 10秒内5次失败 → IP封禁5分钟

---

### POST `/api/change-password` — 修改自己密码

```json
{
  "oldPassword": "yunwei1025",
  "newPassword": "newPass123"
}
```

### POST `/api/logout` — 退出登录

---

### POST `/api/auth/verify` — 验证 Token (内部接口)

```json
{ "token": "a1b2c3..." }
```
→ `{ "valid": true, "user": {...} }`

---

## 2. 用户管理

> 权限: admin / superadmin

### GET `/api/users` — 获取用户列表

系统隔离: 运营只能看运营用户, 运维只能看运维用户  
管理员: 只能看自己的组员  
超管: 看本系统全部用户

```json
[
  {
    "id": "sa-001",
    "username": "Yunwei",
    "displayName": "运维超管",
    "role": "superadmin",
    "system": "maintenance",
    "parentId": null,
    "createdAt": "2026-01-01T00:00:00.000Z",
    "online": true
  }
]
```

**查询参数:**
- `?status=online` — 筛选在线用户
- `?status=offline` — 筛选离线用户

### POST `/api/users` — 创建用户

```json
{
  "username": "zhangsan",
  "displayName": "张三",
  "password": "pass1234",
  "role": "user",
  "system": "operations"
}
```

权限规则:
- 管理员: 只能创建 `role=user` 的用户
- 超管: 可创建 `role=user` 或 `role=admin`
- 不可创建 `role=superadmin`

### PUT `/api/users/:id` — 修改用户

```json
{
  "username": "newname",
  "password": "newpass"
}
```
密码字段可选, 不填则不改密码

### DELETE `/api/users/:id` — 删除用户

限制: 不可删除自己 / 不可删除超管 / 管理员不可删除其他管理员

### POST `/api/users/:id/reset-password` — 重置用户密码

```json
{ "newPassword": "reset1234" }
```

管理员只能重置自己组员的密码  
超管可重置本系统内管理员和用户密码

### POST `/api/users/:id/promote` — 晋升/降级用户

超管专用: 普通用户 ↔ 管理员 互转

### GET `/api/subordinates` — 获取我的组员

管理员专用, 返回直接下属列表

---

## 3. 库存管理

### GET `/api/inventory` — 获取所有库存

```json
[
  { "type": "left_glove", "quantity": 150, "updatedAt": "...", "updatedBy": "admin" },
  { "type": "right_glove", "quantity": 148, "updatedAt": "...", "updatedBy": "admin" }
]
```

### GET `/api/inventory/:type` — 获取单个库存

### POST `/api/inventory/:type/adjust` — 调整库存

```json
{ "delta": -2 }
```
正数=入库, 负数=出库。库存不足返回 400

---

## 4. 机器管理

### GET `/api/machines` — 获取机器列表

缓存: 15秒 TTL  
去重: 按 machineNumber 自动去重, 返回最新记录

### POST `/api/machines` — 新增/更新机器

所有机器数据 (含上线/下线/维修历史)

### DELETE `/api/machines/:id` — 删除机器记录

权限: admin/superadmin  
自动归还关联的 SN 码库存

---

## 5. 流水记录

### GET `/api/transactions?limit=500` — 获取流水

### POST `/api/transactions` — 新增流水

### DELETE `/api/transactions/:id` — 删除流水

权限: admin/superadmin  
自动冲正库存

---

## 6. SN码注册表

### GET `/api/sn-registry` — 获取SN码列表

状态: `available` / `in_use` / `damaged` / `after_sales`

### POST `/api/sn-registry` — 录入/更新SN码

```json
{
  "snCode": "WG1KA01260321284",
  "equipmentType": "glove",
  "handType": "right",
  "status": "available"
}
```

### DELETE `/api/sn-registry/:snCode` — 删除SN码

权限: admin/superadmin  
自动加入墓碑 (防止流水复活)  
自动清理关联的附件/图片

---

## 7. 技术支持(维修日志)

### GET `/api/tech-support` — 获取维修日志列表

系统隔离: 运营用户只能看自己的请求  
管理员: 看自己+组员的请求  
超管: 看全部

### GET `/api/tech-support/:id` — 获取详情

### POST `/api/tech-support` — 提交技术支持

```json
{
  "equipmentType": "glove",
  "equipmentTypeName": "纯手套设备",
  "machineId": "M-001",
  "machineNumber": "M-001",
  "faultType": "闪退异常",
  "faultDescription": "设备运行30分钟后自动闪退"
}
```

限流: 每用户 5次/分钟  
副作用: 更新机器状态为 `waiting_repair` → 飞书同步

### POST `/api/tech-support/:id/respond` — 响应请求 (仅运维)

副作用: 
- 状态 `pending` → `responded`
- 记录响应人 + 响应时间
- 机器状态 → `repairing`
- 飞书同步

### POST `/api/tech-support/:id/complete` — 维修完成 (仅运维)

```json
{
  "result": "更换了损坏的传感器, 设备恢复正常"
}
```

⚠️ **必须先在 `responded` 状态, 否则拒绝**  
副作用:
- 状态 → `completed`  
- 记录完成时间 + 维修时长
- 机器状态 → `online`
- 飞书同步

### DELETE `/api/tech-support/:id` — 删除维修记录

权限: 运维系统 admin/superadmin 专属  
普通用户无权删除

---

## 8. 运营系统

### GET/POST `/api/ops-orders` — 订单管理
### GET/POST `/api/ops-customers` — 客户管理
### GET/POST `/api/ops-production` — 生产管理

---

## 9. 配置管理

### GET/POST `/api/equipment-config` — 设备类型配置
### GET/POST `/api/inventory-config` — 库存类型配置
### GET/POST `/api/settings` — 系统设置
### GET `/api/popup-messages?category=submit` — 弹窗句子
### POST/DELETE `/api/popup-messages` — 管理弹窗句子

---

## 10. 实时推送 (SSE/WebSocket)

### SSE: GET `/api/sse`

**Headers:**
```
Accept: text/event-stream
Cache-Control: no-cache
Authorization: Bearer <token>
```

**事件类型:**

| 事件 | 触发时机 |
|------|---------|
| `inventory_updated` | 库存变更 |
| `machines_updated` | 机器变更 |
| `transactions_updated` | 流水变更 |
| `tech_support_updated` | 维修日志变更 |
| `users_updated` | 用户变更 |
| `sn_registry_updated` | SN码变更 |

**心跳:** 每30秒 `: heartbeat`

### WebSocket: `ws://HOST/ws`

**消息格式:**
```json
// 发送
{ "type": "auth", "token": "xxx" }
{ "type": "join", "room": "system:maintenance" }
{ "type": "subscribe", "events": ["machines_updated", "inventory_updated"] }

// 接收
{ "type": "auth_ok", "user": {...} }
{ "type": "room_joined", "room": "system:maintenance", "memberCount": 25 }
```

---

## 11. 导出与备份

### GET `/api/export/xlsx` — 导出流水记录 Excel
### GET `/api/export/tech-support-xlsx` — 导出维修日志 Excel

**查询参数:**
- `?date=2026-06-15` — 指定日期
- `?startTime=07:00&endTime=02:00` — 时间段筛选
- 支持跨天筛选 (07:00→次日02:00)

### GET `/api/export/full` — 全量备份 ZIP
权限: admin/superadmin

### POST `/api/import/full` — 恢复备份
权限: admin/superadmin

---

## 12. 监控指标

### GET `/api/health` — 健康检查

```json
{
  "status": "ok",
  "uptime": 123456.789,
  "connections": { "active": 42, "total": 1560 },
  "memory": { "heapUsed": 156, "heapTotal": 512, "rss": 320 }
}
```

### GET `/api/status` — 服务器状态

```json
{
  "loadLevel": "smooth",
  "loadLabel": "畅通",
  "onlineUsers": 200,
  "totalUsers": 500
}
```

状态等级: `idle`(空闲) → `smooth`(畅通) → `busy`(拥挤) → `full`(爆满)

### GET `/api/metrics` — Prometheus 指标

开放给 Prometheus 采集, 包含:
- `http_requests_total` — HTTP 请求计数
- `http_request_duration_seconds` — 请求延迟直方图
- `sse_connections_active` — SSE 活跃连接
- `ws_connections_active` — WebSocket 活跃连接
- `online_users_total` — 在线用户数
- `mysql_pool_connections` — MySQL 连接池
- `feishu_queue_size` — 飞书同步队列积压
- `node_memory_usage_percent` — Node 内存使用率

---

## 附录: 通用错误码

| HTTP 状态码 | 含义 |
|-----------|------|
| 200 | 成功 |
| 400 | 请求参数错误 |
| 401 | 未登录 / Token 过期 |
| 403 | 无权限 |
| 404 | 资源不存在 |
| 413 | 请求体过大 |
| 429 | 请求过于频繁 |
| 500 | 服务器内部错误 |

---

> 📅 文档版本: v4.0 | 2026/06/15  
> 🖥️ 目标部署: i9 + 1TB SSD + RTX 5050 + Ubuntu
