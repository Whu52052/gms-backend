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

  // ==================== TCP 端口连接检测 ====================
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

    // 1. 检测手套
    console.log('[Device Detector] 检测手套...');
    status.gloves.left = await this.checkTCPConnection(
      this.devices.glove_left.ip,
      this.devices.glove_left.port
    );
    status.gloves.right = await this.checkTCPConnection(
      this.devices.glove_right.ip,
      this.devices.glove_right.port
    );
    console.log(`  左手: ${status.gloves.left.connected ? '✅' : '❌'}`);
    console.log(`  右手: ${status.gloves.right.connected ? '✅' : '❌'}`);
    console.log('');

    // 2. 检测灵巧手
    console.log('[Device Detector] 检测灵巧手...');
    status.dexterousHands.left = await this.checkTCPConnection(
      this.devices.dexterous_left.ip,
      this.devices.dexterous_left.port
    );
    status.dexterousHands.right = await this.checkTCPConnection(
      this.devices.dexterous_right.ip,
      this.devices.dexterous_right.port
    );
    console.log(`  左手: ${status.dexterousHands.left.connected ? '✅' : '❌'}`);
    console.log(`  右手: ${status.dexterousHands.right.connected ? '✅' : '❌'}`);
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
        battery: this.lastStatus.quest?.battery?.level || null,
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
