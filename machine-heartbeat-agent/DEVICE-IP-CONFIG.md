# 设备IP地址配置说明

## 手套 vs 灵巧手

### 手套 (Glove)
- **左手**: 192.168.1.100:50001
- **右手**: 192.168.1.101:50001
- **用途**: 数据采集手套

### 灵巧手 (Dexterous Hand)
- **左手**: 192.168.1.110:7447
- **右手**: 192.168.1.111:7447
- **用途**: 机器人灵巧手

## 当前配置

心跳监控系统默认监控**手套设备**：
- 左手手套: 192.168.1.100:50001
- 右手手套: 192.168.1.101:50001

## 如何切换监控目标

如果需要监控灵巧手而不是手套，修改以下文件：

### 1. glove-monitor.js
```javascript
this.gloveIPs = {
  left: '192.168.1.110:7447',   // 灵巧手
  right: '192.168.1.111:7447',
};
```

### 2. glove-sn-detector.js
```javascript
this.gloveIPs = {
  left: '192.168.1.110:7447',   // 灵巧手
  right: '192.168.1.111:7447',
};
```

### 3. 环境变量配置（docker-compose.yml）
```yaml
environment:
  - GLOVE_LEFT_IP=192.168.1.110:7447
  - GLOVE_RIGHT_IP=192.168.1.111:7447
```

## 同时监控两种设备

如果需要同时监控手套和灵巧手，可以扩展配置：

```javascript
this.devices = {
  glove_left: '192.168.1.100:50001',
  glove_right: '192.168.1.101:50001',
  hand_left: '192.168.1.110:7447',
  hand_right: '192.168.1.111:7447',
};
```

修改后需要重新构建和部署容器：
```bash
docker-compose down
docker-compose build
docker-compose up -d
```
