#!/usr/bin/env node
/**
 * 设备检测完整测试脚本
 *
 * 测试所有设备的检测功能
 */

const DeviceStatusDetector = require('./machine-heartbeat-agent/device-detector');

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

function printDeviceStatus(name, status) {
  if (status.connected) {
    log(`  ✅ ${name}: 在线`, 'green');
    if (status.latency) {
      log(`     延迟: ${status.latency}ms`, 'cyan');
    }
  } else {
    log(`  ❌ ${name}: 离线`, 'red');
    if (status.error) {
      log(`     错误: ${status.error}`, 'yellow');
    }
  }
}

async function main() {
  log('╔════════════════════════════════════════════════════════════╗', 'bright');
  log('║          GMS 设备检测功能 - 完整测试                       ║', 'bright');
  log('╚════════════════════════════════════════════════════════════╝', 'bright');
  console.log('');

  log('此脚本将测试所有设备的检测功能：', 'cyan');
  log('  1. 手套（左右）', 'cyan');
  log('  2. 灵巧手（左右）', 'cyan');
  log('  3. 机械臂', 'cyan');
  log('  4. Quest 头显', 'cyan');
  log('  5. Quest 手柄（左右）', 'cyan');
  console.log('');

  // 初始化检测器
  const detector = new DeviceStatusDetector({
    machineNumber: 'we-test',
  });

  // 执行检测
  const status = await detector.detectAll();

  // 显示结果摘要
  log('', 'reset');
  log('========================================', 'cyan');
  log('  检测结果摘要', 'bright');
  log('========================================', 'cyan');
  console.log('');

  // 机器类型
  const machineTypeLabel = status.machineType === 'dexterous' ? '灵巧手机器' : '纯手套机器';
  log(`机器类型: ${machineTypeLabel}`, 'bright');
  console.log('');

  // 手套
  log('手套:', 'bright');
  printDeviceStatus('左手', status.gloves.left);
  printDeviceStatus('右手', status.gloves.right);
  console.log('');

  // 灵巧手
  if (status.machineType === 'dexterous') {
    log('灵巧手:', 'bright');
    printDeviceStatus('左手', status.dexterousHands.left);
    printDeviceStatus('右手', status.dexterousHands.right);
    console.log('');

    // 机械臂
    log('机械臂:', 'bright');
    printDeviceStatus('机械臂', status.roboticArm);
    console.log('');

    // Quest 头显
    log('Quest 头显:', 'bright');
    if (status.quest.connected) {
      log('  ✅ 在线', 'green');
      log(`     序列号: ${status.quest.serialNumber}`, 'cyan');
      if (status.quest.battery) {
        const batteryColor = status.quest.battery.level > 20 ? 'green' : 'red';
        log(`     电量: ${status.quest.battery.level}%`, batteryColor);
        log(`     状态: ${status.quest.battery.status}`, 'cyan');
        if (status.quest.battery.temperature) {
          log(`     温度: ${status.quest.battery.temperature}°C`, 'cyan');
        }
      }
    } else {
      log('  ❌ 离线', 'red');
      log(`     错误: ${status.quest.error}`, 'yellow');

      // 给出建议
      if (status.quest.error === 'adb_not_installed') {
        log('', 'reset');
        log('  💡 建议: 安装 ADB 工具', 'yellow');
        log('     Ubuntu: sudo apt install android-tools-adb', 'yellow');
        log('     macOS: brew install android-platform-tools', 'yellow');
      } else if (status.quest.error === 'no_device') {
        log('', 'reset');
        log('  💡 建议: 检查 Quest 连接', 'yellow');
        log('     1. Quest 是否通过 USB 连接到主机', 'yellow');
        log('     2. Quest 是否开启开发者模式', 'yellow');
        log('     3. Quest 是否授权 USB 调试', 'yellow');
      }
    }
    console.log('');

    // Quest 手柄
    if (status.quest.connected && status.questControllers) {
      log('Quest 手柄:', 'bright');
      const leftColor = status.questControllers.left?.level > 20 ? 'green' : 'red';
      const rightColor = status.questControllers.right?.level > 20 ? 'green' : 'red';

      if (status.questControllers.left?.level) {
        log(`  左手柄: ${status.questControllers.left.level}%`, leftColor);
      } else {
        log(`  左手柄: 电量未知`, 'yellow');
      }

      if (status.questControllers.right?.level) {
        log(`  右手柄: ${status.questControllers.right.level}%`, rightColor);
      } else {
        log(`  右手柄: 电量未知`, 'yellow');
      }
      console.log('');
    }
  }

  // 心跳数据预览
  log('========================================', 'cyan');
  log('  心跳数据预览', 'bright');
  log('========================================', 'cyan');
  console.log('');

  const summary = detector.getDeviceSummary();
  console.log(JSON.stringify(summary, null, 2));
  console.log('');

  // 设备健康度评估
  log('========================================', 'cyan');
  log('  设备健康度评估', 'bright');
  log('========================================', 'cyan');
  console.log('');

  let healthScore = 0;
  let maxScore = 0;
  const issues = [];

  // 手套（必需）
  maxScore += 2;
  if (status.gloves.left.connected) healthScore++;
  else issues.push('左手手套离线');

  if (status.gloves.right.connected) healthScore++;
  else issues.push('右手手套离线');

  // 灵巧手机器的额外设备
  if (status.machineType === 'dexterous') {
    maxScore += 5; // 灵巧手x2 + 机械臂 + Quest + 手柄

    if (status.dexterousHands.left.connected) healthScore++;
    else issues.push('左手灵巧手离线');

    if (status.dexterousHands.right.connected) healthScore++;
    else issues.push('右手灵巧手离线');

    if (status.roboticArm.connected) healthScore++;
    else issues.push('机械臂离线');

    if (status.quest.connected) {
      healthScore++;
      if (status.quest.battery && status.quest.battery.level < 20) {
        issues.push(`Quest 电量低 (${status.quest.battery.level}%)`);
      }
    } else {
      issues.push('Quest 头显离线');
    }

    if (status.questControllers) {
      healthScore += 0.5; // 手柄不是关键设备
      if (status.questControllers.left?.level && status.questControllers.left.level < 20) {
        issues.push(`左手柄电量低 (${status.questControllers.left.level}%)`);
      }
      if (status.questControllers.right?.level && status.questControllers.right.level < 20) {
        issues.push(`右手柄电量低 (${status.questControllers.right.level}%)`);
      }
    }
  }

  const healthPercent = Math.round((healthScore / maxScore) * 100);
  const healthColor = healthPercent >= 80 ? 'green' : healthPercent >= 50 ? 'yellow' : 'red';

  log(`健康度: ${healthPercent}% (${healthScore}/${maxScore})`, healthColor);
  console.log('');

  if (issues.length > 0) {
    log('⚠️  发现问题:', 'yellow');
    issues.forEach(issue => log(`   - ${issue}`, 'red'));
    console.log('');
  } else {
    log('✅ 所有设备正常', 'green');
    console.log('');
  }

  // 建议
  log('========================================', 'cyan');
  log('  建议', 'bright');
  log('========================================', 'cyan');
  console.log('');

  if (issues.length === 0) {
    log('设备状态良好，可以正常使用', 'green');
  } else {
    log('请处理以下问题以确保系统正常运行：', 'yellow');
    console.log('');

    if (issues.some(i => i.includes('手套'))) {
      log('1. 检查手套网络连接', 'yellow');
      log('   ping 192.168.1.100', 'cyan');
      log('   ping 192.168.1.101', 'cyan');
      console.log('');
    }

    if (issues.some(i => i.includes('灵巧手'))) {
      log('2. 检查灵巧手网络连接', 'yellow');
      log('   ping 192.168.1.110', 'cyan');
      log('   ping 192.168.1.111', 'cyan');
      console.log('');
    }

    if (issues.some(i => i.includes('机械臂'))) {
      log('3. 检查机械臂连接', 'yellow');
      log('   ping 192.168.1.120', 'cyan');
      log('   检查机械臂控制器是否启动', 'cyan');
      console.log('');
    }

    if (issues.some(i => i.includes('Quest'))) {
      log('4. 检查 Quest 连接', 'yellow');
      log('   adb devices', 'cyan');
      log('   确保 Quest 已开启 USB 调试并授权', 'cyan');
      console.log('');
    }

    if (issues.some(i => i.includes('电量'))) {
      log('5. 充电建议', 'yellow');
      log('   建议设备电量低于 20% 时及时充电', 'cyan');
      console.log('');
    }
  }

  log('测试完成！', 'bright');
  console.log('');
  log('提示: 此检测结果会自动包含在心跳数据中上报到 GMS 后端', 'cyan');
}

main().catch(err => {
  console.error('测试失败:', err);
  process.exit(1);
});
