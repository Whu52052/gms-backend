#!/usr/bin/env node
/**
 * 手套 SN 码验证与匹配模块
 *
 * 功能：
 * 1. 检测本地手套 SN 码
 * 2. 与 GMS 数据库中的 SN 注册表匹配
 * 3. 验证 SN 状态（available/in_use/damaged等）
 * 4. 检查是否与当前机器绑定
 * 5. 自动更新绑定关系
 */

const http = require('http');
const GloveSNDetector = require('./glove-sn-detector');

class SNValidator {
  constructor(options = {}) {
    this.machineNumber = options.machineNumber;
    this.gmsBackend = options.gmsBackend || 'http://10.5.51.216:8765';
    this.snDetector = new GloveSNDetector(options);

    // 验证结果
    this.validationResults = {
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
        path: urlObj.pathname + urlObj.search,
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
            reject(new Error(`HTTP ${res.statusCode}: ${data}`));
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

  // ==================== 查询数据库中的 SN 信息 ====================
  async querySNFromDatabase(snCode) {
    try {
      const url = `${this.gmsBackend}/api/sn-registry/${snCode}`;
      const response = await this.httpRequest(url);

      if (response.body && response.body.snCode) {
        return response.body;
      }

      return null;
    } catch (error) {
      console.error(`[SN Validator] 查询 ${snCode} 失败:`, error.message);
      return null;
    }
  }

  // ==================== 验证单个 SN 码 ====================
  async validateSN(snCode, hand) {
    if (!snCode) {
      return {
        hand,
        snCode: null,
        status: 'not_detected',
        message: '未检测到 SN 码',
        valid: false,
      };
    }

    console.log(`[SN Validator] 验证 ${hand}手 SN: ${snCode}...`);

    // 查询数据库
    const dbRecord = await this.querySNFromDatabase(snCode);

    if (!dbRecord) {
      return {
        hand,
        snCode,
        status: 'not_found',
        message: `SN 码 ${snCode} 不在数据库中`,
        valid: false,
        action: 'register_required',
      };
    }

    // 验证 SN 状态
    const validation = {
      hand,
      snCode,
      dbStatus: dbRecord.status,
      dbMachine: dbRecord.machineNumber,
      dbHandType: dbRecord.handType,
      equipmentType: dbRecord.equipmentType,
      valid: false,
      message: '',
      action: null,
    };

    // 检查手套类型是否匹配
    if (dbRecord.handType && dbRecord.handType !== hand) {
      validation.valid = false;
      validation.status = 'hand_mismatch';
      validation.message = `数据库中为${dbRecord.handType}手，但检测到在${hand}手位置`;
      validation.action = 'check_connection';
      console.warn(`[SN Validator] ⚠️  ${snCode} 左右手不匹配`);
      return validation;
    }

    // 检查 SN 状态
    switch (dbRecord.status) {
      case 'available':
        // 可用但未绑定
        validation.valid = true;
        validation.status = 'available';
        validation.message = `SN 可用，未绑定到任何机器`;
        validation.action = 'auto_bind';
        console.log(`[SN Validator] ✅ ${snCode} 可用，建议绑定`);
        break;

      case 'in_use':
        // 已在使用
        if (dbRecord.machineNumber === this.machineNumber) {
          // 已绑定到当前机器
          validation.valid = true;
          validation.status = 'bound_current';
          validation.message = `已正确绑定到当前机器 ${this.machineNumber}`;
          validation.action = 'none';
          console.log(`[SN Validator] ✅ ${snCode} 已绑定到本机`);
        } else {
          // 绑定到其他机器
          validation.valid = false;
          validation.status = 'bound_other';
          validation.message = `已绑定到其他机器 ${dbRecord.machineNumber}`;
          validation.action = 'unbind_and_rebind';
          console.error(`[SN Validator] ❌ ${snCode} 已绑定到 ${dbRecord.machineNumber}`);
        }
        break;

      case 'damaged':
        validation.valid = false;
        validation.status = 'damaged';
        validation.message = `手套已损坏: ${dbRecord.damageReason || '未说明'}`;
        validation.action = 'replace_required';
        console.error(`[SN Validator] ❌ ${snCode} 已损坏`);
        break;

      case 'in_repair':
        validation.valid = false;
        validation.status = 'in_repair';
        validation.message = `手套维修中`;
        validation.action = 'wait_repair';
        console.warn(`[SN Validator] ⚠️  ${snCode} 维修中`);
        break;

      case 'shipped':
        validation.valid = false;
        validation.status = 'shipped';
        validation.message = `手套已发货: ${dbRecord.trackingNumber || '未知'}`;
        validation.action = 'track_shipment';
        console.warn(`[SN Validator] ⚠️  ${snCode} 已发货`);
        break;

      default:
        validation.valid = false;
        validation.status = dbRecord.status;
        validation.message = `未知状态: ${dbRecord.status}`;
        validation.action = 'manual_check';
        console.warn(`[SN Validator] ⚠️  ${snCode} 状态异常: ${dbRecord.status}`);
    }

    return validation;
  }

  // ==================== 验证所有检测到的 SN ====================
  async validateAll() {
    console.log('[SN Validator] ==========================================');
    console.log('[SN Validator] 开始 SN 码验证');
    console.log('[SN Validator] ==========================================');
    console.log('');

    // 1. 检测本地 SN
    console.log('[SN Validator] 步骤 1: 检测本地 SN 码...');
    const detectedSN = await this.snDetector.detectAll();
    console.log('');

    // 2. 验证每个 SN
    console.log('[SN Validator] 步骤 2: 验证 SN 码...');
    const leftValidation = await this.validateSN(detectedSN.left, 'left');
    const rightValidation = await this.validateSN(detectedSN.right, 'right');
    console.log('');

    this.validationResults = {
      left: leftValidation,
      right: rightValidation,
    };

    // 3. 汇总结果
    console.log('[SN Validator] ==========================================');
    console.log('[SN Validator] 验证结果汇总');
    console.log('[SN Validator] ==========================================');
    console.log('');

    this.printValidationSummary();

    return this.validationResults;
  }

  // ==================== 打印验证摘要 ====================
  printValidationSummary() {
    const results = [
      { hand: '左手', data: this.validationResults.left },
      { hand: '右手', data: this.validationResults.right },
    ];

    for (const { hand, data } of results) {
      const icon = data.valid ? '✅' : '❌';
      console.log(`${icon} ${hand}:`);
      console.log(`   SN: ${data.snCode || '未检测到'}`);
      if (data.snCode) {
        console.log(`   状态: ${data.message}`);
        if (data.action && data.action !== 'none') {
          console.log(`   建议: ${this.getActionDescription(data.action)}`);
        }
        if (data.dbMachine) {
          console.log(`   绑定机器: ${data.dbMachine}`);
        }
      }
      console.log('');
    }
  }

  // ==================== 获取操作建议描述 ====================
  getActionDescription(action) {
    const descriptions = {
      'register_required': '需要在系统中注册此 SN',
      'auto_bind': '自动绑定到当前机器',
      'check_connection': '检查手套连接是否正确（左右手可能接反）',
      'unbind_and_rebind': '需要先从其他机器解绑，再绑定到本机',
      'replace_required': '需要更换手套',
      'wait_repair': '等待维修完成',
      'track_shipment': '跟踪物流信息',
      'manual_check': '需要人工检查',
    };
    return descriptions[action] || action;
  }

  // ==================== 自动修复绑定关系 ====================
  async autoFixBindings() {
    console.log('[SN Validator] 尝试自动修复绑定关系...');
    console.log('');

    const fixes = [];

    for (const hand of ['left', 'right']) {
      const validation = this.validationResults[hand];

      if (!validation || !validation.snCode) continue;

      if (validation.action === 'auto_bind') {
        // 自动绑定
        console.log(`[SN Validator] 绑定 ${validation.snCode} 到 ${this.machineNumber} (${hand}手)...`);
        const success = await this.bindSN(validation.snCode, hand);
        if (success) {
          fixes.push({ hand, snCode: validation.snCode, action: 'bound' });
          console.log(`[SN Validator] ✅ 绑定成功`);
        } else {
          console.error(`[SN Validator] ❌ 绑定失败`);
        }
        console.log('');
      } else if (validation.action === 'unbind_and_rebind') {
        // 先解绑再绑定
        console.log(`[SN Validator] ${validation.snCode} 已绑定到 ${validation.dbMachine}，需要先解绑`);
        console.log(`[SN Validator] ⚠️  此操作需要管理员权限，跳过自动处理`);
        console.log('');
      }
    }

    if (fixes.length > 0) {
      console.log(`[SN Validator] 自动修复完成: ${fixes.length} 个绑定`);
    } else {
      console.log(`[SN Validator] 无需修复或无法自动修复`);
    }
    console.log('');

    return fixes;
  }

  // ==================== 绑定 SN 到当前机器 ====================
  async bindSN(snCode, hand) {
    try {
      const url = `${this.gmsBackend}/api/sn-registry/${snCode}`;
      await this.httpRequest(url, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          status: 'in_use',
          machineNumber: this.machineNumber,
          handType: hand,
        }),
      });
      return true;
    } catch (error) {
      console.error(`[SN Validator] 绑定失败:`, error.message);
      return false;
    }
  }

  // ==================== 获取验证状态（用于心跳上报）====================
  getValidationStatus() {
    return {
      left: this.validationResults.left ? {
        snCode: this.validationResults.left.snCode,
        valid: this.validationResults.left.valid,
        status: this.validationResults.left.status,
        message: this.validationResults.left.message,
      } : null,
      right: this.validationResults.right ? {
        snCode: this.validationResults.right.snCode,
        valid: this.validationResults.right.valid,
        status: this.validationResults.right.status,
        message: this.validationResults.right.message,
      } : null,
    };
  }
}

module.exports = SNValidator;

// ==================== 独立运行测试 ====================
if (require.main === module) {
  const validator = new SNValidator({
    machineNumber: 'we-105',
    gmsBackend: 'http://10.5.51.216:8765',
    containerName: 'importer-staging',
  });

  (async () => {
    // 验证所有 SN
    await validator.validateAll();

    // 尝试自动修复
    await validator.autoFixBindings();

    // 获取状态
    console.log('[Test] 验证状态（用于心跳）:');
    console.log(JSON.stringify(validator.getValidationStatus(), null, 2));
  })();
}
