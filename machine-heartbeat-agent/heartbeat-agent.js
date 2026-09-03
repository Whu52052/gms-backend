#!/usr/bin/env node
/**
 * GMS Machine Heartbeat Agent v1.1.0
 *
 * 职责（只观测、不决策）：
 * 1. 自动检测主机名/IP，识别机器编号（hostname we-xxx → we-xxx）
 * 2. TCP 探测设备连通性：手套 192.168.1.100/101:50001、灵巧手 .110/.111:7447、
 *    机械臂 .190:30003、Quest 头显（ADB）
 * 3. 自动识别手套 SN：WUJI 标定目录 /var/.rdc2/wuji_calib、
 *    importer-staging 容器 /exchange/machine.jsonc
 * 4. 每 30 秒向 GMS 中心 POST /api/edge/heartbeat（Bearer EDGE_TOKEN），
 *    上报"观测到的事实"；绑定/解绑等业务决策由服务端比对 sn_registry 完成
 * 5. 停机时 POST /api/edge/offline
 *
 * 环境变量：
 * - GMS_BACKEND_URL:    GMS 中心地址（默认 http://10.5.51.216:8765）
 * - EDGE_TOKEN:         边缘接入令牌（必填，与服务端 .env 的 EDGE_TOKEN 一致）
 * - MACHINE_NUMBER:     机器编号（默认从 hostname/IP 自动检测）
 * - HEARTBEAT_INTERVAL: 心跳间隔秒（默认 30）
 */

const http = require('http');
const https = require('https');
const os = require('os');
const GloveSNDetector = require('./glove-sn-detector');
const DeviceStatusDetector = require('./device-detector');

const AGENT_VERSION = '1.1.0';

// ==================== CONFIG ====================
const CONFIG = {
  backendUrl: process.env.GMS_BACKEND_URL || 'http://10.5.51.216:8765',
  edgeToken: process.env.EDGE_TOKEN || '',
  machineNumber: process.env.MACHINE_NUMBER || null,
  heartbeatInterval: parseInt(process.env.HEARTBEAT_INTERVAL || '30', 10) * 1000,
  deviceScanInterval: 120 * 1000,   // 设备 TCP/ADB 探测周期
  snRescanInterval: 10 * 60 * 1000, // SN 重新识别周期
  retryInterval: 10 * 1000,
  timeout: 8000,
};

const machineInfo = {
  machineNumber: null,
  hostname: os.hostname(),
  ipAddress: null,
  startTime: new Date().toISOString(),
  // 手套观测状态：默认未连接，必须经探测确认
  gloves: {
    left: { connected: false, lastCheck: null, snCode: null },
    right: { connected: false, lastCheck: null, snCode: null },
  },
  devices: null, // deviceDetector.getDeviceSummary() 输出
};

let deviceDetector = null;
let snDetector = null;

// ==================== MACHINE NUMBER DETECTION ====================
function detectMachineNumber() {
  if (CONFIG.machineNumber) {
    // 系统机器编号约定小写（与 machines 表 we-xxx 一致；服务端也会归一化）
    const num = CONFIG.machineNumber.trim().toLowerCase();
    console.log(`[Config] 使用环境变量指定的机器编号: ${num}`);
    return num;
  }

  const hostname = os.hostname().toLowerCase();
  const match = hostname.match(/we-(\d+)/);
  if (match) {
    const num = match[1].padStart(3, '0');
    const machineNumber = `we-${num}`;
    console.log(`[Detect] 从 hostname 检测到机器编号: ${machineNumber}`);
    return machineNumber;
  }

  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        const ipMatch = iface.address.match(/^10\.5\.51\.(\d+)$/);
        if (ipMatch) {
          const num = ipMatch[1].padStart(3, '0');
          const machineNumber = `we-${num}`;
          console.log(`[Detect] 从 IP 地址检测到机器编号: ${machineNumber} (${iface.address})`);
          machineInfo.ipAddress = iface.address;
          return machineNumber;
        }
      }
    }
  }

  console.warn('[Detect] ⚠️ 无法自动检测机器编号，请设置环境变量 MACHINE_NUMBER');
  return null;
}

function getPrimaryIPAddress() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return '127.0.0.1';
}

// ==================== HTTP REQUEST HELPER ====================
function httpRequest(url, options = {}) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const protocol = urlObj.protocol === 'https:' ? https : http;
    const headers = Object.assign({}, options.headers || {});
    if (CONFIG.edgeToken && !headers.Authorization) {
      headers.Authorization = `Bearer ${CONFIG.edgeToken}`;
    }

    const req = protocol.request({
      hostname: urlObj.hostname,
      port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
      path: urlObj.pathname + urlObj.search,
      method: options.method || 'GET',
      headers,
      timeout: CONFIG.timeout,
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        let body = data;
        try { body = JSON.parse(data); } catch { /* 非 JSON 响应原样返回 */ }
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve({ statusCode: res.statusCode, body });
        } else {
          const err = new Error(`HTTP ${res.statusCode}: ${typeof body === 'string' ? body.slice(0, 200) : JSON.stringify(body)}`);
          err.statusCode = res.statusCode;
          err.body = body;
          reject(err);
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });

    if (options.body) {
      req.write(typeof options.body === 'string' ? options.body : JSON.stringify(options.body));
    }
    req.end();
  });
}

// ==================== PAYLOAD ====================
function buildPayload() {
  const summary = machineInfo.devices;
  return {
    machineNumber: machineInfo.machineNumber,
    hostname: machineInfo.hostname,
    ipAddress: machineInfo.ipAddress || getPrimaryIPAddress(),
    agentVersion: AGENT_VERSION,
    timestamp: new Date().toISOString(),
    host: {
      uptime: process.uptime(),
      platform: os.platform(),
      arch: os.arch(),
      cpus: os.cpus().length,
      totalMemory: os.totalmem(),
      freeMemory: os.freemem(),
    },
    machineType: (summary && summary.machineType) || null,
    devices: {
      gloves: {
        left: {
          connected: !!(summary && summary.gloves && summary.gloves.left),
          snCode: machineInfo.gloves.left.snCode || null,
          ip: '192.168.1.100',
        },
        right: {
          connected: !!(summary && summary.gloves && summary.gloves.right),
          snCode: machineInfo.gloves.right.snCode || null,
          ip: '192.168.1.101',
        },
      },
      dexterousHands: summary && summary.dexterousHands ? {
        left: { connected: !!summary.dexterousHands.left, ip: '192.168.1.110' },
        right: { connected: !!summary.dexterousHands.right, ip: '192.168.1.111' },
      } : null,
      roboticArm: summary && summary.roboticArm ? {
        connected: !!summary.roboticArm.connected, ip: '192.168.1.190',
      } : null,
    },
    quest: summary && summary.quest ? {
      connected: !!summary.quest.connected,
      battery: summary.quest.battery ?? null,
      controllers: summary.questControllers || null,
    } : null,
  };
}

// ==================== HEARTBEAT ====================
async function sendHeartbeat() {
  if (!machineInfo.machineNumber) {
    console.error('[Heartbeat] ❌ 机器编号未设置，跳过心跳');
    return false;
  }
  try {
    const res = await httpRequest(`${CONFIG.backendUrl}/api/edge/heartbeat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildPayload()),
    });
    const alerts = (res.body && res.body.alerts) || [];
    if (alerts.length) {
      console.warn(`[Heartbeat] ⚠️ ${machineInfo.machineNumber} 服务端返回 ${alerts.length} 条告警:`);
      for (const a of alerts) console.warn(`   [${a.level}] ${a.message}`);
    } else {
      console.log(`[Heartbeat] ✅ ${machineInfo.machineNumber} 心跳成功`);
    }
    return true;
  } catch (error) {
    if (error.statusCode === 401 || error.statusCode === 403) {
      console.error('[Heartbeat] ❌ 边缘节点认证失败：请检查 EDGE_TOKEN 是否与服务端一致');
    } else {
      console.error(`[Heartbeat] ❌ 心跳发送失败: ${error.message}`);
    }
    return false;
  }
}

let heartbeatTimer = null;
let consecutiveFailures = 0;
const MAX_FAILURES = 5;

function heartbeatLoop() {
  sendHeartbeat().then((success) => {
    if (success) {
      consecutiveFailures = 0;
    } else {
      consecutiveFailures++;
      if (consecutiveFailures === MAX_FAILURES) {
        console.error(`[Heartbeat] ⚠️ 连续失败 ${consecutiveFailures} 次，请检查网络/后端服务/EDGE_TOKEN`);
      }
    }
    heartbeatTimer = setTimeout(heartbeatLoop, success ? CONFIG.heartbeatInterval : CONFIG.retryInterval);
  });
}

// ==================== 设备 / SN 周期探测 ====================
async function scanDevices() {
  try {
    await deviceDetector.detectAll();
    machineInfo.devices = deviceDetector.getDeviceSummary();
  } catch (e) {
    console.error('[Device] 设备探测异常:', e.message);
  }
}

async function scanSN() {
  try {
    const result = await snDetector.detectAll();
    if (result.left) machineInfo.gloves.left.snCode = result.left;
    if (result.right) machineInfo.gloves.right.snCode = result.right;
  } catch (e) {
    console.error('[SN] SN 识别异常:', e.message);
  }
}

// ==================== HEALTH SERVER ====================
const healthServer = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      agentVersion: AGENT_VERSION,
      machineNumber: machineInfo.machineNumber,
      uptime: process.uptime(),
      consecutiveFailures,
      gloves: machineInfo.gloves,
    }));
  } else if (req.url === '/info') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(buildPayload()));
  } else {
    res.writeHead(404);
    res.end('Not Found');
  }
});

// ==================== GRACEFUL SHUTDOWN ====================
function gracefulShutdown(signal) {
  console.log(`\n[Shutdown] 收到信号 ${signal}，正在优雅关闭...`);
  if (heartbeatTimer) clearTimeout(heartbeatTimer);
  healthServer.close(() => console.log('[Shutdown] 健康检查服务已关闭'));

  httpRequest(`${CONFIG.backendUrl}/api/edge/offline`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ machineNumber: machineInfo.machineNumber }),
  })
    .then(() => console.log('[Shutdown] 离线通知已发送'))
    .catch((err) => console.error('[Shutdown] 离线通知发送失败:', err.message))
    .finally(() => process.exit(0));

  setTimeout(() => { console.error('[Shutdown] 超时，强制退出'); process.exit(1); }, 5000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// ==================== STARTUP ====================
async function main() {
  console.log('==========================================');
  console.log(`   GMS Machine Heartbeat Agent v${AGENT_VERSION}`);
  console.log('==========================================');
  console.log(`Backend URL: ${CONFIG.backendUrl}`);
  console.log(`Heartbeat Interval: ${CONFIG.heartbeatInterval / 1000}s`);
  console.log('------------------------------------------');

  if (!CONFIG.edgeToken) {
    console.error('❌ 启动失败: 未设置 EDGE_TOKEN 环境变量（需与服务端 .env 的 EDGE_TOKEN 一致）');
    process.exit(1);
  }

  machineInfo.machineNumber = detectMachineNumber();
  machineInfo.ipAddress = getPrimaryIPAddress();
  if (!machineInfo.machineNumber) {
    console.error('❌ 启动失败: 无法检测机器编号，请设置 MACHINE_NUMBER=we-100');
    process.exit(1);
  }
  console.log(`✅ 机器编号: ${machineInfo.machineNumber} / 主机: ${machineInfo.hostname} / IP: ${machineInfo.ipAddress}`);

  healthServer.listen(3000, () => console.log('[Health] http://localhost:3000/health'));

  // SN 识别（标定目录 / docker exec，失败不阻塞）
  snDetector = new GloveSNDetector({
    machineNumber: machineInfo.machineNumber,
    gmsBackend: CONFIG.backendUrl,
    containerName: 'importer-staging',
  });
  await scanSN();
  setInterval(scanSN, CONFIG.snRescanInterval);

  // 设备连通性探测
  deviceDetector = new DeviceStatusDetector({ machineNumber: machineInfo.machineNumber });
  await scanDevices();
  setInterval(scanDevices, CONFIG.deviceScanInterval);

  console.log('------------------------------------------');
  await sendHeartbeat();
  heartbeatLoop();
  console.log(`[Heartbeat] 心跳循环已启动（每 ${CONFIG.heartbeatInterval / 1000} 秒）\n`);
}

main().catch((err) => {
  console.error('启动失败:', err);
  process.exit(1);
});
