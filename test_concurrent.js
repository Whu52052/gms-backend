/**
 * 手套管理系统 - 200+并发用户压力测试
 * 目标服务器: 123.207.74.164:8765
 *
 * 用法: node test_concurrent.js [并发数] [用例]
 *   例: node test_concurrent.js 200        # 默认200并发
 *   例: node test_concurrent.js 200 all    # 200并发全部测试
 *   例: node test_concurrent.js 200 login  # 仅登录压测
 */

const http = require('http');

const HOST = '123.207.74.164';
const PORT = 8765;
const BASE = `http://${HOST}:${PORT}`;
const CONCURRENT = parseInt(process.argv[2]) || 200;
const SCENARIO = process.argv[3] || 'all';

// ==================== HTTP HELPERS ====================
function request(method, path, body, token) {
  const start = Date.now();
  return new Promise((resolve) => {
    const url = new URL(path, BASE);
    const opts = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method,
      headers: { 'Content-Type': 'application/json' },
      timeout: 120000,
    };
    if (token) opts.headers['Authorization'] = `Bearer ${token}`;

    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        const latency = Date.now() - start;
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data), latency });
        } catch {
          resolve({ status: res.statusCode, body: data.substring(0, 200), latency });
        }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, error: 'Timeout', latency: Date.now() - start }); });
    req.on('error', (e) => resolve({ status: 0, error: e.message, latency: Date.now() - start }));
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// ==================== METRICS ====================
class Metrics {
  constructor(name) { this.name = name; this.results = []; }
  record(r) { this.results.push(r); }
  successRate() {
    // 400 "库存不足" is business logic, not system failure
    const ok = this.results.filter(r =>
      (r.status >= 200 && r.status < 400) ||
      (r.status === 400 && r.body && r.body.error === '库存不足')
    ).length;
    return ((ok / this.results.length) * 100).toFixed(1);
  }
  avgLatency() {
    const sum = this.results.reduce((s, r) => s + (r.latency || 0), 0);
    return Math.round(sum / this.results.length);
  }
  p50() { return this._percentile(0.50); }
  p90() { return this._percentile(0.90); }
  p95() { return this._percentile(0.95); }
  p99() { return this._percentile(0.99); }
  max() { return Math.max(...this.results.map(r => r.latency || 0)); }
  min() { return Math.min(...this.results.map(r => r.latency || 0)); }
  _percentile(p) {
    const sorted = this.results.map(r => r.latency || 0).sort((a, b) => a - b);
    const idx = Math.ceil(sorted.length * p) - 1;
    return sorted[Math.max(0, idx)];
  }
  count() { return this.results.length; }
  summary() {
    return {
      name: this.name,
      total: this.count(),
      successRate: this.successRate() + '%',
      avg: this.avgLatency() + 'ms',
      p50: this.p50() + 'ms',
      p90: this.p90() + 'ms',
      p95: this.p95() + 'ms',
      p99: this.p99() + 'ms',
      min: this.min() + 'ms',
      max: this.max() + 'ms',
    };
  }
}

// ==================== RUNNER ====================
async function runConcurrent(name, count, taskFn, staggerMs = 50) {
  const metrics = new Metrics(name);
  const tasks = [];
  console.log(`  ⏳ ${name}: 启动 ${count} 个并发 (间隔${staggerMs}ms)...`);
  const startTime = Date.now();

  for (let i = 0; i < count; i++) {
    tasks.push((async () => {
      if (staggerMs > 0 && i > 0) await new Promise(r => setTimeout(r, staggerMs * Math.min(i, 50)));
      const r = await taskFn(i);
      metrics.record(r);
      return r;
    })());
  }

  await Promise.all(tasks);
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  const throughput = Math.round(count / (elapsed || 0.01));
  console.log(`  ✅ ${name}: ${count}请求 / ${elapsed}s / ~${throughput} req/s`);
  return { metrics, elapsed, throughput };
}

// ==================== SCENARIOS ====================

// ---- Scenario 1: 登录风暴 ----
async function loginStorm(count) {
  return runConcurrent('登录风暴', count, async (i) => {
    const userIdx = i % 3;
    const users = [
      { username: 'Yunwei', password: 'yunwei1025' },
      { username: 'yunying', password: 'yunying1025' },
      { username: 'admin', password: 'admin123' },
    ];
    return request('POST', '/api/auth/login', users[userIdx]);
  });
}

// ---- Scenario 2: 获取库存(读) ----
async function inventoryReadStorm(count, token) {
  return runConcurrent('库存读取', count, async (i) => {
    return request('GET', '/api/inventory', null, token);
  });
}

// ---- Scenario 3: 获取机器列表(读) ----
async function machineReadStorm(count, token) {
  return runConcurrent('机器列表读取', count, async (i) => {
    return request('GET', '/api/machines', null, token);
  });
}

// ---- Scenario 4: 库存调整(写) ----
async function inventoryWriteStorm(count, token) {
  return runConcurrent('库存调整(写)', count, async (i) => {
    const types = ['left_glove', 'right_glove', 'left_dexterous_hand', 'right_dexterous_hand', 'gripper'];
    const type = types[i % types.length];
    const delta = (i % 3 === 0) ? -1 : 1; // 部分减库存
    return request('POST', `/api/inventory/${type}`, { delta }, token);
  });
}

// ---- Scenario 5: 添加交易(写) ----
async function transactionWriteStorm(count, token) {
  return runConcurrent('添加交易(写)', count, async (i) => {
    const types = ['glove', 'dexterous_hand', 'gripper'];
    const hands = ['left', 'right', null];
    return request('POST', '/api/transactions', {
      equipmentType: types[i % 3],
      handType: hands[i % 3],
      direction: i % 4 === 0 ? 'out' : 'in',
      quantity: (i % 5) + 1,
      snCode: `PERF-SN-${i}-${Date.now().toString(36)}`,
      machineNumber: `PERF-MCH-${i % 50}`,
      updatedBy: `压测用户${i}`,
      timestamp: new Date().toISOString()
    }, token);
  });
}

// ---- Scenario 6: SN查询 ----
async function snReadStorm(count, token) {
  return runConcurrent('SN注册查询', count, async (i) => {
    return request('GET', '/api/sn-registry', null, token);
  });
}

// ---- Scenario 7: 混合读写 ----
async function mixedStorm(count, token) {
  return runConcurrent('混合读写', count, async (i) => {
    const op = i % 10;
    switch (op) {
      case 0: return request('GET', '/api/inventory', null, token);
      case 1: return request('GET', '/api/machines', null, token);
      case 2: return request('GET', '/api/transactions?limit=50', null, token);
      case 3: return request('GET', '/api/sn-registry', null, token);
      case 4: return request('GET', '/api/settings', null, token);
      case 5: return request('GET', '/api/audit-log', null, token);
      case 6: return request('GET', '/api/equipment-config', null, token);
      case 7: return request('GET', '/api/inventory-config', null, token);
      case 8: return request('POST', '/api/inventory/left_glove', { delta: 1 }, token);
      case 9: return request('POST', '/api/inventory/left_glove', { delta: -1 }, token);
      default: return request('GET', '/api/health');
    }
  });
}

// ---- Scenario 8: SSE连接压测 ----
async function sseStorm(count) {
  return new Promise((resolve) => {
    const metrics = new Metrics('SSE连接');
    let connected = 0, done = 0, total = Math.min(count, 100); // cap at 100
    const startTime = Date.now();

    console.log(`  ⏳ SSE连接: 启动 ${total} 个SSE连接...`);

    for (let i = 0; i < total; i++) {
      const opts = {
        hostname: HOST, port: PORT,
        path: '/api/events',
        method: 'GET',
        headers: {
          'Accept': 'text/event-stream',
          'Cache-Control': 'no-cache',
        },
        timeout: 15000,
      };
      const reqStart = Date.now();
      const req = http.request(opts, (res) => {
        if (res.statusCode === 200) {
          connected++;
          metrics.record({ status: 200, latency: Date.now() - reqStart });
        } else {
          metrics.record({ status: res.statusCode, latency: Date.now() - reqStart });
        }

        // Read a bit then disconnect
        let data = '';
        res.on('data', (c) => {
          data += c;
          if (data.includes('connected') || data.length > 200) {
            res.destroy();
            done++;
            if (done >= total) finish();
          }
        });

        setTimeout(() => {
          try { res.destroy(); } catch {}
          done++;
          if (done >= total) finish();
        }, 3000);
      });

      req.on('timeout', () => {
        req.destroy();
        metrics.record({ status: 0, error: 'Timeout', latency: Date.now() - reqStart });
        done++;
        if (done >= total) finish();
      });
      req.on('error', (e) => {
        metrics.record({ status: 0, error: e.message, latency: Date.now() - reqStart });
        done++;
        if (done >= total) finish();
      });
      req.end();
    }

    function finish() {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`  ✅ SSE连接: ${connected}/${total} 连接成功 / ${elapsed}s`);
      resolve({ metrics, elapsed, throughput: Math.round(total / (elapsed || 0.01)) });
    }
  });
}

// ---- Scenario 9: 健康检查(轻量) ----
async function healthStorm(count) {
  return runConcurrent('健康检查', count, async (i) => {
    return request('GET', '/api/health');
  });
}

// ---- Scenario 10: 同步端点(重读) ----
async function syncStorm(count, token) {
  return runConcurrent('全量同步(重)', Math.min(count, 50), async (i) => {
    return request('GET', '/api/sync', null, token);
  });
}

// ==================== MAIN ====================
async function main() {
  console.log(`\n🧤 手套管理系统 并发压力测试`);
  console.log(`   服务器: ${BASE}`);
  console.log(`   并发数: ${CONCURRENT}`);
  console.log(`   场景: ${SCENARIO}`);
  console.log(`   时间: ${new Date().toISOString()}\n`);

  // 先获取token
  console.log('🔑 获取测试Token...');
  const yunweiRes = await request('POST', '/api/auth/login', { username: 'Yunwei', password: 'yunwei1025' });
  const adminRes = await request('POST', '/api/auth/login', { username: 'admin', password: 'admin123' });

  const token = yunweiRes.body?.token || adminRes.body?.token;
  if (!token) {
    console.error('❌ 无法获取token, 测试终止');
    process.exit(1);
  }
  console.log('✅ Token获取成功\n');

  const allMetrics = [];

  // ---- Phase 1: 基础连通性 ----
  console.log('📋 Phase 1: 基础连通性');
  let r = await healthStorm(CONCURRENT);
  allMetrics.push(r.metrics);

  // ---- Phase 2: 登录压力 ----
  console.log('\n📋 Phase 2: 登录压力');
  r = await loginStorm(CONCURRENT);
  allMetrics.push(r.metrics);

  // 登录风暴后重新获取token
  console.log('🔑 重新获取工作Token...');
  const newAdminRes = await request('POST', '/api/auth/login', { username: 'admin', password: 'admin123' });
  const workToken = newAdminRes.body?.token || token;
  if (!workToken) { console.error('❌ 无法重新获取token'); process.exit(1); }
  console.log('✅ 新Token获取成功\n');

  // ---- Warmup: 预热缓存 ----
  console.log('🔥 Phase 2.5: 预热缓存...');
  await request('GET', '/api/machines', null, workToken);
  await request('GET', '/api/sn-registry', null, workToken);
  await request('GET', '/api/sync', null, workToken);
  await request('GET', '/api/equipment-config', null, workToken);
  await request('GET', '/api/inventory-config', null, workToken);
  console.log('✅ 缓存预热完成 (SN/机器/sync/config 已缓存)\n');

  // ---- Phase 3: 读操作压力 (渐进式) ----
  console.log('\n📋 Phase 3: 读操作压力');
  r = await inventoryReadStorm(CONCURRENT, workToken);
  allMetrics.push(r.metrics);

  r = await machineReadStorm(CONCURRENT, workToken);
  allMetrics.push(r.metrics);

  r = await snReadStorm(CONCURRENT, workToken);
  allMetrics.push(r.metrics);

  // ---- Phase 4: 写操作压力 ----
  console.log('\n📋 Phase 4: 写操作压力');
  r = await inventoryWriteStorm(CONCURRENT, workToken);
  allMetrics.push(r.metrics);

  r = await transactionWriteStorm(CONCURRENT, workToken);
  allMetrics.push(r.metrics);

  // ---- Phase 5: 混合读写 ----
  console.log('\n📋 Phase 5: 混合读写');
  r = await mixedStorm(CONCURRENT, workToken);
  allMetrics.push(r.metrics);

  // ---- Phase 6: 重读压力 ----
  console.log('\n📋 Phase 6: 重读压力');
  r = await syncStorm(CONCURRENT, workToken);
  allMetrics.push(r.metrics);

  // ---- Phase 7: SSE ----
  console.log('\n📋 Phase 7: SSE推送压力');
  r = await sseStorm(CONCURRENT);
  allMetrics.push(r.metrics);

  // ---- Phase 8: 第二轮 - 200+ 持续压力 ----
  console.log(`\n📋 Phase 8: 持续混合压力 (${CONCURRENT * 2} 请求)`);
  const batch1 = mixedStorm(CONCURRENT, workToken);
  const batch2 = inventoryReadStorm(CONCURRENT, workToken);
  const [r1, r2] = await Promise.all([batch1, batch2]);
  allMetrics.push(r1.metrics, r2.metrics);

  // ---- 最终报告 ----
  console.log(`\n${'='.repeat(70)}`);
  console.log(`  📊 并发压力测试报告 (${CONCURRENT}+ 并发)`);
  console.log(`${'='.repeat(70)}`);

  console.log(`\n  ${'场景'.padEnd(20)} ${'请求数'.padEnd(8)} ${'成功率'.padEnd(10)} ${'平均'.padEnd(8)} ${'P50'.padEnd(8)} ${'P90'.padEnd(8)} ${'P95'.padEnd(8)} ${'P99'.padEnd(8)} ${'最大'.padEnd(8)}`);
  console.log(`  ${'-'.repeat(86)}`);

  let totalReqs = 0, totalOk = 0;
  for (const m of allMetrics) {
    const s = m.summary();
    const okCount = m.results.filter(r => r.status >= 200 && r.status < 400).length;
    totalReqs += s.total;
    totalOk += okCount;

    console.log(`  ${s.name.padEnd(20)} ${String(s.total).padEnd(8)} ${s.successRate.padEnd(10)} ${s.avg.padEnd(8)} ${s.p50.padEnd(8)} ${s.p90.padEnd(8)} ${s.p95.padEnd(8)} ${s.p99.padEnd(8)} ${s.max.padEnd(8)}`);
  }

  // Error breakdown for failed requests
  const allErrors = new Map();
  for (const m of allMetrics) {
    for (const r of m.results) {
      const isBiz400 = (r.status === 400 && r.body && r.body.error === '库存不足');
      if (!(r.status >= 200 && r.status < 400) && !isBiz400) {
        const key = `HTTP ${r.status}` + (r.error ? ` (${r.error})` : '');
        allErrors.set(key, (allErrors.get(key) || 0) + 1);
      }
    }
  }

  console.log(`\n  ${'='.repeat(70)}`);
  console.log(`  📈 总体统计`);
  console.log(`  ${'='.repeat(70)}`);
  const overallRate = totalReqs > 0 ? ((totalOk / totalReqs) * 100).toFixed(1) : '0';
  console.log(`  总请求数: ${totalReqs}`);
  console.log(`  成功: ${totalOk} | 失败: ${totalReqs - totalOk}`);
  console.log(`  总成功率: ${overallRate}%`);

  if (allErrors.size > 0) {
    console.log(`\n  ❌ 错误分布:`);
    for (const [err, count] of [...allErrors.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`     ${err}: ${count}次`);
    }
  }

  // 评估
  console.log(`\n  ${'='.repeat(70)}`);
  console.log(`  🎯 性能评估`);
  console.log(`  ${'='.repeat(70)}`);

  const successRate = parseFloat(overallRate);
  if (successRate >= 99) {
    console.log(`  ✅ 优秀！成功率 > 99%，系统可以稳定支撑 ${CONCURRENT}+ 并发`);
  } else if (successRate >= 95) {
    console.log(`  ⚠️  良好。成功率 > 95%，但在高并发下存在少量失败`);
  } else if (successRate >= 90) {
    console.log(`  ⚠️  一般。成功率 > 90%，建议优化瓶颈`);
  } else {
    console.log(`  ❌ 需要优化。成功率 ${overallRate}%，系统在 ${CONCURRENT}+ 并发下不稳定`);
  }

  // 延迟建议
  const avgLatencies = allMetrics.map(m => m.avgLatency());
  const overallAvg = Math.round(avgLatencies.reduce((s, v) => s + v, 0) / avgLatencies.length);
  if (overallAvg < 200) {
    console.log(`  ✅ 延迟优秀：平均 ${overallAvg}ms`);
  } else if (overallAvg < 500) {
    console.log(`  ⚠️  延迟正常：平均 ${overallAvg}ms`);
  } else if (overallAvg < 1000) {
    console.log(`  ⚠️  延迟偏高：平均 ${overallAvg}ms，建议优化`);
  } else {
    console.log(`  ❌ 延迟过高：平均 ${overallAvg}ms，需要紧急优化`);
  }

  console.log(`\n💡 建议:`);
  const slowestWrites = allMetrics.filter(m => m.name.includes('写') || m.name.includes('事务'));
  for (const m of slowestWrites) {
    if (m.avgLatency() > 500) {
      console.log(`   ⚠️  "${m.name}" 写操作平均延迟 ${m.avgLatency()}ms，考虑连接池扩容`);
    }
  }
  const syncMetrics = allMetrics.find(m => m.name.includes('同步'));
  if (syncMetrics && syncMetrics.avgLatency() > 1000) {
    console.log(`   ⚠️  同步端点延迟高(${syncMetrics.avgLatency()}ms)，建议加缓存层`);
  }
  console.log(`   📌 当前MySQL连接池上限: 10，若写操作失败率高，建议增加到 20-50`);
  console.log(`   📌 当前HTTP最大连接数: 500，200+并发在范围内`);
  console.log(`   📌 可考虑添加Redis缓存层减少数据库读压力`);
  console.log('');
}

main().catch(err => {
  console.error('💥 压测异常:', err.message);
  process.exit(1);
});
