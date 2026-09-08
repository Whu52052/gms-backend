#!/usr/bin/env node
/**
 * 设备状态检测器
 *
 * 检测以下设备：
 * 1. 手套（左右）- TCP 连接检测
 * 2. 灵巧手（左右）- TCP 连接检测
 * 3. 机械臂 - TCP 连接检测
 * 4. Quest 头显 - ADB 连接检测
 * 5. Quest 手柄（左右）- 通过 Quest 查询电量和状态
 *
 * 使用场景：
 * - 纯手套机器：只有手套
 * - 灵巧手机器：手套 + 灵巧手 + 机械臂 + Quest
 */

const net = require('net');
const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);

class DeviceStatusDetector {
  constructor(options = {}) {
    this.machineNumber = options.machineNumber;

    // 设备 IP 配置
    this.devices = {
      // 手套
      glove_left: { ip: '192.168.1.100', port: 50001, type: 'glove' },
      glove_right: { ip: '192.168.1.101', port: 50001, type: 'glove' },

      // 灵巧手
      dexterous_left: { ip: '192.168.1.110', port: 7447, type: 'dexterous_hand' },
      dexterous_right: { ip: '192.168.1.111', port: 7447, type: 'dexterous_hand' },

      // 机械臂
      robotic_arm: { ip: '192.168.1.190', port: 30003, type: 'robotic_arm' },

      // Quest (通过 ADB 检测)
      quest: { type: 'quest' },
    };

    this.lastStatus = null;
  }

  // ==================== PING 检测（替代 TCP 端口检测）====================
  async checkPingConnection(ip, timeout = 3000) {
    try {
      const startTime = Date.now();
      // 使用 ping 命令：-c 1 发送1个包，-W 超时秒数
      const timeoutSec = Math.ceil(timeout / 1000);
      const { stdout, stderr } = await execAsync(`ping -c 1 -W ${timeoutSec} ${ip}`, { timeout: timeout + 500 });

      const latency = Date.now() - startTime;

      // 检查 ping 是否成功（输出包含 "1 received" 或 "1 packets received"）
      if (stdout.includes('1 received') || stdout.includes('1 packets received')) {
        return { connected: true, latency };
      } else {
        return { connected: false, error: 'no_response' };
      }
    } catch (err) {
      return { connected: false, error: err.code || 'ping_failed' };
    }
  }

  // ==================== TCP 端口连接检测（保留备用）====================
  async checkTCPConnection(ip, port, timeout = 3000) {
    return new Promise((resolve) => {
      const socket = new net.Socket();
      let isResolved = false;

      const cleanup = () => {
        if (!isResolved) {
          isResolved = true;
          socket.destroy();
        }
      };

      socket.setTimeout(timeout);

      socket.on('connect', () => {
        cleanup();
        resolve({ connected: true, latency: Date.now() - startTime });
      });

      socket.on('timeout', () => {
        cleanup();
        resolve({ connected: false, error: 'timeout' });
      });

      socket.on('error', (err) => {
        cleanup();
        resolve({ connected: false, error: err.code });
      });

      const startTime = Date.now();
      socket.connect(port, ip);
    });
  }

  // ==================== 从 Docker 日志中提取手套 SN 码 ====================
  async getGloveSNFromDockerLogs() {
    try {
      console.log(`[Device Detector] [DEBUG] 开始提取 SN 码...`);

      // 第一步：列出所有容器
      const { stdout: allContainers } = await execAsync('docker ps -a --format "{{.Names}}"', { timeout: 5000 });
      console.log(`[Device Detector] [DEBUG] 所有容器: ${allContainers.split('\n').length} 个`);

      // 第二步：过滤包含 mono 或 rdc 的容器
      const containers = allContainers.split('\n').filter(c => c.trim() && (c.includes('mono') || c.includes('rdc')));
      console.log(`[Device Detector] 找到 ${containers.length} 个 mono/rdc 容器: ${containers.join(', ')}`);

      if (containers.length === 0) {
        console.log(`[Device Detector] 未找到 mono/rdc 容器`);
        return { left: null, right: null };
      }

      const snCodes = { left: null, right: null };

      // 遍历所有容器，直到找到手套 SN 码
      for (const containerName of containers) {
        console.log(`[Device Detector] 从容器 ${containerName} 提取 SN 码...`);

        // 直接获取日志，然后在 JS 中过滤
        const { stdout: logs } = await execAsync(`docker logs ${containerName} 2>&1`, { timeout: 10000, maxBuffer: 10 * 1024 * 1024 });

        // 在 JS 中过滤包含 glove 和 sn= 的行
        const lines = logs.split('\n').filter(l => l.toLowerCase().includes('glove') && l.includes('sn='));
        console.log(`[Device Detector] 找到 ${lines.length} 行包含手套 SN 的日志`);

        if (lines.length === 0) continue;

        // 解析日志提取 SN 码（从后往前查找，获取最新的）
        for (let i = lines.length - 1; i >= 0; i--) {
          const line = lines[i];

          // 匹配格式: wuji_glove_l ... sn=WG1JA06260625043
          if (!snCodes.left) {
            const leftMatch = line.match(/wuji_glove_l.*sn=(WG[0-9A-Z]+)/);
            if (leftMatch) {
              snCodes.left = leftMatch[1];
              console.log(`[Device Detector] 左手 SN: ${snCodes.left}`);
            }
          }

          if (!snCodes.right) {
            const rightMatch = line.match(/wuji_glove_r.*sn=(WG[0-9A-Z]+)/);
            if (rightMatch) {
              snCodes.right = rightMatch[1];
              console.log(`[Device Detector] 右手 SN: ${snCodes.right}`);
            }
          }

          // 如果两个都找到了就可以退出
          if (snCodes.left && snCodes.right) break;
        }

        // 如果已经找到两个 SN 码，就不需要继续检查其他容器
        if (snCodes.left && snCodes.right) break;
      }

      return snCodes;
    } catch (error) {
      console.error(`[Device Detector] ❌ 从 Docker 日志提取手套 SN 码失败: ${error.message}`);
      console.error(`[Device Detector] ❌ 错误堆栈:`, error.stack);
      return { left: null, right: null };
    }
  }

  // ==================== ADB 检测 Quest ====================
  async checkQuestConnection() {
    try {
      // 检查 ADB 设备
      const { stdout } = await execAsync('adb devices', { timeout: 5000 });

      // 解析设备列表
      const lines = stdout.split('\n').filter(line => line.trim() && !line.includes('List of devices'));

      if (lines.length === 0) {
        return {
          connected: false,
          error: 'no_device',
        };
      }

      // 获取第一个设备的序列号
      const deviceLine = lines[0];
      const [serialNumber, status] = deviceLine.split('\t').map(s => s.trim());

      if (status !== 'device') {
        return {
          connected: false,
          error: status, // unauthorized, offline 等
          serialNumber,
        };
      }

      // 连接成功，获取电池信息
      const battery = await this.getQuestBattery();

      return {
        connected: true,
        serialNumber,
        battery,
      };

    } catch (error) {
      return {
        connected: false,
        error: error.message.includes('not found') ? 'adb_not_installed' : 'unknown',
      };
    }
  }

  // ==================== 获取 Quest 电池信息 ====================
  async getQuestBattery() {
    try {
      const { stdout } = await execAsync('adb shell dumpsys battery', { timeout: 5000 });

      const levelMatch = stdout.match(/level: (\d+)/);
      const statusMatch = stdout.match(/status: (\d+)/);
      const temperatureMatch = stdout.match(/temperature: (\d+)/);

      const level = levelMatch ? parseInt(levelMatch[1]) : null;
      const statusCode = statusMatch ? parseInt(statusMatch[1]) : null;
      const temperature = temperatureMatch ? parseInt(temperatureMatch[1]) / 10 : null; // 除以10得到摄氏度

      // 状态码含义：1=Unknown, 2=Charging, 3=Discharging, 4=Not charging, 5=Full
      const statusMap = {
        1: 'unknown',
        2: 'charging',
        3: 'discharging',
        4: 'not_charging',
        5: 'full',
      };

      return {
        level,
        status: statusMap[statusCode] || 'unknown',
        temperature,
      };

    } catch (error) {
      return null;
    }
  }

  // ==================== 获取 Quest 手柄电量 ====================
  async getQuestControllerBattery() {
    try {
      // Quest 手柄电量需要通过特定的 ADB 命令或 Oculus SDK 获取
      // 这里使用 logcat 抓取系统日志中的电量信息（简化方案）

      // 更准确的方案是通过 Oculus Platform SDK，但需要在 Quest 上运行应用
      // 这里返回占位数据，实际部署时需要根据具体环境调整

      const { stdout } = await execAsync(
        'adb shell "dumpsys battery | grep -E \'controller\'"',
        { timeout: 5000 }
      );

      // 如果有输出则解析，否则返回 null
      if (stdout.trim()) {
        // 根据实际输出格式解析
        return {
          left: { level: null, charging: false },
          right: { level: null, charging: false },
        };
      }

      return null;

    } catch (error) {
      return null;
    }
  }

  // ==================== 检测机械臂状态 ====================
  async checkRoboticArm() {
    const result = await this.checkTCPConnection(
      this.devices.robotic_arm.ip,
      this.devices.robotic_arm.port
    );

    if (!result.connected) {
      return {
        connected: false,
        ip: this.devices.robotic_arm.ip,
        port: this.devices.robotic_arm.port,
        error: result.error,
      };
    }

    // 机械臂连接成功
    return {
      connected: true,
      ip: this.devices.robotic_arm.ip,
      port: this.devices.robotic_arm.port,
      latency: result.latency,
    };
  }

  // ==================== 检测所有设备 ====================
  async detectAll() {
    console.log('[Device Detector] ==========================================');
    console.log('[Device Detector] 开始检测设备状态');
    console.log('[Device Detector] ==========================================');
    console.log('');

    const status = {
      gloves: {
        left: null,
        right: null,
      },
      dexterousHands: {
        left: null,
        right: null,
      },
      roboticArm: null,
      quest: null,
      questControllers: null,
      machineType: null, // glove_only / dexterous
      timestamp: new Date().toISOString(),
    };

    // 1. 检测手套（使用 PING）
    console.log('[Device Detector] 检测手套（PING）...');
    status.gloves.left = await this.checkPingConnection(this.devices.glove_left.ip);
    status.gloves.right = await this.checkPingConnection(this.devices.glove_right.ip);
    console.log(`  左手 (${this.devices.glove_left.ip}): ${status.gloves.left.connected ? '✅' : '❌'}`);
    console.log(`  右手 (${this.devices.glove_right.ip}): ${status.gloves.right.connected ? '✅' : '❌'}`);

    // 1.1 如果手套在线，尝试从 Docker 日志提取 SN 码
    if (status.gloves.left.connected || status.gloves.right.connected) {
      console.log('[Device Detector] 从 Docker 日志提取手套 SN 码...');
      const snCodes = await this.getGloveSNFromDockerLogs();
      if (snCodes.left) {
        status.gloves.left.snCode = snCodes.left;
        console.log(`  左手 SN: ${snCodes.left}`);
      }
      if (snCodes.right) {
        status.gloves.right.snCode = snCodes.right;
        console.log(`  右手 SN: ${snCodes.right}`);
      }
    }
    console.log('');

    // 2. 检测灵巧手（使用 PING）
    console.log('[Device Detector] 检测灵巧手（PING）...');
    status.dexterousHands.left = await this.checkPingConnection(this.devices.dexterous_left.ip);
    status.dexterousHands.right = await this.checkPingConnection(this.devices.dexterous_right.ip);
    console.log(`  左手 (${this.devices.dexterous_left.ip}): ${status.dexterousHands.left.connected ? '✅' : '❌'}`);
    console.log(`  右手 (${this.devices.dexterous_right.ip}): ${status.dexterousHands.right.connected ? '✅' : '❌'}`);
    console.log('');

    // 3. 判断机器类型
    const hasDexterous = status.dexterousHands.left.connected || status.dexterousHands.right.connected;
    status.machineType = hasDexterous ? 'dexterous' : 'glove_only';
    console.log(`[Device Detector] 机器类型: ${status.machineType === 'dexterous' ? '灵巧手机器' : '纯手套机器'}`);
    console.log('');

    // 4. 检测 Quest 头显（所有机器都有）
    console.log('[Device Detector] 检测 Quest 头显...');
    status.quest = await this.checkQuestConnection();
    console.log(`  状态: ${status.quest.connected ? '✅' : '❌'}`);
    if (status.quest.connected) {
      console.log(`  序列号: ${status.quest.serialNumber}`);
      if (status.quest.battery) {
        console.log(`  电量: ${status.quest.battery.level}%`);
        console.log(`  状态: ${status.quest.battery.status}`);
        if (status.quest.battery.temperature) {
          console.log(`  温度: ${status.quest.battery.temperature}°C`);
        }
      }
    } else {
      console.log(`  错误: ${status.quest.error}`);
    }
    console.log('');

    // 5. 检测 Quest 手柄（所有机器都有）
    if (status.quest.connected) {
      console.log('[Device Detector] 检测 Quest 手柄...');
      status.questControllers = await this.getQuestControllerBattery();
      if (status.questControllers) {
        console.log(`  左手柄: ${status.questControllers.left.level ? status.questControllers.left.level + '%' : '未知'}`);
        console.log(`  右手柄: ${status.questControllers.right.level ? status.questControllers.right.level + '%' : '未知'}`);
      } else {
        console.log(`  ⚠️  无法获取手柄电量（可能需要特定应用支持）`);
      }
      console.log('');
    }

    // 6. 如果是灵巧手机器，检测机械臂
    if (status.machineType === 'dexterous') {
      console.log('[Device Detector] 检测机械臂...');
      status.roboticArm = await this.checkRoboticArm();
      console.log(`  状态: ${status.roboticArm.connected ? '✅' : '❌'}`);
      if (status.roboticArm.connected) {
        console.log(`  延迟: ${status.roboticArm.latency}ms`);
      }
      console.log('');
    }

    console.log('[Device Detector] ==========================================');
    console.log('[Device Detector] 检测完成');
    console.log('[Device Detector] ==========================================');
    console.log('');

    this.lastStatus = status;
    return status;
  }

  // ==================== 获取最后检测状态 ====================
  getLastStatus() {
    return this.lastStatus;
  }

  // ==================== 获取设备摘要（用于心跳上报）====================
  getDeviceSummary() {
    if (!this.lastStatus) {
      return null;
    }

    const summary = {
      machineType: this.lastStatus.machineType,
      gloves: {
        left: this.lastStatus.gloves.left.connected,
        right: this.lastStatus.gloves.right.connected,
      },
      quest: {
        connected: this.lastStatus.quest?.connected || false,
        serialNumber: this.lastStatus.quest?.serialNumber || null,
        error: this.lastStatus.quest?.error || null,
        // 完整电量对象 {level, status, temperature}，缺失时为 null
        battery: this.lastStatus.quest?.battery || null,
      },
    };

    // Quest 手柄（所有机器都有）
    if (this.lastStatus.questControllers) {
      summary.questControllers = {
        left: this.lastStatus.questControllers.left.level,
        right: this.lastStatus.questControllers.right.level,
      };
    }

    // 灵巧手机器的额外设备
    if (this.lastStatus.machineType === 'dexterous') {
      summary.dexterousHands = {
        left: this.lastStatus.dexterousHands.left.connected,
        right: this.lastStatus.dexterousHands.right.connected,
      };

      summary.roboticArm = {
        connected: this.lastStatus.roboticArm?.connected || false,
      };
    }

    return summary;
  }
}

module.exports = DeviceStatusDetector;

// ==================== 独立运行测试 ====================
if (require.main === module) {
  const detector = new DeviceStatusDetector({
    machineNumber: 'we-105',
  });

  (async () => {
    const status = await detector.detectAll();

    console.log('完整状态 JSON:');
    console.log(JSON.stringify(status, null, 2));
    console.log('');

    console.log('心跳摘要 JSON:');
    console.log(JSON.stringify(detector.getDeviceSummary(), null, 2));
  })();
}
