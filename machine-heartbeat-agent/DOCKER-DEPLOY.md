# Docker 镜像部署指南

## 快速部署（推荐）

### 方式一：一键构建并运行

```bash
cd /home/we/gms-backend/machine-heartbeat-agent/

# 创建 .env 文件（首次需要）
echo "EDGE_TOKEN=你的边缘令牌" > .env

# 一键部署
sudo bash build-and-run.sh
```

### 方式二：手动步骤

```bash
# 1. 构建镜像
docker build -t gms-heartbeat-agent:latest .

# 2. 创建 .env 文件
cat > .env << EOF
EDGE_TOKEN=你的边缘令牌
EOF

# 3. 启动容器
docker-compose up -d

# 4. 查看日志
docker logs -f gms-heartbeat-agent
```

---

## 镜像说明

### 基础信息

- **基础镜像**: `node:20-alpine`
- **镜像大小**: ~150MB
- **运行内存**: 48MB-256MB
- **CPU限制**: 0.05-0.25 核心

### 包含组件

- Node.js 20 运行时
- Android Tools (adb) - Quest 头显检测
- Docker CLI - 读取容器内配置文件
- 心跳客户端所有模块

---

## 环境变量配置

在 `.env` 文件或 `docker-compose.yml` 中配置：

```bash
# 必填项
EDGE_TOKEN=你的边缘接入令牌

# 可选项（有默认值）
GMS_BACKEND_URL=http://10.5.51.216:8765
MACHINE_NUMBER=                    # 留空自动检测
HEARTBEAT_INTERVAL=30              # 心跳间隔（秒）
```

---

## 卷挂载说明

### 必需挂载

```yaml
volumes:
  # 1. WUJI 标定目录（手套SN识别）
  - /var/.rdc2:/var/.rdc2:ro
  
  # 2. Docker Socket（读取其他容器配置）
  - /var/run/docker.sock:/var/run/docker.sock:ro
```

### 网络模式

```yaml
# 必须使用 host 网络
# 原因：需要直连设备网段 192.168.1.x（手套/灵巧手/机械臂）
network_mode: host
```

---

## 管理命令

### 日常操作

```bash
# 查看运行状态
docker ps | grep gms-heartbeat-agent

# 查看实时日志
docker logs -f gms-heartbeat-agent

# 查看最近50行日志
docker logs --tail 50 gms-heartbeat-agent

# 重启容器
docker restart gms-heartbeat-agent

# 停止容器
docker stop gms-heartbeat-agent

# 启动容器
docker start gms-heartbeat-agent
```

### 健康检查

```bash
# HTTP 健康检查
curl http://localhost:3000/health

# 响应示例
{
  "status": "ok",
  "machineNumber": "we-100",
  "hostname": "workstation-100",
  "uptime": 3600,
  "consecutiveFailures": 0
}

# 查看机器信息
curl http://localhost:3000/info
```

### 调试

```bash
# 进入容器
docker exec -it gms-heartbeat-agent sh

# 查看容器资源占用
docker stats gms-heartbeat-agent

# 查看容器详细信息
docker inspect gms-heartbeat-agent
```

---

## 更新部署

### 更新镜像

```bash
# 1. 停止容器
docker stop gms-heartbeat-agent

# 2. 删除旧容器和镜像
docker rm gms-heartbeat-agent
docker rmi gms-heartbeat-agent:latest

# 3. 重新构建
docker build -t gms-heartbeat-agent:latest .

# 4. 启动新容器
docker-compose up -d
```

### 快速更新（使用脚本）

```bash
# 自动完成以上步骤
sudo bash build-and-run.sh
```

---

## 批量部署

### 部署到多台主机

```bash
#!/bin/bash
# batch-docker-deploy.sh

HOSTS=(
  "10.5.51.100"
  "10.5.51.101"
  "10.5.51.102"
)

EDGE_TOKEN="你的边缘令牌"

for host in "${HOSTS[@]}"; do
  echo "=========================================="
  echo "部署到 $host..."
  echo "=========================================="
  
  # 1. 上传文件
  scp -r machine-heartbeat-agent/ we@$host:~/
  
  # 2. SSH 执行部署
  ssh we@$host << EOF
    cd ~/machine-heartbeat-agent
    echo "EDGE_TOKEN=$EDGE_TOKEN" > .env
    sudo bash build-and-run.sh
EOF
  
  echo "✅ $host 部署完成"
  echo ""
done

echo "=========================================="
echo "全部部署完成！"
echo "=========================================="
```

---

## 故障排查

### 问题1：容器无法启动

```bash
# 查看详细错误
docker logs gms-heartbeat-agent

# 检查端口占用
netstat -tunlp | grep 3000

# 重新构建（无缓存）
docker build --no-cache -t gms-heartbeat-agent:latest .
```

### 问题2：无法连接设备

```bash
# 检查网络模式（必须是 host）
docker inspect gms-heartbeat-agent | grep NetworkMode

# 手动测试设备连通性
docker exec -it gms-heartbeat-agent sh
nc -zv 192.168.1.100 50001  # 测试手套
```

### 问题3：心跳发送失败

```bash
# 检查后端连接
docker exec -it gms-heartbeat-agent sh
wget -O- http://10.5.51.216:8765/api/health

# 查看环境变量
docker exec gms-heartbeat-agent env | grep GMS
```

### 问题4：无法识别机器编号

```bash
# 手动指定机器编号
# 编辑 docker-compose.yml
environment:
  - MACHINE_NUMBER=we-100

# 重启容器
docker-compose restart
```

---

## 镜像导出与导入

### 导出镜像

```bash
# 导出为 tar 文件
docker save gms-heartbeat-agent:latest -o gms-heartbeat-agent.tar

# 压缩（可选）
gzip gms-heartbeat-agent.tar
```

### 导入镜像

```bash
# 在其他主机上导入
docker load -i gms-heartbeat-agent.tar

# 或从压缩包导入
gunzip -c gms-heartbeat-agent.tar.gz | docker load

# 启动容器
docker-compose up -d
```

---

## 性能优化

### 资源限制调整

编辑 `docker-compose.yml`：

```yaml
deploy:
  resources:
    limits:
      cpus: '0.5'      # 增加 CPU 限制
      memory: 512M     # 增加内存限制
    reservations:
      cpus: '0.1'      # 最小保留
      memory: 64M
```

### 日志轮转

```yaml
services:
  heartbeat-agent:
    logging:
      driver: "json-file"
      options:
        max-size: "10m"
        max-file: "3"
```

---

## 生产环境建议

1. **使用 .env 文件** - 不要在 docker-compose.yml 中硬编码敏感信息
2. **设置自动重启** - `restart: unless-stopped` 已配置
3. **启用健康检查** - 已内置，每30秒检查一次
4. **监控日志大小** - 配置日志轮转防止磁盘占满
5. **定期更新镜像** - 保持与主项目同步
6. **备份配置** - .env 和 docker-compose.yml

---

## 卸载

```bash
# 完全删除
docker stop gms-heartbeat-agent
docker rm gms-heartbeat-agent
docker rmi gms-heartbeat-agent:latest

# 删除文件
cd ..
rm -rf machine-heartbeat-agent/
```
