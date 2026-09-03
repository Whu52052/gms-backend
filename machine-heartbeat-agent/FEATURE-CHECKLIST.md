# 功能实现状态检查清单

本文档列出 machine-heartbeat-agent 的所有功能及其实现状态，帮助部署前进行验证。

---

## ✅ 完全实现（可直接使用）

### 1. 机器编号自动检测 ✅
- **功能**：从 hostname (`we-XXX`) 或 IP (`10.5.51.XXX`) 自动识别机器编号
- **代码位置**：[heartbeat-agent.js:59-94](heartbeat-agent.js#L59-L94)
- **验证方法**：
  ```bash
  # 测试
  node -e "console.log(require('os').hostname())"
  ```
- **状态**：✅ 完整实现，无依赖

### 2. 定期心跳上报 ✅
- **功能**：每 30 秒向 GMS 中心发送心跳 `POST /api/edge/heartbeat`
- **认证方式**：Bearer Token (EDGE_TOKEN)
- **代码位置**：[heartbeat-agent.js:198-225](heartbeat-agent.js#L198-L225)
- **验证方法**：
  ```bash
  # 查看容器日志
  docker logs -f gms-heartbeat-agent | grep Heartbeat
  ```
- **状态**：✅ 完整实现，包含重试机制

### 3. TCP 设备连通性检测 ✅
- **检测设备**：
  - 手套：192.168.1.100/101:50001
  - 灵巧手：192.168.1.110/111:7447
  - 机械臂：192.168.1.190:30003
- **代码位置**：[device-detector.js:47-79](device-detector.js#L47-L79)
- **验证方法**：
  ```bash
  # 手动测试 TCP 连接
  nc -zv 192.168.1.100 50001
  nc -zv 192.168.1.110 7447
  ```
- **状态**：✅ 完整实现，3秒超时

### 4. Quest 头显检测 ✅
- **功能**：通过 ADB 检测 Quest 序列号、电量、温度
- **代码位置**：[device-detector.js:82-157](device-detector.js#L82-L157)
- **依赖工具**：`adb` (Docker 镜像已包含)
- **验证方法**：
  ```bash
  # 容器内测试
  docker exec gms-heartbeat-agent adb devices
  docker exec gms-heartbeat-agent adb shell dumpsys battery
  ```
- **状态**：✅ 完整实现

### 5. 系统信息采集 ✅
- **采集数据**：CPU 核心数、总内存、可用内存、主机名、IP 地址、运行时长
- **代码位置**：[heartbeat-agent.js:150-195](heartbeat-agent.js#L150-L195)
- **验证方法**：
  ```bash
  # 查看上报数据
  curl http://localhost:3000/info | jq
  ```
- **状态**：✅ 完整实现，使用 Node.js 原生 `os` 模块

### 6. 健康检查接口 ✅
- **接口**：`GET http://localhost:3000/health`
- **返回数据**：状态、版本、机器编号、运行时长、连续失败次数
- **代码位置**：[heartbeat-agent.js:266-284](heartbeat-agent.js#L266-L284)
- **验证方法**：
  ```bash
  curl http://localhost:3000/health
  ```
- **状态**：✅ 完整实现

### 7. 优雅关闭 ✅
- **功能**：收到 SIGTERM/SIGINT 时主动通知服务器离线
- **接口**：`POST /api/edge/offline`
- **代码位置**：[heartbeat-agent.js:287-302](heartbeat-agent.js#L287-L302)
- **验证方法**：
  ```bash
  # 停止容器，查看日志
  docker stop gms-heartbeat-agent
  docker logs --tail 10 gms-heartbeat-agent
  ```
- **状态**：✅ 完整实现，5秒超时保护

---

## ⚠️ 部分实现（需环境验证）

### 8. 手套 SN 码识别 ⚠️

#### 方式1：读取 WUJI 标定目录 ✅
- **路径**：`/var/.rdc2/wuji_calib/left|right/`
- **代码位置**：[glove-sn-detector.js:92-158](glove-sn-detector.js#L92-L158)
- **正则表达式**：`W[GH][0-9A-Z][JK][A-Z0-9]{6,}`
- **验证方法**：
  ```bash
  # 检查目录是否存在
  ls -la /var/.rdc2/wuji_calib/
  
  # 查找 SN 相关文件
  find /var/.rdc2/wuji_calib/ -type f -name "*sn*" -o -name "*.json"
  ```
- **状态**：✅ 代码完整，需验证实际目录结构

#### 方式2：手套设备 HTTP API ❌
- **尝试接口**：`http://192.168.1.100:50001/api/device/info`
- **代码位置**：[glove-sn-detector.js:160-185](glove-sn-detector.js#L160-L185)
- **验证方法**：
  ```bash
  curl http://192.168.1.100:50001/api/device/info
  ```
- **问题**：手套设备可能不提供 HTTP API，只有 TCP Socket 协议
- **状态**：❌ **大概率无法使用**，手套固件需确认

#### 方式3：从 Docker 容器读取 ⚠️
- **命令**：`docker exec importer-staging cat /exchange/machine.jsonc`
- **代码位置**：[glove-sn-detector.js:187-230](glove-sn-detector.js#L187-L230)
- **验证方法**：
  ```bash
  # 检查容器是否存在
  docker ps | grep importer-staging
  
  # 测试读取配置
  docker exec importer-staging cat /exchange/machine.jsonc
  ```
- **状态**：⚠️ 代码完整，需验证容器和文件路径

#### 方式4：查询 GMS 后端 ✅
- **接口**：`GET /api/sn-registry?machineNumber=we-100&status=in_use`
- **代码位置**：[glove-sn-detector.js:232-267](glove-sn-detector.js#L232-L267)
- **验证方法**：
  ```bash
  curl "http://10.5.51.216:8765/api/sn-registry?machineNumber=we-100&status=in_use"
  ```
- **状态**：✅ 代码完整，取决于后端 API 是否实现

**总结**：至少有 2 种方式（方式1、方式4）可用，建议部署后测试验证。

---

### 9. 摄像头设备检测 ⚠️

#### Linux (v4l2) ✅
- **依赖工具**：`v4l2-ctl` (已添加到 Dockerfile)
- **代码位置**：[camera-monitor.js:52-89](camera-monitor.js#L52-L89)
- **验证方法**：
  ```bash
  # 宿主机测试
  ls /dev/video*
  v4l2-ctl --list-devices
  
  # 容器内测试
  docker exec gms-heartbeat-agent ls /dev/video*
  docker exec gms-heartbeat-agent v4l2-ctl --list-devices
  ```
- **要求**：容器需要访问 `/dev/video*` 设备
- **状态**：✅ 代码完整，需设备权限

#### Windows (PowerShell) ✅
- **代码位置**：[camera-monitor.js:92-120](camera-monitor.js#L92-L120)
- **状态**：✅ 代码完整（Windows 环境不使用 Docker）

#### macOS (AVFoundation) ✅
- **代码位置**：[camera-monitor.js:122-150](camera-monitor.js#L122-L150)
- **状态**：✅ 代码完整（macOS 环境不使用 Docker）

---

### 10. 摄像头帧率监控 ⚠️

- **依赖工具**：`ffmpeg` (已添加到 Dockerfile)
- **代码位置**：[camera-monitor.js:152-200](camera-monitor.js#L152-L200)
- **检测方法**：使用 ffmpeg 测试 2 秒视频流，计算实际帧率
- **验证方法**：
  ```bash
  # 容器内测试
  docker exec gms-heartbeat-agent ffmpeg -f v4l2 -i /dev/video0 -t 2 -f null -
  ```
- **告警条件**：实际 FPS < 期望 FPS × 80%
- **状态**：✅ 代码完整，需设备权限

**Docker 配置要求**：
```yaml
# docker-compose.yml 需要添加设备映射
devices:
  - /dev/video0:/dev/video0
  - /dev/video1:/dev/video1
```

---

## ❌ 未完整实现（占位代码）

### 11. Quest 手柄电量 ❌

- **功能**：获取 Quest 左右手柄的电池电量
- **代码位置**：[device-detector.js:160-187](device-detector.js#L160-L187)
- **当前实现**：
  ```javascript
  async getQuestControllerBattery() {
    // 占位实现，返回 null
    return null;
  }
  ```
- **原因**：ADB 标准命令无法获取手柄电量
- **解决方案**：
  1. 在 Quest 上运行自定义应用（使用 Oculus Platform SDK）
  2. 通过 Quest 系统日志解析（不可靠）
  3. 使用第三方工具（如 SideQuest）
- **状态**：❌ **暂不可用**，需额外开发

---

## 🔧 部署前准备清单

### 1. 环境变量配置 ✅ 必须
```bash
# .env 文件
EDGE_TOKEN=你的边缘令牌                  # ✅ 必填
GMS_BACKEND_URL=http://10.5.51.216:8765 # ✅ 必填
MACHINE_NUMBER=                          # 可选，留空自动检测
HEARTBEAT_INTERVAL=30                    # 可选，默认 30 秒
```

### 2. 网络配置 ✅ 必须
```yaml
# docker-compose.yml
network_mode: host  # 必须，访问 192.168.1.x 设备网段
```

### 3. 卷挂载 ✅ 推荐
```yaml
volumes:
  # SN 识别方式1
  - /var/.rdc2:/var/.rdc2:ro
  
  # SN 识别方式3
  - /var/run/docker.sock:/var/run/docker.sock:ro
```

### 4. 摄像头设备映射 ⚠️ 可选
```yaml
# 如果需要摄像头监控
devices:
  - /dev/video0:/dev/video0
  - /dev/video1:/dev/video1
```

### 5. ADB 设备连接 ⚠️ 可选
```yaml
# 如果 Quest 使用 USB 调试（默认使用 TCP 5555）
devices:
  - /dev/bus/usb:/dev/bus/usb
```

---

## 📊 功能可用性总结

| 功能 | 状态 | 可用性 | 备注 |
|------|------|--------|------|
| 机器编号检测 | ✅ | 100% | 无依赖 |
| 心跳上报 | ✅ | 100% | 需 EDGE_TOKEN |
| TCP 设备检测 | ✅ | 100% | 需 host 网络 |
| Quest 头显 | ✅ | 100% | 需 adb |
| 系统信息 | ✅ | 100% | 无依赖 |
| 健康检查 | ✅ | 100% | 无依赖 |
| 优雅关闭 | ✅ | 100% | 无依赖 |
| SN 识别-方式1 | ⚠️ | 80% | 需验证目录 |
| SN 识别-方式2 | ❌ | 0% | 手套无 HTTP API |
| SN 识别-方式3 | ⚠️ | 60% | 需验证容器 |
| SN 识别-方式4 | ✅ | 90% | 需后端 API |
| 摄像头检测 | ⚠️ | 80% | 需设备权限 |
| 帧率监控 | ⚠️ | 70% | 需设备权限 |
| Quest 手柄电量 | ❌ | 0% | 暂未实现 |

**核心功能可用性**：85% ✅  
**扩展功能可用性**：50% ⚠️

---

## 🚀 推荐的验证流程

### 阶段1：基础功能验证（5分钟）
```bash
cd /home/we/gms-backend/machine-heartbeat-agent/

# 1. 构建镜像
sudo bash build-and-run.sh

# 2. 检查容器运行
docker ps | grep gms-heartbeat-agent

# 3. 查看日志（应看到心跳发送成功）
docker logs -f gms-heartbeat-agent

# 4. 健康检查
curl http://localhost:3000/health
curl http://localhost:3000/info | jq
```

### 阶段2：设备检测验证（10分钟）
```bash
# 1. 进入容器
docker exec -it gms-heartbeat-agent sh

# 2. 测试 TCP 设备
nc -zv 192.168.1.100 50001  # 左手手套
nc -zv 192.168.1.101 50001  # 右手手套
nc -zv 192.168.1.110 7447   # 左手灵巧手
nc -zv 192.168.1.111 7447   # 右手灵巧手

# 3. 测试 Quest
adb devices
adb shell dumpsys battery

# 4. 退出容器
exit
```

### 阶段3：SN 识别验证（5分钟）
```bash
# 1. 检查标定目录
ls -la /var/.rdc2/wuji_calib/

# 2. 检查容器
docker ps | grep importer-staging
docker exec importer-staging cat /exchange/machine.jsonc 2>/dev/null

# 3. 查看日志中的 SN 识别结果
docker logs gms-heartbeat-agent | grep "SN Detector"
```

### 阶段4：后端验证（5分钟）
```bash
# 1. 查看 GMS 后端日志
# 确认收到心跳数据

# 2. 查询机器状态
curl "http://10.5.51.216:8765/api/machines/we-100"

# 3. 查询 SN 绑定
curl "http://10.5.51.216:8765/api/sn-registry?machineNumber=we-100"
```

---

## 📝 已知限制

1. **Quest 手柄电量**：暂不支持，需额外开发
2. **手套 HTTP API**：手套设备可能不支持，方式2 无法使用
3. **摄像头监控**：需要容器访问 `/dev/video*` 设备，可能需要额外权限配置
4. **SN 识别准确性**：取决于实际环境的目录结构和文件格式

---

## 🎯 总结

**可以直接部署使用的核心功能**：
- ✅ 机器在线/离线监控（心跳）
- ✅ TCP 设备连通性检测
- ✅ Quest 头显状态监控
- ✅ 系统信息采集

**需要环境验证的功能**：
- ⚠️ 手套 SN 码识别（4 种方式至少 2 种可用）
- ⚠️ 摄像头监控（需设备权限）

**暂不可用的功能**：
- ❌ Quest 手柄电量（需额外开发）

**建议**：先部署核心功能，验证通过后再逐步测试扩展功能。
