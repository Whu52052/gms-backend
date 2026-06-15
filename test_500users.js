/**
 * 500用户并发压力测试
 * 使用方法: node test_500users.js [服务器地址] [用户数]
 * 示例: node test_500users.js http://192.168.1.100 500
 */
const http = require('http');
const https = require('https');

const BASE = process.argv[2] || 'http://localhost:8765';
const TOTAL_USERS = parseInt(process.argv[3]) || 500;
const ACTIVE_USERS = Math.floor(TOTAL_USERS * 0.4); // 40% 同时操作
const SSE_USERS = TOTAL_USERS;                       // 全部保持SSE连接

const stats = {
  login: { ok: 0, fail: 0, ms: [] },
  api: { ok: 0, fail: 0, ms: [] },
  sse: { ok: 0, fail: 0 },
  submit: { ok: 0, fail: 0, ms: [] },
};
const tokens = [];

function httpReq(method, path, token, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE);
    const mod = url.protocol === 'https:' ? https : http;
    const options = {
      hostname: url.hostname, port: url.port,
      path: url.pathname + url.search, method,
      headers: { 'Content-Type': 'application/json' },
      timeout: 30000,
    };
    if (token) options.headers['Authorization'] = 'Bearer ' + token;
    const req = mod.request(options, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function sseConnect(token) {
  return new Promise((resolve, reject) => {
    const url = new URL('/api/sse', BASE);
    const mod = url.protocol === 'https:' ? https : http;
    const req = mod.request({
      hostname: url.hostname, port: url.port, path: url.pathname, method: 'GET',
      headers: { 'Authorization': 'Bearer ' + token, 'Accept': 'text/event-stream' },
      timeout: 60000,
    }, (res) => {
      if (res.statusCode === 200) {
        stats.sse.ok++;
        resolve(res);  // Return the response to keep connection alive
      } else {
        stats.sse.fail++;
        reject(new Error(`SSE status ${res.statusCode}`));
      }
    });
    req.on('error', reject);
    req.end();
  });
}

async function main() {
  console.log(`\n🧤 Yunwei 500用户并发压力测试`);
  console.log(`   服务器: ${BASE}`);
  console.log(`   总用户: ${TOTAL_USERS} | 活跃操作: ${ACTIVE_USERS} | SSE连接: ${SSE_USERS}`);
  console.log(`\n⏳ 开始测试...\n`);

  const t0 = Date.now();

  // ====== Phase 1: 登录测试 ======
  console.log(`[Phase 1] 登录 ${TOTAL_USERS} 用户...`);
  const loginStart = Date.now();
  const loginPromises = [];
  for (let i = 0; i < TOTAL_USERS; i++) {
    loginPromises.push((async () => {
      const t1 = Date.now();
      try {
        const res = await httpReq('POST', '/api/auth/login', null, {
          username: 'admin', password: 'admin123'
        });
        if (res.status === 200 && res.body.token) {
          stats.login.ok++;
          tokens.push(res.body.token);
        } else {
          stats.login.fail++;
        }
      } catch { stats.login.fail++; }
      stats.login.ms.push(Date.now() - t1);
    })());
    // Throttle: 50 concurrent login batches
    if (i % 50 === 49) await Promise.all(loginPromises.slice(-50));
  }
  await Promise.all(loginPromises);
  const loginTime = Date.now() - loginStart;
  const loginAvg = stats.login.ms.reduce((a,b)=>a+b,0) / stats.login.ms.length;
  console.log(`  ✅ 登录完成: ${stats.login.ok}/${TOTAL_USERS} 成功 (${loginTime}ms, 平均${loginAvg.toFixed(0)}ms)`);

  // ====== Phase 2: API 并发测试 ======
  console.log(`[Phase 2] API 查询 ${ACTIVE_USERS} 并发...`);
  const apiStart = Date.now();
  const apiPromises = [];
  const apiPaths = ['/api/machines', '/api/inventory', '/api/equipment-config', '/api/sn-registry'];
  for (let i = 0; i < ACTIVE_USERS; i++) {
    const token = tokens[i % tokens.length];
    const path = apiPaths[i % apiPaths.length];
    apiPromises.push((async () => {
      const t1 = Date.now();
      try {
        const res = await httpReq('GET', path, token);
        if (res.status === 200) stats.api.ok++;
        else stats.api.fail++;
      } catch { stats.api.fail++; }
      stats.api.ms.push(Date.now() - t1);
    })());
  }
  await Promise.all(apiPromises);
  const apiTime = Date.now() - apiStart;
  const apiAvg = stats.api.ms.reduce((a,b)=>a+b,0) / stats.api.ms.length;
  const apiMax = Math.max(...stats.api.ms);
  console.log(`  ✅ API完成: ${stats.api.ok}/${ACTIVE_USERS} 成功 (${apiTime}ms, 平均${apiAvg.toFixed(0)}ms, 最慢${apiMax}ms)`);

  // ====== Phase 3: SSE 连接测试 ======
  console.log(`[Phase 3] SSE 连接 ${Math.min(SSE_USERS, 100)} 路...`);
  const sseConnections = [];
  for (let i = 0; i < Math.min(SSE_USERS, 100); i++) {
    const token = tokens[i % tokens.length];
    sseConnections.push(sseConnect(token).catch(() => {}));
  }
  await Promise.all(sseConnections);
  console.log(`  ✅ SSE: ${stats.sse.ok} 连接成功`);

  // ====== Phase 4: 提交操作测试 ======
  console.log(`[Phase 4] 操作提交 ${Math.floor(ACTIVE_USERS/2)} 并发...`);
  const submitStart = Date.now();
  const submitPromises = [];
  for (let i = 0; i < Math.floor(ACTIVE_USERS / 2); i++) {
    const token = tokens[i % tokens.length];
    submitPromises.push((async () => {
      const t1 = Date.now();
      try {
        const res = await httpReq('POST', '/api/tech-support', token, {
          equipmentType: 'glove',
          equipmentTypeName: '纯手套设备',
          machineId: 'TEST-M-' + i,
          machineNumber: 'TEST-M-' + i,
          faultType: '测试故障',
          faultDescription: '压力测试自动提交',
        });
        if (res.status === 200 && res.body.success) stats.submit.ok++;
        else stats.submit.fail++;
      } catch { stats.submit.fail++; }
      stats.submit.ms.push(Date.now() - t1);
    })());
  }
  await Promise.all(submitPromises);
  const submitTime = Date.now() - submitStart;
  const submitAvg = stats.submit.ms.reduce((a,b)=>a+b,0) / (stats.submit.ms.length || 1);
  console.log(`  ✅ 提交: ${stats.submit.ok}/${Math.floor(ACTIVE_USERS/2)} 成功 (${submitTime}ms, 平均${submitAvg.toFixed(0)}ms)`);

  // ====== Summary ======
  const total = Date.now() - t0;
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  📊 测试总结 (${(total/1000).toFixed(1)}s)`);
  console.log(`  ┌─────────────┬────────┬────────┬──────────┐`);
  console.log(`  │ 阶段         │ 成功   │ 失败   │ 耗时     │`);
  console.log(`  ├─────────────┼────────┼────────┼──────────┤`);
  console.log(`  │ 登录         │ ${pad(stats.login.ok,6)} │ ${pad(stats.login.fail,6)} │ ${pad(loginAvg.toFixed(0)+'ms',8)} │`);
  console.log(`  │ API查询      │ ${pad(stats.api.ok,6)} │ ${pad(stats.api.fail,6)} │ ${pad(apiAvg.toFixed(0)+'ms',8)} │`);
  console.log(`  │ SSE连接      │ ${pad(stats.sse.ok,6)} │ ${pad(stats.sse.fail,6)} │      -   │`);
  console.log(`  │ 操作提交     │ ${pad(stats.submit.ok,6)} │ ${pad(stats.submit.fail,6)} │ ${pad(submitAvg.toFixed(0)+'ms',8)} │`);
  console.log(`  └─────────────┴────────┴────────┴──────────┘`);
  console.log(`\n  💡 判定标准:`);
  if (apiAvg < 500) console.log(`     API平均延迟 ${apiAvg.toFixed(0)}ms ✅ 优秀 (<500ms)`);
  else if (apiAvg < 1000) console.log(`     API平均延迟 ${apiAvg.toFixed(0)}ms ⚠️ 可接受 (<1000ms)`);
  else console.log(`     API平均延迟 ${apiAvg.toFixed(0)}ms ❌ 需要优化 (>1000ms)`);

  if (stats.api.fail === 0) console.log(`     零失败率 ✅`);
  else console.log(`     失败率 ${(stats.api.fail/(stats.api.ok+stats.api.fail)*100).toFixed(1)}% ⚠️`);

  // Cleanup
  sseConnections.forEach(c => { try { c.destroy(); } catch {} });
  process.exit(0);
}

function pad(v, n) { return String(v).padStart(n); }

main().catch(e => { console.error('测试异常:', e.message); process.exit(1); });
