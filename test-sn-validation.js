#!/usr/bin/env node
/**
 * SN 验证功能测试脚本
 *
 * 演示完整的 SN 检测、验证和匹配流程
 */

const SNValidator = require('./machine-heartbeat-agent/sn-validator');

// 测试配置
const TEST_CONFIG = {
  machineNumber: 'we-105',
  gmsBackend: 'http://10.5.51.216:8765',
  containerName: 'importer-staging',
};

// ANSI 颜色
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
};

function log(message, color = 'reset') {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

function section(title) {
  console.log('');
  log('='.repeat(60), 'cyan');
  log(`  ${title}`, 'bright');
  log('='.repeat(60), 'cyan');
  console.log('');
}

function subsection(title) {
  console.log('');
  log(`--- ${title} ---`, 'blue');
  console.log('');
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ==================== 测试场景 ====================

async function testScenario1() {
  section('场景 1: 正常的 SN 验证流程');

  log('这个场景模拟一台机器上安装了正确绑定的手套', 'yellow');
  console.log('');

  const validator = new SNValidator(TEST_CONFIG);

  subsection('步骤 1: 检测本地 SN 码');
  log('从以下位置检测：', 'cyan');
  log('  1. /var/.rdc2/wuji_calib/ 配置文件');
  log('  2. /exchange/machine.jsonc 容器配置');
  log('  3. GMS 后端已绑定记录');
  log('  4. 手套设备 API（如果支持）');
  console.log('');

  subsection('步骤 2: 查询数据库验证');
  log('向 GMS 后端查询每个检测到的 SN:', 'cyan');
  log('  GET /api/sn-registry/WGJ001234');
  log('  GET /api/sn-registry/WGJ001235');
  console.log('');

  subsection('步骤 3: 验证绑定关系');
  log('检查以下条件：', 'cyan');
  log('  ✓ SN 是否存在于数据库');
  log('  ✓ 状态是否为 available 或 in_use');
  log('  ✓ 如果已绑定，是否绑定到当前机器');
  log('  ✓ 左右手类型是否匹配');
  console.log('');

  subsection('步骤 4: 执行验证');
  const results = await validator.validateAll();
  console.log('');

  subsection('步骤 5: 尝试自动修复');
  await validator.autoFixBindings();

  return results;
}

async function testScenario2() {
  section('场景 2: 检测到未注册的 SN');

  log('这个场景模拟检测到一个数据库中不存在的 SN', 'yellow');
  console.log('');

  log('预期结果：', 'cyan');
  log('  ❌ 验证失败');
  log('  📝 提示: "SN 码 XXX 不在数据库中"');
  log('  🔧 建议操作: "需要在系统中注册此 SN"');
  console.log('');

  log('处理方式：', 'cyan');
  log('  1. 系统管理员收到告警');
  log('  2. 在 SN 管理界面手动添加该 SN');
  log('  3. 或者使用 API 批量导入：');
  log('     curl -X POST http://10.5.51.216:8765/api/sn-registry \\');
  log('       -H "Content-Type: application/json" \\');
  log('       -d \'{"snCode":"WGJ001234","equipmentType":"glove"}\'');
  console.log('');
}

async function testScenario3() {
  section('场景 3: 检测到已绑定到其他机器的 SN');

  log('这个场景模拟手套被错误地安装到了另一台机器上', 'yellow');
  console.log('');

  log('示例：', 'cyan');
  log('  - we-105 检测到 SN: WGJ001234');
  log('  - 但数据库显示 WGJ001234 已绑定到 we-106');
  console.log('');

  log('预期结果：', 'cyan');
  log('  ❌ 验证失败');
  log('  📝 提示: "已绑定到其他机器 we-106"');
  log('  🔧 建议操作: "需要先从其他机器解绑，再绑定到本机"');
  console.log('');

  log('处理方式：', 'cyan');
  log('  方案 1: 自动处理（需要管理员权限）');
  log('    1. 从 we-106 解绑');
  log('    2. 绑定到 we-105');
  log('');
  log('  方案 2: 人工处理');
  log('    1. 确认手套是否真的移动了位置');
  log('    2. 在管理界面手动解绑并重新绑定');
  log('    3. 或者把手套移回正确的机器');
  console.log('');
}

async function testScenario4() {
  section('场景 4: 检测到左右手接反');

  log('这个场景模拟手套的左右手插反了', 'yellow');
  console.log('');

  log('示例：', 'cyan');
  log('  - 左手位置检测到: WGJ001235（数据库记录为右手）');
  log('  - 右手位置检测到: WGJ001234（数据库记录为左手）');
  console.log('');

  log('预期结果：', 'cyan');
  log('  ❌ 验证失败');
  log('  📝 提示: "数据库中为右手，但检测到在左手位置"');
  log('  🔧 建议操作: "检查手套连接是否正确（左右手可能接反）"');
  console.log('');

  log('处理方式：', 'cyan');
  log('  1. 现场工程师检查物理连接');
  log('  2. 交换左右手手套的网线连接');
  log('  3. 重新检测验证');
  console.log('');
}

async function testScenario5() {
  section('场景 5: 检测到损坏的手套');

  log('这个场景模拟使用了已标记为损坏的手套', 'yellow');
  console.log('');

  log('预期结果：', 'cyan');
  log('  ❌ 验证失败');
  log('  📝 提示: "手套已损坏: 传感器失灵"');
  log('  🔧 建议操作: "需要更换手套"');
  console.log('');

  log('处理方式：', 'cyan');
  log('  1. 自动创建技术支持工单');
  log('  2. 申请备用手套');
  log('  3. 更换后更新绑定关系');
  console.log('');
}

async function testScenario6() {
  section('场景 6: 自动绑定可用的 SN');

  log('这个场景模拟新手套首次使用', 'yellow');
  console.log('');

  log('流程：', 'cyan');
  log('  1. 检测到 SN: WGJ001234');
  log('  2. 查询数据库: 状态为 available（可用但未绑定）');
  log('  3. 自动执行绑定操作');
  log('  4. 更新数据库: status=in_use, machineNumber=we-105');
  console.log('');

  log('预期结果：', 'cyan');
  log('  ✅ 自动绑定成功');
  log('  📝 提示: "已自动绑定到当前机器 we-105"');
  console.log('');
}

// ==================== 心跳数据示例 ====================

function showHeartbeatExample() {
  section('心跳数据结构示例');

  log('客户端发送到后端的心跳数据包含完整的验证信息：', 'cyan');
  console.log('');

  const examplePayload = {
    machineNumber: 'we-105',
    hostname: 'we-105-workstation',
    ipAddress: '10.5.51.105',
    timestamp: new Date().toISOString(),
    cameras: [
      {
        device: '/dev/video0',
        camera: 'Camera 1',
        fps: 30,
        isDropping: false
      }
    ],
    gloves: {
      left: {
        connected: true,
        snCode: 'WGJ001234',
        validation: {
          valid: true,
          status: 'bound_current',
          message: '已正确绑定到当前机器 we-105',
        }
      },
      right: {
        connected: true,
        snCode: 'WGJ001235',
        validation: {
          valid: false,
          status: 'bound_other',
          message: '已绑定到其他机器 we-106',
          dbMachine: 'we-106',
        }
      }
    }
  };

  console.log(JSON.stringify(examplePayload, null, 2));
  console.log('');

  log('后端可以根据 validation.valid 字段判断是否需要告警', 'yellow');
}

// ==================== API 使用示例 ====================

function showAPIExamples() {
  section('API 使用示例');

  subsection('1. 查询单个 SN');
  log('curl http://10.5.51.216:8765/api/sn-registry/WGJ001234', 'green');
  console.log('');

  subsection('2. 查询所有可用的 SN');
  log('curl "http://10.5.51.216:8765/api/sn-registry?status=available"', 'green');
  console.log('');

  subsection('3. 查询某机器绑定的 SN');
  log('curl "http://10.5.51.216:8765/api/sn-registry?machineNumber=we-105"', 'green');
  console.log('');

  subsection('4. 注册新 SN');
  log('curl -X POST http://10.5.51.216:8765/api/sn-registry \\', 'green');
  log('  -H "Content-Type: application/json" \\', 'green');
  log('  -d \'{"snCode":"WGJ001234","equipmentType":"glove"}\'', 'green');
  console.log('');

  subsection('5. 手动绑定 SN 到机器');
  log('curl -X POST http://10.5.51.216:8765/api/sn-registry/WGJ001234/bind \\', 'green');
  log('  -H "Content-Type: application/json" \\', 'green');
  log('  -d \'{"machineNumber":"we-105","handType":"left"}\'', 'green');
  console.log('');

  subsection('6. 解绑 SN');
  log('curl -X POST http://10.5.51.216:8765/api/sn-registry/WGJ001234/unbind', 'green');
  console.log('');

  subsection('7. 标记为损坏');
  log('curl -X POST http://10.5.51.216:8765/api/sn-registry/WGJ001234/damage \\', 'green');
  log('  -H "Content-Type: application/json" \\', 'green');
  log('  -d \'{"damageReason":"传感器失灵"}\'', 'green');
  console.log('');
}

// ==================== 主函数 ====================

async function main() {
  console.clear();

  log('╔════════════════════════════════════════════════════════════╗', 'bright');
  log('║          GMS 手套 SN 验证功能 - 完整测试演示               ║', 'bright');
  log('╚════════════════════════════════════════════════════════════╝', 'bright');
  console.log('');

  log('这个脚本将演示 SN 检测、验证和匹配的完整流程', 'cyan');
  log('包括各种正常和异常场景的处理方式', 'cyan');
  console.log('');

  // 显示测试配置
  log('测试配置：', 'yellow');
  log(`  机器编号: ${TEST_CONFIG.machineNumber}`);
  log(`  后端地址: ${TEST_CONFIG.gmsBackend}`);
  log(`  容器名称: ${TEST_CONFIG.containerName}`);
  console.log('');

  log('按 Enter 键开始测试...', 'bright');
  await new Promise(resolve => {
    process.stdin.once('data', resolve);
  });

  // 执行场景 1 - 实际验证
  try {
    await testScenario1();
  } catch (error) {
    log(`验证过程出错: ${error.message}`, 'red');
    log('这可能是因为：', 'yellow');
    log('  1. GMS 后端服务未运行');
    log('  2. 网络连接问题');
    log('  3. 数据库未初始化');
    console.log('');
    log('请确保后端服务正常运行后重试', 'yellow');
  }

  await sleep(1000);

  // 其他场景 - 仅说明
  await testScenario2();
  await sleep(1000);

  await testScenario3();
  await sleep(1000);

  await testScenario4();
  await sleep(1000);

  await testScenario5();
  await sleep(1000);

  await testScenario6();
  await sleep(1000);

  // 显示数据示例
  showHeartbeatExample();
  await sleep(1000);

  // 显示 API 示例
  showAPIExamples();

  // 总结
  section('功能总结');

  log('✅ SN 检测功能', 'green');
  log('   - 从多个数据源自动检测 SN 码');
  log('   - 支持手套和灵巧手设备');
  console.log('');

  log('✅ SN 验证功能', 'green');
  log('   - 与数据库注册表匹配');
  log('   - 检查绑定关系是否正确');
  log('   - 验证左右手类型');
  log('   - 检查设备状态（可用/损坏/维修中）');
  console.log('');

  log('✅ 自动修复功能', 'green');
  log('   - 自动绑定可用的 SN');
  log('   - 检测并提示异常情况');
  console.log('');

  log('✅ 集成到心跳系统', 'green');
  log('   - 每次心跳携带完整验证信息');
  log('   - 每小时自动重新验证');
  log('   - 验证失败时立即告警');
  console.log('');

  log('✅ 完整的 API 接口', 'green');
  log('   - 查询、注册、更新、删除 SN');
  log('   - 绑定和解绑操作');
  log('   - 标记损坏和维修状态');
  console.log('');

  section('下一步');

  log('1. 在 GMS 后端集成 SN 注册表 API', 'cyan');
  log('   参考: backend-integration/sn-registry-api.js');
  console.log('');

  log('2. 批量导入现有手套的 SN 码', 'cyan');
  log('   参考: INTEGRATION.md - 批量导入 SN 章节');
  console.log('');

  log('3. 部署更新后的心跳客户端到各机器', 'cyan');
  log('   ./quick-deploy.sh');
  console.log('');

  log('4. 在前端添加 SN 管理界面', 'cyan');
  log('   参考: INTEGRATION.md - 前端集成章节');
  console.log('');

  log('测试完成！', 'bright');
}

// 运行
if (require.main === module) {
  main().catch(err => {
    console.error('测试失败:', err);
    process.exit(1);
  });
}

module.exports = { testScenario1, testScenario2, testScenario3 };
