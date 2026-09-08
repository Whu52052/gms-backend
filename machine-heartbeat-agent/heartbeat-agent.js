const http = require('http');
const https = require('https');
const os = require('os');
const GloveSNDetector = require('./glove-sn-detector');
const DeviceStatusDetector = require('./device-detector');
const { CollectorApiPoller } = require('./collector-api');

const AGENT_VERSION = '1.2.0';

const CONFIG = {
  backendUrl: process.env.GMS_BACKEND_URL || 'http://10.5.51.216:8765',
  edgeToken: process.env.EDGE_TOKEN || '',
  machineNumber: process.env.MACHINE_NUMBER || null,
  importerUrl: process.env.IMPORTER_API_URL || process.env.IMPORTER_URL || 'http://127.0.0.1:5025',
  hermesUrl: process.env.HERMES_API_URL || process.env.HERMES_URL || 'http://127.0.0.1:5006',
  heartbeatInterval: parseInt(process.env.HEARTBEAT_INTERVAL || '30', 10) * 1000,
  deviceScanInterval: 120 * 1000,
  snRescanInterval: 10 * 60 * 1000,
  retryInterval: 10 * 1000,
  timeout: 8000,
  collectorTimeout: parseInt(process.env.COLLECTOR_API_TIMEOUT || '3000', 10),
};

const machineInfo = {
  machineNumber: null,
  hostname: os.hostname(),
  ipAddress: null,
  startTime: new Date().toISOString(),

  gloves: {
    left: { connected: false, lastCheck: null, snCode: null },
    right: { connected: false, lastCheck: null, snCode: null },
  },
  devices: null,
  cameraFps: null,
  handStream: null,
  importer: null,
  hermes: null,
};

let deviceDetector = null;
let snDetector = null;

function detectMachineNumber() {
  if (CONFIG.machineNumber) {

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

function httpRequest(url, options = {}) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const protocol = urlObj.protocol === 'https:' ? https : http;
    const headers = Object.assign({}, options.headers || {});
    if (CONFIG.edgeToken && options.includeEdgeAuth !== false && !headers.Authorization) {
      headers.Authorization = `Bearer ${CONFIG.edgeToken}`;
    }

    const req = protocol.request({
      hostname: urlObj.hostname,
      port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
      path: urlObj.pathname + urlObj.search,
      method: options.method || 'GET',
      headers,
      timeout: options.timeout || CONFIG.timeout,
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        let body = data;
        try { body = JSON.parse(data); } catch {                     }
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

const collectorApi = new CollectorApiPoller({
  importerUrl: CONFIG.importerUrl,
  hermesUrl: CONFIG.hermesUrl,
  timeout: CONFIG.collectorTimeout,
  request: httpRequest,
});

let collectorPollAt = 0;
let collectorPollPromise = null;

async function pollCollectorApis(force = false) {
  const now = Date.now();
  if (!force && collectorPollAt && now - collectorPollAt < CONFIG.heartbeatInterval) return;
  if (collectorPollPromise) return collectorPollPromise;
  collectorPollPromise = collectorApi.poll()
    .then(snapshot => {
      machineInfo.importer = snapshot.importer;
      machineInfo.hermes = snapshot.hermes;
      collectorPollAt = Date.now();
      return snapshot;
    })
    .catch(error => {

      console.error('[Collector] API 轮询异常:', error.message);
      collectorPollAt = Date.now();
      return null;
    })
    .finally(() => { collectorPollPromise = null; });
  return collectorPollPromise;
}

function _execAsync(cmd, opts) {
  return new Promise((resolve, reject) => {
    require('child_process').exec(cmd, opts, (err, stdout) => {
      if (err && !stdout) return reject(err);
      resolve({ stdout: stdout || '' });
    });
  });
}

async function scanEncoderFps() {
  const container = process.env.COLLECTOR_CONTAINER || 'mono-staging';
  try {
    const { stdout } = await _execAsync(
      `docker logs --tail 4000 ${container} 2>&1 | grep -aE "Video encoder output" | tail -1`,
      { timeout: 8000, maxBuffer: 8 * 1024 * 1024 }
    );
    const line = (stdout || '').trim().split('\n').filter(Boolean).pop() || '';
    const m = line.match(/Video encoder output\s+(\d+(?:\.\d+)?)\s*fps/i);
    if (!m) { machineInfo.cameraFps = null; return; }
    const fps = parseFloat(m[1]);

    let logTimeUnix = null, ageSec = null;
    const ts = line.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?/);
    if (ts) {
      const ms = ts[7] ? parseInt(String(ts[7]).slice(0, 3).padEnd(3, '0'), 10) : 0;
      logTimeUnix = Math.floor(Date.UTC(+ts[1], +ts[2] - 1, +ts[3], +ts[4], +ts[5], +ts[6], ms) / 1000);
      const age = Math.round(Date.now() / 1000) - logTimeUnix;

      if (age >= -120 && age < 7 * 86400) ageSec = Math.max(0, age);
    }
    machineInfo.cameraFps = { fps, logTimeUnix, ageSec, container };
    console.log(`[CameraFps] 编码器输出 ${fps} fps${ageSec != null ? `（${ageSec} 秒前日志）` : ''}`);
  } catch (e) {
    console.error('[CameraFps] 日志提取失败:', e.message);
  }
}

async function scanHandStream() {
  const numMatch = /^(?:we|szx3)-(\d+)$/.exec(String(machineInfo.machineNumber || ''));
  if (numMatch && parseInt(numMatch[1], 10) < 100) { machineInfo.handStream = null; return; }
  const container = process.env.COLLECTOR_CONTAINER || 'mono-staging';
  try {
    const { stdout } = await _execAsync(
      `docker logs --tail 2000 ${container} 2>&1 | grep -aE "WujiHand2.*command stream" | tail -4`,
      { timeout: 8000, maxBuffer: 8 * 1024 * 1024 }
    );
    const out = {};
    for (const line of (stdout || '').trim().split('\n').filter(Boolean)) {
      const sideM = line.match(/wuji_hand_(l|r)/);
      if (!sideM) continue;
      const side = sideM[1] === 'l' ? 'left' : 'right';

      const hzM = line.match(/command stream(?:er)?\s+(?:at\s+)?([\d.]+)\s*Hz/i);
      const targetM = line.match(/\(target\s+([\d.]+)\)/i);
      const lateM = line.match(/(\d+)\s+of\s+(\d+)\s+ticks late/i);
      let logTimeUnix = null, ageSec = null;
      const ts = line.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?/);
      if (ts) {
        const ms = ts[7] ? parseInt(String(ts[7]).slice(0, 3).padEnd(3, '0'), 10) : 0;
        logTimeUnix = Math.floor(Date.UTC(+ts[1], +ts[2] - 1, +ts[3], +ts[4], +ts[5], +ts[6], ms) / 1000);
        const age = Math.round(Date.now() / 1000) - logTimeUnix;
        if (age >= -120 && age < 7 * 86400) ageSec = Math.max(0, age);
      }

      const prev = out[side];
      const isStats = !!(lateM || targetM);
      if (prev && !isStats && prev.logTimeUnix && logTimeUnix && prev.logTimeUnix >= logTimeUnix) continue;
      out[side] = {
        hz: hzM ? parseFloat(hzM[1]) : (prev && prev.hz) || null,
        target: targetM ? parseFloat(targetM[1]) : (isStats ? null : (prev && prev.target) || null),
        lateTicks: lateM ? parseInt(lateM[1], 10) : null,
        totalTicks: lateM ? parseInt(lateM[2], 10) : null,
        logTimeUnix, ageSec,
      };
    }
    machineInfo.handStream = (out.left || out.right) ? out : null;
    if (out.left || out.right) console.log(`[HandStream] ${JSON.stringify(machineInfo.handStream)}`);
  } catch (e) {
    console.error('[HandStream] 日志提取失败:', e.message);
  }
}

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
    cameraFps: machineInfo.cameraFps || null,
    handStream: machineInfo.handStream || null,
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
        left: { connected: !!summary.dexterousHands.left, ip: '192.168.1.110', snCode: (machineInfo.handsSN && machineInfo.handsSN.left) || null },
        right: { connected: !!summary.dexterousHands.right, ip: '192.168.1.111', snCode: (machineInfo.handsSN && machineInfo.handsSN.right) || null },
      } : null,
      roboticArm: summary && summary.roboticArm ? {
        connected: !!summary.roboticArm.connected, ip: '192.168.1.190',
      } : null,
    },
    quest: summary && summary.quest ? {
      connected: !!summary.quest.connected,
      serialNumber: summary.quest.serialNumber || null,
      adbStatus: summary.quest.error || (summary.quest.connected ? 'device' : null),
      battery: summary.quest.battery ?? null,
      controllers: summary.questControllers || null,
    } : null,
    importer: machineInfo.importer,
    hermes: machineInfo.hermes,
  };
}

async function sendHeartbeat() {
  if (!machineInfo.machineNumber) {
    console.error('[Heartbeat] ❌ 机器编号未设置，跳过心跳');
    return false;
  }
  try {
    await pollCollectorApis();
    await scanEncoderFps();
    await scanHandStream();
    const payload = buildPayload();
    console.log('[Heartbeat] 发送数据:', JSON.stringify(payload, null, 2));
    const res = await httpRequest(`${CONFIG.backendUrl}/api/edge/heartbeat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
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
    if (result.handLeft || result.handRight) {
      machineInfo.handsSN = { left: result.handLeft || null, right: result.handRight || null };
    }
  } catch (e) {
    console.error('[SN] SN 识别异常:', e.message);
  }
}

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
      importer: machineInfo.importer ? {
        reachable: machineInfo.importer.reachable,
        checkedAt: machineInfo.importer.checkedAt,
        error: machineInfo.importer.error || null,
      } : null,
      hermes: machineInfo.hermes ? {
        reachable: machineInfo.hermes.reachable,
        checkedAt: machineInfo.hermes.checkedAt,
        error: machineInfo.hermes.error || null,
      } : null,
    }));
  } else if (req.url === '/info') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(buildPayload()));
  } else {
    res.writeHead(404);
    res.end('Not Found');
  }
});

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

async function main() {
  console.log('==========================================');
  console.log(`   GMS Machine Heartbeat Agent v${AGENT_VERSION}`);
  console.log('==========================================');
  console.log(`Backend URL: ${CONFIG.backendUrl}`);
  console.log(`Importer API: ${CONFIG.importerUrl}`);
  console.log(`Hermes API: ${CONFIG.hermesUrl}`);
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

  snDetector = new GloveSNDetector({
    machineNumber: machineInfo.machineNumber,
    gmsBackend: CONFIG.backendUrl,
    containerName: process.env.IMPORTER_CONTAINER || 'importer-staging',
    collectorContainer: process.env.COLLECTOR_CONTAINER || 'mono-staging',
  });
  await scanSN();
  setInterval(scanSN, CONFIG.snRescanInterval);

  deviceDetector = new DeviceStatusDetector({ machineNumber: machineInfo.machineNumber });
  await scanDevices();
  setInterval(scanDevices, CONFIG.deviceScanInterval);

  console.log('------------------------------------------');
  await pollCollectorApis(true);
  await sendHeartbeat();
  heartbeatLoop();
  console.log(`[Heartbeat] 心跳循环已启动（每 ${CONFIG.heartbeatInterval / 1000} 秒）\n`);
}

main().catch((err) => {
  console.error('启动失败:', err);
  process.exit(1);
});
