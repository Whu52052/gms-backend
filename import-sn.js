#!/usr/bin/env node
/**
 * 批量导入 SN 码到数据库
 *
 * 用法：
 *   node import-sn.js sn-list.json
 *   node import-sn.js --interactive
 */

const http = require('http');
const fs = require('fs');
const readline = require('readline');

// 配置
const GMS_BACKEND = process.env.GMS_BACKEND_URL || 'http://10.5.51.216:8765';

// ANSI 颜色
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  bright: '\x1b[1m',
};

function log(message, color = 'reset') {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

// ==================== HTTP 请求 ====================
async function httpRequest(url, options = {}) {
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

// ==================== 注册单个 SN ====================
async function registerSN(snData) {
  try {
    const url = `${GMS_BACKEND}/api/sn-registry`;
    const response = await httpRequest(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(snData),
    });

    return { success: true, data: response.body };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// ==================== 验证 SN 格式 ====================
function validateSNFormat(snCode) {
  // WGJ 或 WGK 开头，后跟 6 位数字
  return /^(WGJ|WGK)\d{6}$/.test(snCode);
}

// ==================== 从文件导入 ====================
async function importFromFile(filePath) {
  log('', 'bright');
  log('========================================', 'cyan');
  log('  批量导入 SN 码', 'bright');
  log('========================================', 'cyan');
  log('');

  // 读取文件
  let snList;
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    snList = JSON.parse(content);
  } catch (error) {
    log(`❌ 读取文件失败: ${error.message}`, 'red');
    process.exit(1);
  }

  if (!Array.isArray(snList)) {
    log('❌ 文件格式错误: 应为 JSON 数组', 'red');
    process.exit(1);
  }

  log(`📁 从文件读取: ${filePath}`, 'cyan');
  log(`📊 共 ${snList.length} 个 SN`, 'cyan');
  log('');

  // 验证格式
  log('🔍 验证 SN 格式...', 'yellow');
  const invalidSNs = [];
  for (const item of snList) {
    if (!item.snCode || !validateSNFormat(item.snCode)) {
      invalidSNs.push(item.snCode || '(缺失)');
    }
  }

  if (invalidSNs.length > 0) {
    log(`⚠️  发现 ${invalidSNs.length} 个无效 SN:`, 'yellow');
    invalidSNs.slice(0, 5).forEach(sn => log(`   - ${sn}`, 'yellow'));
    if (invalidSNs.length > 5) {
      log(`   ... 还有 ${invalidSNs.length - 5} 个`, 'yellow');
    }
    log('');
    log('❌ 请修正后重试', 'red');
    process.exit(1);
  }

  log('✅ 格式验证通过', 'green');
  log('');

  // 开始导入
  log('📤 开始导入...', 'yellow');
  log('');

  const results = {
    success: 0,
    failed: 0,
    skipped: 0,
    errors: [],
  };

  for (let i = 0; i < snList.length; i++) {
    const item = snList[i];
    const snCode = item.snCode;

    process.stdout.write(`[${i + 1}/${snList.length}] ${snCode} ... `);

    const result = await registerSN(item);

    if (result.success) {
      log('✅', 'green');
      results.success++;
    } else {
      if (result.error.includes('已存在')) {
        log('⊘ (已存在)', 'yellow');
        results.skipped++;
      } else {
        log(`❌ ${result.error}`, 'red');
        results.failed++;
        results.errors.push({ snCode, error: result.error });
      }
    }
  }

  // 显示结果
  log('');
  log('========================================', 'cyan');
  log('  导入完成', 'bright');
  log('========================================', 'cyan');
  log(`✅ 成功: ${results.success}`, 'green');
  log(`⊘  跳过: ${results.skipped}`, 'yellow');
  log(`❌ 失败: ${results.failed}`, 'red');
  log('');

  if (results.errors.length > 0) {
    log('失败详情:', 'red');
    results.errors.forEach(({ snCode, error }) => {
      log(`  ${snCode}: ${error}`, 'red');
    });
    log('');
  }

  return results;
}

// ==================== 交互式导入 ====================
async function interactiveImport() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const question = (prompt) => new Promise(resolve => rl.question(prompt, resolve));

  log('', 'bright');
  log('========================================', 'cyan');
  log('  交互式导入 SN 码', 'bright');
  log('========================================', 'cyan');
  log('');
  log('格式说明：', 'yellow');
  log('  SN 码: WGJ 或 WGK 开头 + 6 位数字');
  log('  示例: WGJ001234, WGK002001');
  log('');
  log('输入 "done" 完成输入', 'cyan');
  log('输入 "cancel" 取消', 'cyan');
  log('');

  const snList = [];

  while (true) {
    const snCode = await question(`SN ${snList.length + 1}: `);

    if (snCode.toLowerCase() === 'done') {
      break;
    }

    if (snCode.toLowerCase() === 'cancel') {
      log('', 'yellow');
      log('已取消', 'yellow');
      rl.close();
      process.exit(0);
    }

    if (!validateSNFormat(snCode)) {
      log('❌ 格式无效，请重新输入', 'red');
      continue;
    }

    const equipmentType = await question('  设备类型 [glove]: ') || 'glove';
    const manufacturer = await question('  制造商 (可选): ');
    const notes = await question('  备注 (可选): ');

    snList.push({
      snCode,
      equipmentType,
      manufacturer: manufacturer || null,
      notes: notes || null,
    });

    log(`✅ 已添加 ${snCode}`, 'green');
    log('');
  }

  rl.close();

  if (snList.length === 0) {
    log('', 'yellow');
    log('没有输入任何 SN', 'yellow');
    process.exit(0);
  }

  log('');
  log('========================================', 'cyan');
  log(`  共 ${snList.length} 个 SN，开始导入`, 'bright');
  log('========================================', 'cyan');
  log('');

  const results = {
    success: 0,
    failed: 0,
    errors: [],
  };

  for (const item of snList) {
    process.stdout.write(`${item.snCode} ... `);

    const result = await registerSN(item);

    if (result.success) {
      log('✅', 'green');
      results.success++;
    } else {
      log(`❌ ${result.error}`, 'red');
      results.failed++;
      results.errors.push({ snCode: item.snCode, error: result.error });
    }
  }

  log('');
  log('========================================', 'cyan');
  log('  导入完成', 'bright');
  log('========================================', 'cyan');
  log(`✅ 成功: ${results.success}`, 'green');
  log(`❌ 失败: ${results.failed}`, 'red');
  log('');

  if (results.errors.length > 0) {
    log('失败详情:', 'red');
    results.errors.forEach(({ snCode, error }) => {
      log(`  ${snCode}: ${error}`, 'red');
    });
  }
}

// ==================== 生成示例文件 ====================
function generateExampleFile() {
  const example = [
    {
      snCode: 'WGJ001234',
      equipmentType: 'glove',
      manufacturer: 'A厂商',
      purchaseDate: '2024-01-01',
      notes: '左手手套',
    },
    {
      snCode: 'WGJ001235',
      equipmentType: 'glove',
      manufacturer: 'A厂商',
      purchaseDate: '2024-01-01',
      notes: '右手手套',
    },
    {
      snCode: 'WGK002001',
      equipmentType: 'glove',
      manufacturer: 'B厂商',
      purchaseDate: '2024-01-15',
    },
  ];

  const filename = 'sn-list-example.json';
  fs.writeFileSync(filename, JSON.stringify(example, null, 2));
  log(`✅ 已生成示例文件: ${filename}`, 'green');
  log('');
  log('文件内容:', 'cyan');
  log(JSON.stringify(example, null, 2), 'reset');
}

// ==================== 显示帮助 ====================
function showHelp() {
  console.log(`
用法:
  node import-sn.js <file.json>      从 JSON 文件批量导入
  node import-sn.js --interactive    交互式导入
  node import-sn.js --example        生成示例 JSON 文件
  node import-sn.js --help           显示帮助

JSON 文件格式:
  [
    {
      "snCode": "WGJ001234",
      "equipmentType": "glove",
      "manufacturer": "某厂商",
      "purchaseDate": "2024-01-01",
      "notes": "备注"
    }
  ]

必填字段:
  - snCode: SN 码（WGJ/WGK + 6位数字）

可选字段:
  - equipmentType: 设备类型（默认: glove）
  - manufacturer: 制造商
  - manufactureDate: 生产日期 (YYYY-MM-DD)
  - purchaseDate: 采购日期 (YYYY-MM-DD)
  - warrantyEndDate: 保修结束日期 (YYYY-MM-DD)
  - notes: 备注

环境变量:
  GMS_BACKEND_URL: GMS 后端地址（默认: http://10.5.51.216:8765）

示例:
  # 从文件导入
  node import-sn.js sn-list.json

  # 交互式导入
  node import-sn.js --interactive

  # 自定义后端地址
  GMS_BACKEND_URL=http://192.168.1.100:8765 node import-sn.js sn-list.json
`);
}

// ==================== 主函数 ====================
async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    showHelp();
    process.exit(0);
  }

  if (args[0] === '--example') {
    generateExampleFile();
    process.exit(0);
  }

  if (args[0] === '--interactive' || args[0] === '-i') {
    await interactiveImport();
    process.exit(0);
  }

  const filePath = args[0];

  if (!fs.existsSync(filePath)) {
    log(`❌ 文件不存在: ${filePath}`, 'red');
    log('', 'reset');
    log('使用 --help 查看帮助', 'yellow');
    process.exit(1);
  }

  await importFromFile(filePath);
}

main().catch(err => {
  log('', 'reset');
  log(`❌ 错误: ${err.message}`, 'red');
  process.exit(1);
});
