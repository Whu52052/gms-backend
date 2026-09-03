#!/usr/bin/env node
/**
 * 手套 SN 码自动识别模块
 *
 * 功能：
 * 1. 自动检测机器上连接的手套设备
 * 2. 通过多种方式获取手套 SN 码
 * 3. 上报到 GMS 后端自动绑定
 *
 * 识别方式：
 * - 方式1: 读取 /var/.rdc2/wuji_calib/ 配置文件
 * - 方式2: 通过手套设备 API 查询
 * - 方式3: 从采集器容器配置读取
 * - 方式4: 查询 GMS 后端已绑定记录
 */

const { exec } = require('child_process');
const { promisify } = require('util');
const fs = require('fs').promises;
const path = require('path');
const http = require('http');

const execAsync = promisify(exec);

class GloveSNDetector {
  constructor(options = {}) {
    this.machineNumber = options.machineNumber;
    this.gmsBackend = options.gmsBackend || 'http://10.5.51.216:8765';

    // 配置路径
    this.rdc2Path = '/var/.rdc2';
    this.wujiCalibPath = '/var/.rdc2/wuji_calib';
    this.containerName = options.containerName || 'importer-staging';

    // 手套 IP
    // 注意：灵巧手是 192.168.1.110:7447 / 192.168.1.111:7447
    //       手套是 192.168.1.100:50001 (左) / 192.168.1.101:50001 (右)
    this.gloveIPs = {
      left: '192.168.1.100:50001',   // 左手手套
      right: '192.168.1.101:50001',  // 右手手套
    };

    // 检测到的 SN 码
    this.detectedSN = {
      left: null,
      right: null,
    };
  }

  // ==================== HTTP 请求辅助 ====================
  async httpRequest(url, options = {}) {
    return new Promise((resolve, reject) => {
      const urlObj = new URL(url);
      const reqOptions = {
        hostname: urlObj.hostname,
        port: urlObj.port || 80,
        path: urlObj.pathname,
        method: options.method || 'GET',
        headers: options.headers || {},
        timeout: 5000,
      };

      const req = http.request(reqOptions, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try {
              resolve({ statusCode: res.statusCode, body: JSON.parse(data) });
            } catch {
              resolve({ statusCode: res.statusCode, body: data });
            }
          } else {
            reject(new Error(`HTTP ${res.statusCode}`));
          }
        });
      });

      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Request timeout'));
      });

      if (options.body) {
        req.write(typeof options.body === 'string' ? options.body : JSON.stringify(options.body));
      }
      req.end();
    });
  }

  // ==================== 方式1: 读取 wuji_calib 配置 ====================
  async detectFromCalibration() {
    try {
      const calibPath = this.wujiCalibPath;

      // 检查目录是否存在
      try {
        await fs.access(calibPath);
      } catch {
        console.log('[SN Detector] wuji_calib 目录不存在');
        return null;
      }

      const result = { left: null, right: null };

      // 读取左手配置
      const leftPath = path.join(calibPath, 'left');
      try {
        const files = await fs.readdir(leftPath);
        // 查找包含 SN 信息的文件
        for (const file of files) {
          if (file.includes('sn') || file.includes('serial') || file.endsWith('.json')) {
            const content = await fs.readFile(path.join(leftPath, file), 'utf8');
            // 真实 SN 格式：WG1JA03260524029（手套）/ WH2JA01260722006（灵巧手），
            // J/K 在第 4 位（code[3]），与 import-wuji-sn.js 解析规则一致
            const snMatch = content.match(/W[GH][0-9A-Z][JK][A-Z0-9]{6,}/i);
            if (snMatch) {
              result.left = snMatch[0].toUpperCase();
              break;
            }
          }
        }
      } catch (e) {
        // 左手配置不存在
      }

      // 读取右手配置
      const rightPath = path.join(calibPath, 'right');
      try {
        const files = await fs.readdir(rightPath);
        for (const file of files) {
          if (file.includes('sn') || file.includes('serial') || file.endsWith('.json')) {
            const content = await fs.readFile(path.join(rightPath, file), 'utf8');
            const snMatch = content.match(/W[GH][0-9A-Z][JK][A-Z0-9]{6,}/i);
            if (snMatch) {
              result.right = snMatch[0].toUpperCase();
              break;
            }
          }
        }
      } catch (e) {
        // 右手配置不存在
      }

      if (result.left || result.right) {
        console.log('[SN Detector] 从 wuji_calib 检测到 SN:');
        if (result.left) console.log(`  左手: ${result.left}`);
        if (result.right) console.log(`  右手: ${result.right}`);
        return result;
      }

      return null;
    } catch (error) {
      console.error('[SN Detector] 读取 wuji_calib 失败:', error.message);
      return null;
    }
  }

  // ==================== 方式2: 从手套设备 API 查询 ====================
  async detectFromGloveAPI(hand) {
    try {
      const ip = this.gloveIPs[hand];
      if (!ip) return null;

      const [host, port] = ip.split(':');

      // 尝试查询手套设备信息接口（假设存在）
      // 实际API需要根据手套设备文档调整
      const url = `http://${host}:${port}/api/device/info`;

      try {
        const response = await this.httpRequest(url);
        if (response.body && response.body.serialNumber) {
          return response.body.serialNumber.toUpperCase();
        }
      } catch (e) {
        // API不存在或不支持
      }

      return null;
    } catch (error) {
      return null;
    }
  }

  // ==================== 方式3: 从采集器容器配置读取 ====================
  async detectFromContainer() {
    try {
      // 读取容器内的 machine.jsonc 配置
      const { stdout } = await execAsync(
        `docker exec ${this.containerName} cat /exchange/machine.jsonc 2>/dev/null || echo ""`,
        { timeout: 5000 }
      );

      if (!stdout) return null;

      const result = { left: null, right: null };

      // 解析配置文件，查找 SN 信息
      // 可能的字段: glove_sn, serial_number, device_id 等
      const leftMatch = stdout.match(/wuji_glove_l.*?sn[^:]*:\s*["']?([A-Z0-9]+)["']?/i);
      const rightMatch = stdout.match(/wuji_glove_r.*?sn[^:]*:\s*["']?([A-Z0-9]+)["']?/i);

      if (leftMatch) result.left = leftMatch[1].toUpperCase();
      if (rightMatch) result.right = rightMatch[1].toUpperCase();

      // 也可以从注释或其他字段查找（真实格式 WG1JA... / WH2JA...，J/K 在第 4 位）
      if (!result.left) {
        const snMatch = stdout.match(/left.*?(W[GH][0-9A-Z][JK][A-Z0-9]{6,})/i);
        if (snMatch) result.left = snMatch[1].toUpperCase();
      }
      if (!result.right) {
        const snMatch = stdout.match(/right.*?(W[GH][0-9A-Z][JK][A-Z0-9]{6,})/i);
        if (snMatch) result.right = snMatch[1].toUpperCase();
      }

      if (result.left || result.right) {
        console.log('[SN Detector] 从容器配置检测到 SN:');
        if (result.left) console.log(`  左手: ${result.left}`);
        if (result.right) console.log(`  右手: ${result.right}`);
        return result;
      }

      return null;
    } catch (error) {
      console.error('[SN Detector] 读取容器配置失败:', error.message);
      return null;
    }
  }

  // ==================== 方式4: 查询 GMS 后端已绑定记录 ====================
  async detectFromGMS() {
    try {
      if (!this.machineNumber) return null;

      // 查询 GMS 后端，获取该机器上绑定的手套
      const url = `${this.gmsBackend}/api/sn-registry?machineNumber=${this.machineNumber}&status=in_use`;

      const response = await this.httpRequest(url);

      if (response.body && Array.isArray(response.body)) {
        const result = { left: null, right: null };

        for (const item of response.body) {
          if (item.handType === 'left' && !result.left) {
            result.left = item.snCode;
          }
          if (item.handType === 'right' && !result.right) {
            result.right = item.snCode;
          }
        }

        if (result.left || result.right) {
          console.log('[SN Detector] 从 GMS 后端查询到 SN:');
          if (result.left) console.log(`  左手: ${result.left}`);
          if (result.right) console.log(`  右手: ${result.right}`);
          return result;
        }
      }

      return null;
    } catch (error) {
      console.error('[SN Detector] 查询 GMS 后端失败:', error.message);
      return null;
    }
  }

  // ==================== 综合检测 ====================
  async detectAll() {
    console.log('[SN Detector] 开始检测手套 SN 码...');
    console.log(`  机器编号: ${this.machineNumber}`);
    console.log('');

    const methods = [
      { name: 'wuji_calib', fn: () => this.detectFromCalibration() },
      { name: 'container', fn: () => this.detectFromContainer() },
      { name: 'GMS backend', fn: () => this.detectFromGMS() },
    ];

    let finalResult = { left: null, right: null };

    for (const method of methods) {
      console.log(`[SN Detector] 尝试方式: ${method.name}...`);
      const result = await method.fn();

      if (result) {
        // 合并结果（优先使用第一个检测到的）
        if (result.left && !finalResult.left) {
          finalResult.left = result.left;
        }
        if (result.right && !finalResult.right) {
          finalResult.right = result.right;
        }

        // 如果两个都找到了，提前结束
        if (finalResult.left && finalResult.right) {
          break;
        }
      }
    }

    this.detectedSN = finalResult;

    console.log('');
    console.log('[SN Detector] 检测完成:');
    console.log(`  左手 SN: ${finalResult.left || '未检测到'}`);
    console.log(`  右手 SN: ${finalResult.right || '未检测到'}`);
    console.log('');

    return finalResult;
  }

  // ==================== 上报到 GMS 后端 ====================
  // v1.1.0：SN 已随心跳 payload（devices.gloves.*.snCode）上报，
  // 服务端 /api/edge/heartbeat 负责与 sn_registry 比对。此方法保留为空操作，
  // 避免外部调用方报错。
  async reportToGMS() {
    return true;
  }

  // ==================== 获取结果 ====================
  getDetectedSN() {
    return this.detectedSN;
  }
}

module.exports = GloveSNDetector;

// ==================== 独立运行测试 ====================
if (require.main === module) {
  const detector = new GloveSNDetector({
    machineNumber: 'we-105',
    gmsBackend: 'http://10.5.51.216:8765',
    containerName: 'importer-staging',
  });

  (async () => {
    await detector.detectAll();
    await detector.reportToGMS();
  })();
}
