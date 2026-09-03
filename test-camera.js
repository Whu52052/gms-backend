#!/usr/bin/env node
/**
 * 摄像头检测测试脚本
 */

const CameraMonitor = require('./machine-heartbeat-agent/camera-monitor');

async function main() {
  console.log('==========================================');
  console.log('  摄像头检测测试');
  console.log('==========================================');
  console.log('');

  const monitor = new CameraMonitor({
    checkInterval: 10000,
    expectedFPS: 30,
    fpsThreshold: 0.8,
  });

  console.log('[Test] 开始检测摄像头设备...');
  const cameras = await monitor.detectCameras();

  console.log('');
  console.log(`[Test] 检测到 ${cameras.length} 个摄像头设备：`);
  console.log('');

  cameras.forEach((camera, index) => {
    console.log(`摄像头 ${index + 1}:`);
    console.log(`  设备: ${camera.device}`);
    console.log(`  名称: ${camera.name}`);
    console.log(`  最大帧率: ${camera.maxFPS} fps`);
    console.log('');
  });

  console.log('[Test] 开始监控摄像头帧率（按 Ctrl+C 停止）...');
  console.log('');

  monitor.startMonitoring((status) => {
    const icon = status.isDropping ? '❌' : '✅';
    console.log(`${icon} ${status.camera}: ${status.fps.toFixed(1)} fps ${status.isDropping ? '(掉帧!)' : ''}`);
  });
}

main().catch(err => {
  console.error('测试失败:', err);
  process.exit(1);
});
