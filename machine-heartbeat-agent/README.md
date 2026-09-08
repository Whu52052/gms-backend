# GMS Machine Heartbeat Agent

轻量级机器心跳监控代理，部署在每台主机上自动向 GMS 运维系统报告在线/离线状态。

## 功能特性

✅ **自动检测机器编号** - 从 hostname 或 IP 地址自动识别  
✅ **定期心跳上报** - 默认 30 秒发送一次心跳  
✅ **离线自动检测** - 主机关机/容器停止时自动标记离线  
✅ **轻量级部署** - Docker 容器，资源占用 < 64MB  
✅ **健康检查** - 内置健康检查接口  
✅ **优雅关闭** - 关机时主动通知后端离线  

## 快速部署

### 方式一：使用部署脚本（推荐）

```bash
# 1. 下载或复制所有文件到主机
cd machine-heartbeat-agent/

# 2. 自动检测机器编号并部署
sudo bash deploy.sh

# 3. 或者指定机器编号
sudo bash deploy.sh we-100
```

### 方式二：手动部署

```bash
# 1. 构建镜像
docker-compose build

# 2. 启动容器
docker-compose up -d

# 3. 查看日志
docker-compose logs -f
```

## 环境变量配置

| 变量名 | 说明 | 默认值 |
|--------|------|--------|
| `GMS_BACKEND_URL` | GMS后端地址 | `http://10.5.51.216:8765` |
| `MACHINE_NUMBER` | 机器编号（留空自动检测） | 自动检测 |
| `HEARTBEAT_INTERVAL` | 心跳间隔（秒） | `30` |
| `IMPORTER_API_URL` | Importer 只读 API 地址 | `http://127.0.0.1:5025` |
| `HERMES_API_URL` | RDC2 Hermes 只读 API 地址 | `http://127.0.0.1:5006` |
| `COLLECTOR_API_TIMEOUT` | 单个采集 API 请求超时（毫秒） | `3000` |
| `DEVICE_TYPE` | 设备类型 | `workstation` |

## 机器编号检测规则

代理会按以下优先级自动检测机器编号：

1. **环境变量** `MACHINE_NUMBER` - 最高优先级
2. **Hostname** - 匹配格式 `we-XXX` (如: we-100, we-059)
3. **IP 地址** - 匹配格式 `10.5.51.XXX` → `we-XXX`

### 示例

```bash
# Hostname: we-100 → 机器编号: we-100
# Hostname: we-59  → 机器编号: we-059 (自动补零)
# IP: 10.5.51.100  → 机器编号: we-100
# IP: 10.5.51.59   → 机器编号: we-059
```

## 管理命令

```bash
# 查看运行状态
docker-compose ps

# 查看实时日志
docker-compose logs -f

# 停止服务
docker-compose stop

# 启动服务
docker-compose start

# 重启服务
docker-compose restart

# 完全删除
docker-compose down

# 健康检查
curl http://localhost:3000/health

# 查看机器信息
curl http://localhost:3000/info
```

## 健康检查响应

```json
{
  "status": "ok",
  "machineNumber": "we-100",
  "hostname": "workstation-100",
  "uptime": 3600,
  "consecutiveFailures": 0
}
```

## 日志示例

```
==========================================
   GMS Machine Heartbeat Agent v1.0
==========================================
Backend URL: http://10.5.51.216:8765
Heartbeat Interval: 30s
Device Type: workstation
------------------------------------------
[Detect] 从IP地址检测到机器编号: we-100 (10.5.51.100)
✅ 机器编号: we-100
✅ 主机名: workstation-100
✅ IP地址: 10.5.51.100
------------------------------------------

[Health] 健康检查服务器启动: http://localhost:3000/health

[Heartbeat] 发送初始心跳...
[Heartbeat] ✅ we-100 - 心跳发送成功
[Heartbeat] 心跳循环已启动 (每 30 秒)
```

## 工作原理

```
┌─────────────────────────────────────────┐
│         主机 (10.5.51.100)              │
│  ┌───────────────────────────────────┐  │
│  │  Docker 容器 (心跳代理)           │  │
│  │  ├─ 自动检测: we-100             │  │
│  │  ├─ 每30秒发送心跳               │  │
│  │  └─ 健康检查: :3000/health       │  │
│  └───────────┬───────────────────────┘  │
│              │ HTTP POST                 │
│              │ /api/machines/heartbeat   │
└──────────────┼───────────────────────────┘
               │
               ▼
    ┌──────────────────────┐
    │  GMS Backend Server  │
    │    10.5.51.216       │
    │  ┌────────────────┐  │
    │  │ 收到心跳       │  │
    │  │ → 更新在线状态 │  │
    │  │ → 记录最后心跳 │  │
    │  └────────────────┘  │
    │                      │
    │  超时检测定时器:     │
    │  ├─ 60秒无心跳      │
    │  └─ 标记离线        │
    └──────────────────────┘
```

## 资源占用

- **CPU**: < 0.1 核心
- **内存**: < 64MB
- **网络**: 每30秒 ~1KB

## 故障排查

### 问题：无法检测机器编号

**解决方法**：手动指定环境变量

```bash
# 编辑 docker-compose.yml
environment:
  - MACHINE_NUMBER=we-100
```

### 问题：心跳发送失败

**检查项**：
1. 网络连接：`ping 10.5.51.216`
2. 后端服务：`curl http://10.5.51.216:8765/api/health`
3. 容器日志：`docker-compose logs`

### 问题：容器无法启动

```bash
# 查看详细错误
docker-compose logs

# 重新构建
docker-compose build --no-cache
docker-compose up -d
```

## 批量部署

在多台主机上快速部署：

```bash
#!/bin/bash
# batch-deploy.sh

HOSTS=(
  "10.5.51.100"
  "10.5.51.101"
  "10.5.51.102"
)

for host in "${HOSTS[@]}"; do
  echo "部署到 $host..."
  scp -r machine-heartbeat-agent/ we@$host:~/
  ssh we@$host "cd ~/machine-heartbeat-agent && sudo bash deploy.sh"
done
```

## 卸载

```bash
# 停止并删除容器
docker-compose down

# 删除镜像
docker rmi machine-heartbeat-agent_heartbeat-agent

# 删除文件
cd ..
rm -rf machine-heartbeat-agent/
```

## 更新日志

### v1.0.0 (2026-09-03)
- 初始版本
- 自动机器编号检测
- 心跳上报功能
- 健康检查接口
- 优雅关闭支持

## License

MIT
