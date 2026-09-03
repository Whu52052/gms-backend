# GMS 设备 IP 配置和检测说明

本文档说明系统中所有设备的 IP 配置和检测方式。

---

## 设备列表

### 1. 手套（Gloves）

| 设备 | IP 地址 | 端口 | 检测方式 |
|------|---------|------|----------|
| 左手手套 | 192.168.1.100 | 50001 | TCP 端口连接 |
| 右手手套 | 192.168.1.101 | 50001 | TCP 端口连接 |

**所有机器都有**：纯手套机器和灵巧手机器都配有手套。

---

### 2. 灵巧手（Dexterous Hands）

| 设备 | IP 地址 | 端口 | 检测方式 |
|------|---------|------|----------|
| 左手灵巧手 | 192.168.1.110 | 7447 | TCP 端口连接 |
| 右手灵巧手 | 192.168.1.111 | 7447 | TCP 端口连接 |

**仅灵巧手机器有**：如果检测到灵巧手，说明是灵巧手机器。

---

### 3. 机械臂（Robotic Arm）

| 设备 | IP 地址 | 端口 | 检测方式 |
|------|---------|------|----------|
| 机械臂 | 192.168.1.190 | 30003 | TCP 端口连接 |

**仅灵巧手机器有**：机械臂用于控制灵巧手运动。纯手套机器没有机械臂。

**端口说明**：30003 是常见的机械臂控制端口（如 UR 机器人）。实际端口可能需要根据具体品牌调整。

---

### 4. Quest 头显（Quest Headset）

| 设备 | 检测方式 | 说明 |
|------|---------|------|
| Quest 2/3 | ADB 连接 | 通过 USB 或 WiFi ADB 连接 |

**所有机器都有**：纯手套机器和灵巧手机器都配有 Quest 用于 VR 交互。

**检测信息**：
- 连接状态（connected/offline/unauthorized）
- 设备序列号
- 电池电量（%）
- 电池状态（charging/discharging/full）
- 温度（°C）

**前置要求**：
- 主机上已安装 ADB（Android Debug Bridge）
- Quest 已开启开发者模式并授权 USB 调试
- Quest 通过 USB 连接到主机，或通过 WiFi ADB 连接

---

### 5. Quest 手柄（Quest Controllers）

| 设备 | 检测方式 | 说明 |
|------|---------|------|
| 左手柄 | 通过 Quest 查询 | 需要 Quest 已连接 |
| 右手柄 | 通过 Quest 查询 | 需要 Quest 已连接 |

**所有机器都有**：Quest 手柄用于 VR 交互。

**检测信息**：
- 电池电量（%）
- 充电状态

**注意**：Quest 手柄电量查询可能需要特定的应用支持或 Oculus Platform SDK。目前实现为简化方案，实际部署时可能需要调整。

---

## 机器类型判断

系统根据检测到的设备自动判断机器类型：

### 纯手套机器（glove_only）

**设备配置**：
- ✅ 手套（左右）
- ❌ 灵巧手
- ❌ 机械臂
- ✅ Quest 头显
- ✅ Quest 手柄（左右）

**判断逻辑**：只检测到手套，没有灵巧手。

---

### 灵巧手机器（dexterous）

**设备配置**：
- ✅ 手套（左右）
- ✅ 灵巧手（左右）
- ✅ 机械臂
- ✅ Quest 头显
- ✅ Quest 手柄（左右）

**判断逻辑**：检测到灵巧手（任意一个），即判定为灵巧手机器。

---

## 设备检测流程

```
启动检测
    ↓
检测手套（左右）
    ↓
检测灵巧手（左右）
    ↓
判断机器类型
    ↓
如果是纯手套机器 → 完成
    ↓
如果是灵巧手机器 → 继续检测
    ↓
检测机械臂
    ↓
检测 Quest 头显
    ↓
检测 Quest 手柄
    ↓
完成
```

---

## 心跳数据格式

### 纯手套机器

```json
{
  "machineNumber": "we-105",
  "devices": {
    "machineType": "glove_only",
    "gloves": {
      "left": true,
      "right": true
    },
    "quest": {
      "connected": true,
      "battery": 85
    },
    "questControllers": {
      "left": 70,
      "right": 65
    }
  }
}
```

### 灵巧手机器

```json
{
  "machineNumber": "we-106",
  "devices": {
    "machineType": "dexterous",
    "gloves": {
      "left": true,
      "right": true
    },
    "quest": {
      "connected": true,
      "battery": 85
    },
    "questControllers": {
      "left": 70,
      "right": 65
    },
    "dexterousHands": {
      "left": true,
      "right": true
    },
    "roboticArm": {
      "connected": true
    }
  }
}
```

---

## 告警场景

系统会在以下情况自动告警并立即发送心跳：

### 所有机器

- ❌ 左手手套离线
- ❌ 右手手套离线
- ❌ Quest 头显离线
- ⚠️ Quest 电量低于 20%
- ⚠️ Quest 手柄电量低于 20%

### 灵巧手机器额外告警

- ❌ 左手灵巧手离线
- ❌ 右手灵巧手离线
- ❌ 机械臂离线

---

## 检测频率

| 检测项 | 频率 | 说明 |
|--------|------|------|
| 设备状态 | 5 分钟 | TCP 连接、ADB 状态、电量等 |
| SN 验证 | 1 小时 | 验证 SN 绑定关系 |
| 摄像头 FPS | 10 秒 | 检测掉帧 |
| 手套连接 | 10 秒 | TCP 连接检测 |
| 心跳发送 | 30 秒 | 上报所有状态 |

**异常时立即上报**：检测到任何异常会立即发送心跳，不等待定时周期。

---

## 故障排查

### 1. 手套检测失败

**症状**：显示手套离线

**排查步骤**：
```bash
# 检查网络连通性
ping 192.168.1.100
ping 192.168.1.101

# 检查端口
nc -zv 192.168.1.100 50001
nc -zv 192.168.1.101 50001

# 检查手套设备是否启动
# （具体命令取决于手套厂商）
```

---

### 2. Quest 检测失败

**症状**：显示 Quest 离线或 `adb_not_installed`

**排查步骤**：
```bash
# 检查 ADB 是否安装
adb version

# 检查 ADB 设备列表
adb devices

# 如果显示 unauthorized，需要在 Quest 上授权
# 如果显示 offline，尝试重启 ADB
adb kill-server
adb start-server
adb devices

# 通过 WiFi 连接 Quest（可选）
adb connect 192.168.1.XXX:5555
```

**Quest 开发者模式**：
1. 在 Quest 上进入设置 → 系统 → 开发者
2. 开启 USB 调试
3. 连接 USB 线到主机
4. 在 Quest 中点击"允许 USB 调试"

---

### 3. 机械臂检测失败

**症状**：显示机械臂离线

**排查步骤**：
```bash
# 检查网络连通性
ping 192.168.1.120

# 检查端口（根据实际机械臂型号调整）
nc -zv 192.168.1.120 30003

# 检查机械臂控制器是否启动
# （具体命令取决于机械臂品牌）
```

**端口说明**：
- UR 机器人：30003（实时接口）
- ABB 机器人：可能使用其他端口
- 需要根据实际使用的机械臂品牌确认端口

---

### 4. 测试设备检测

**单独运行检测器**：
```bash
cd machine-heartbeat-agent
node device-detector.js
```

**查看完整输出**：会显示每个设备的检测结果、延迟、电量等信息。

---

## 配置调整

如果你的设备 IP 或端口不同，需要修改：

**文件**：`machine-heartbeat-agent/device-detector.js`

**修改位置**：
```javascript
this.devices = {
  // 手套
  glove_left: { ip: '192.168.1.100', port: 50001, type: 'glove' },
  glove_right: { ip: '192.168.1.101', port: 50001, type: 'glove' },

  // 灵巧手
  dexterous_left: { ip: '192.168.1.110', port: 7447, type: 'dexterous_hand' },
  dexterous_right: { ip: '192.168.1.111', port: 7447, type: 'dexterous_hand' },

  // 机械臂（根据实际品牌修改）
  robotic_arm: { ip: '192.168.1.190', port: 30003, type: 'robotic_arm' },

  // Quest (通过 ADB 检测)
  quest: { type: 'quest' },
};
```

修改后重新构建 Docker 镜像：
```bash
./deploy.sh
```

---

## 注意事项

1. **网络隔离**：所有设备都在 192.168.1.x 网段，确保主机有对应的网络接口。

2. **ADB 权限**：Docker 容器需要访问主机的 USB 设备，需要在 `docker-compose.yml` 中配置：
   ```yaml
   devices:
     - /dev/bus/usb:/dev/bus/usb
   privileged: true
   ```

3. **Quest WiFi 连接**：如果 Quest 通过 WiFi ADB 连接，需要先配置 WiFi ADB 地址。

4. **机械臂端口**：不同品牌的机械臂使用不同的端口，请根据实际情况调整。

5. **定期检测**：设备状态每 5 分钟检测一次，平衡了实时性和系统负载。
