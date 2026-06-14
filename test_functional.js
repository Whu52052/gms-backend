/**
 * 手套管理系统 - 全功能测试脚本
 * 目标服务器: 123.207.74.164:8765
 *
 * 用法: node test_functional.js
 */

const http = require('http');
const https = require('https');

const HOST = '123.207.74.164';
const PORT = 8765;
const BASE = `http://${HOST}:${PORT}`;

// ==================== HTTP HELPERS ====================
function request(method, path, body, token) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE);
    const opts = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method,
      headers: { 'Content-Type': 'application/json' },
      timeout: 30000,
    };
    if (token) opts.headers['Authorization'] = `Bearer ${token}`;

    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve({ status: res.statusCode, body: parsed, headers: res.headers });
        } catch {
          resolve({ status: res.statusCode, body: data.substring(0, 500), headers: res.headers });
        }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

const api = {
  get: (path, token) => request('GET', path, null, token),
  post: (path, body, token) => request('POST', path, body, token),
  put: (path, body, token) => request('PUT', path, body, token),
  del: (path, token) => request('DELETE', path, null, token),
};

// ==================== TEST STATE ====================
let PASS = 0, FAIL = 0, SKIP = 0;
const tokens = {};    // userId -> token
const testData = {};  // store created test data for cleanup

function ok(name) { PASS++; }
function no(name, reason) { FAIL++; console.log(`  ✗ ${name}${reason ? ' — ' + reason : ''}`); }
function skip(name, reason) { SKIP++; console.log(`  ⊘ ${name} (跳过: ${reason})`); }

function assert(name, condition, reason) {
  if (condition) ok(name); else no(name, reason);
}

function header(name) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  ${name}`);
  console.log(`${'='.repeat(60)}`);
}

// ==================== MAIN ====================
async function main() {
  console.log(`\n🧤 手套管理系统 全功能测试`);
  console.log(`   服务器: ${BASE}`);
  console.log(`   时间: ${new Date().toISOString()}\n`);

  // ---- 1. 健康检查 & 基础连通性 ----
  header('1. 健康检查 & 基础连通性');

  let res = await api.get('/api/health');
  assert('1.1 健康检查 /api/health', res.status === 200 && res.body.status === 'ok',
    `status=${res.status}, body=${JSON.stringify(res.body)}`);
  assert('1.2 运行时间 > 0', res.body.uptime > 0, `uptime=${res.body.uptime}`);

  // ---- 2. 认证模块 ----
  header('2. 认证 (Auth)');

  // 2.1 正确登录
  res = await api.post('/api/auth/login', { username: 'Yunwei', password: 'yunwei1025' });
  assert('2.1 登录成功(Yunwei)', res.status === 200 && res.body.token,
    `status=${res.status}, hasToken=${!!res.body.token}`);
  if (res.body.token) {
    tokens['sa-001'] = res.body.token;
    testData.yunweiToken = res.body.token;
    assert('2.1b 返回用户信息', res.body.user && res.body.user.username === 'Yunwei',
      JSON.stringify(res.body.user));
  } else { skip('2.1后续', '无token'); }

  // 2.2 错误密码
  res = await api.post('/api/auth/login', { username: 'Yunwei', password: 'wrong' });
  assert('2.2 错误密码被拒', res.status === 401 && res.body.error,
    `status=${res.status}, body=${JSON.stringify(res.body)}`);

  // 2.3 不存在用户
  res = await api.post('/api/auth/login', { username: 'nobody_fake_user', password: 'x' });
  assert('2.3 不存在用户被拒', res.status === 401 && res.body.error,
    `status=${res.status}`);

  // 2.4 登录运营用户
  res = await api.post('/api/auth/login', { username: 'yunying', password: 'yunying1025' });
  assert('2.4 登录成功(yunying)', res.status === 200 && res.body.token,
    `status=${res.status}`);
  if (res.body.token) {
    tokens['sa-002'] = res.body.token;
    testData.yunyingToken = res.body.token;
  } else { skip('yunying后续', '无token'); }

  // 2.5 未授权访问
  res = await api.get('/api/inventory');
  assert('2.5 无token被拒', res.status === 401,
    `status=${res.status}, body=${JSON.stringify(res.body)}`);

  // 2.6 无效token
  res = await api.get('/api/inventory', null, 'invalid_token_123');
  assert('2.6 无效token被拒', res.status === 401,
    `status=${res.status}`);

  // ---- 3. 用户管理 ----
  header('3. 用户管理 (Users)');

  const adminToken = tokens['sa-001'] || testData.yunweiToken;
  if (!adminToken) { skip('3.x 所有用户测试', '无管理员token'); } else {
    // 3.1 获取用户列表
    res = await api.get('/api/users', adminToken);
    assert('3.1 获取用户列表', res.status === 200 && Array.isArray(res.body),
      `status=${res.status}, isArray=${Array.isArray(res.body)}`);
    if (Array.isArray(res.body)) {
      console.log(`    用户数: ${res.body.length}`);
      testData.userCount = res.body.length;
    }

    // 3.2 添加用户
    const testUsername = 'test_user_' + Date.now().toString(36);
    res = await api.post('/api/users', {
      username: testUsername,
      password: 'test1234',
      role: 'user',
      system: 'maintenance',
      displayName: '测试用户'
    }, adminToken);
    assert('3.2 添加用户', res.status === 200 && res.body.success,
      `status=${res.status}, body=${JSON.stringify(res.body)}`);
    if (res.body.user) {
      testData.newUserId = res.body.user.id;
      testData.newUsername = testUsername;
      console.log(`    新用户ID: ${res.body.user.id}`);
    }

    // 3.3 重复用户名
    res = await api.post('/api/users', {
      username: testUsername,
      password: 'test1234',
      role: 'user'
    }, adminToken);
    assert('3.3 重复用户名被拒', res.status === 400 && res.body.error,
      `status=${res.status}, body=${JSON.stringify(res.body)}`);

    // 3.4 修改用户
    if (testData.newUserId) {
      const newName = testUsername + '_renamed';
      res = await api.put(`/api/users/${testData.newUserId}`, {
        username: newName,
        password: 'newpass1234'
      }, adminToken);
      assert('3.4 修改用户', res.status === 200 && res.body.success,
        `status=${res.status}, body=${JSON.stringify(res.body)}`);
      testData.newUsername = newName;
    }

    // 3.5 在线用户
    res = await api.get('/api/online-users', adminToken);
    assert('3.5 获取在线用户', res.status === 200 && Array.isArray(res.body),
      `status=${res.status}, isArray=${Array.isArray(res.body)}`);
    if (Array.isArray(res.body)) {
      console.log(`    在线用户数: ${res.body.length}`);
    }

    // 3.6 下属列表
    res = await api.get('/api/users/subordinates', adminToken);
    assert('3.6 获取下属', res.status === 200 && Array.isArray(res.body),
      `status=${res.status}`);

    // 3.7 晋升用户
    if (testData.newUserId) {
      res = await api.post(`/api/users/${testData.newUserId}/promote`, {}, adminToken);
      assert('3.7 晋升/降级用户', res.status === 200 && res.body.success,
        `status=${res.status}, body=${JSON.stringify(res.body)}`);
    }
  }

  // ---- 4. 库存模块 ----
  header('4. 库存 (Inventory)');

  // 4.1 获取全部库存 (需要token)
  res = await api.get('/api/inventory', adminToken);
  assert('4.1 获取全部库存', res.status === 200 && Array.isArray(res.body),
    `status=${res.status}, isArray=${Array.isArray(res.body)}`);
  if (Array.isArray(res.body)) console.log(`    库存种类: ${res.body.length}`);

  // 4.2 获取单个库存
  res = await api.get('/api/inventory/left_glove', adminToken);
  assert('4.2 获取单个库存', res.status === 200 && res.body.type === 'left_glove',
    `status=${res.status}, body=${JSON.stringify(res.body)}`);

  // 4.3 调整库存
  res = await api.post('/api/inventory/left_glove', { delta: 1 }, adminToken);
  assert('4.3 调整库存(+1)', res.status === 200 && res.body.success,
    `status=${res.status}, body=${JSON.stringify(res.body)}`);
  if (res.body.newQuantity !== undefined) console.log(`    左手手套新库存: ${res.body.newQuantity}`);

  // 4.4 调整库存(-1)
  res = await api.post('/api/inventory/left_glove', { delta: -1 }, adminToken);
  assert('4.4 调整库存(-1)', res.status === 200 && res.body.success,
    `status=${res.status}, body=${JSON.stringify(res.body)}`);

  // 4.5 不存在的库存类型
  res = await api.get('/api/inventory/nonexistent_type', adminToken);
  assert('4.5 不存在的库存返回默认值', res.status === 200 && res.body.quantity === 0,
    `status=${res.status}, body=${JSON.stringify(res.body)}`);

  // ---- 5. 机器管理 ----
  header('5. 机器管理 (Machines)');

  res = await api.get('/api/machines', adminToken);
  assert('5.1 获取机器列表', res.status === 200 && Array.isArray(res.body),
    `status=${res.status}, isArray=${Array.isArray(res.body)}`);
  if (Array.isArray(res.body)) console.log(`    机器数: ${res.body.length}`);
  testData.machineCountBefore = Array.isArray(res.body) ? res.body.length : 0;

  // 5.2 添加机器
  const testMachine = {
    machineNumber: 'TEST-' + Date.now().toString(36).toUpperCase(),
    deviceType: 'glove',
    status: 'online',
    location: '测试车间',
    notes: '自动化测试机器'
  };
  res = await api.post('/api/machines', testMachine, adminToken);
  assert('5.2 添加机器', res.status === 200 && res.body.success,
    `status=${res.status}, body=${JSON.stringify(res.body)}`);
  if (res.body.machine) {
    testData.newMachineId = res.body.machine.id || testMachine.machineNumber;
    testData.newMachineNumber = testMachine.machineNumber;
  }

  // 5.3 验证机器已在列表中
  res = await api.get('/api/machines', adminToken);
  if (Array.isArray(res.body) && testData.newMachineNumber) {
    const found = res.body.find(m => m.machineNumber === testData.newMachineNumber);
    assert('5.3 新增机器在列表中', !!found, found ? '找到' : '未找到');
  }

  // ---- 6. 交易记录 ----
  header('6. 交易记录 (Transactions)');

  res = await api.get('/api/transactions', adminToken);
  assert('6.1 获取交易列表', res.status === 200 && Array.isArray(res.body),
    `status=${res.status}, isArray=${Array.isArray(res.body)}`);
  if (Array.isArray(res.body)) console.log(`    交易记录数: ${res.body.length}`);
  testData.txCountBefore = Array.isArray(res.body) ? res.body.length : 0;

  // 6.2 添加交易
  const testTx = {
    equipmentType: 'glove',
    handType: 'left',
    direction: 'in',
    quantity: 1,
    snCode: 'TEST-SN-' + Date.now().toString(36),
    machineNumber: testData.newMachineNumber || 'TEST-MACHINE',
    updatedBy: '测试脚本',
    timestamp: new Date().toISOString()
  };
  res = await api.post('/api/transactions', testTx, adminToken);
  assert('6.2 添加交易', res.status === 200 && res.body.success,
    `status=${res.status}, body=${JSON.stringify(res.body)}`);
  if (res.body.transaction) testData.newTxId = res.body.transaction.id;

  // ---- 7. 审计日志 ----
  header('7. 审计日志 (Audit Log)');

  res = await api.get('/api/audit-log', adminToken);
  assert('7.1 获取审计日志', res.status === 200 && Array.isArray(res.body),
    `status=${res.status}, isArray=${Array.isArray(res.body)}`);
  if (Array.isArray(res.body)) console.log(`    审计日志数: ${res.body.length}`);

  // ---- 8. 设置 ----
  header('8. 设置 (Settings)');

  res = await api.get('/api/settings', adminToken);
  assert('8.1 获取设置', res.status === 200,
    `status=${res.status}`);

  res = await api.post('/api/settings', { test_key: 'test_value', test_time: new Date().toISOString() }, adminToken);
  assert('8.2 保存设置', res.status === 200 && res.body.success,
    `status=${res.status}, body=${JSON.stringify(res.body)}`);

  // ---- 9. 设备配置 ----
  header('9. 设备配置 (Equipment Config)');

  res = await api.get('/api/equipment-config', adminToken);
  assert('9.1 获取设备配置', res.status === 200 && Array.isArray(res.body),
    `status=${res.status}, isArray=${Array.isArray(res.body)}`);
  if (Array.isArray(res.body)) {
    console.log(`    设备配置数: ${res.body.length}`);
    testData.eqConfig = res.body;
  }

  // ---- 10. 库存配置 ----
  header('10. 库存配置 (Inventory Config)');

  res = await api.get('/api/inventory-config', adminToken);
  assert('10.1 获取库存配置', res.status === 200 && Array.isArray(res.body),
    `status=${res.status}, isArray=${Array.isArray(res.body)}`);
  if (Array.isArray(res.body)) {
    console.log(`    库存配置数: ${res.body.length}`);
    testData.invConfig = res.body;
  }

  // ---- 11. 技术支持(维修) ----
  header('11. 技术支持 (Tech Support)');

  const opsToken = tokens['sa-002'] || testData.yunyingToken;

  // 11.1 运营用户提交技术支持请求
  if (opsToken && testData.newMachineNumber) {
    res = await api.post('/api/tech-support', {
      equipmentType: 'glove',
      equipmentTypeName: '纯手套设备',
      machineId: testData.newMachineId || 'test-machine',
      machineNumber: testData.newMachineNumber,
      faultType: '传感器失灵',
      faultDescription: '自动化测试故障描述'
    }, opsToken);
    assert('11.1 提交技术支持', res.status === 200 && res.body.success,
      `status=${res.status}, body=${JSON.stringify(res.body)}`);
    if (res.body.item) {
      testData.tsId = res.body.item.id;
      console.log(`    技术支持ID: ${res.body.item.id}`);
    }
  } else {
    skip('11.1 提交技术支持', '无运营token或测试机器');
  }

  // 11.2 获取技术支持列表
  res = await api.get('/api/tech-support', adminToken);
  assert('11.2 获取技术支持列表', res.status === 200 && Array.isArray(res.body),
    `status=${res.status}, isArray=${Array.isArray(res.body)}`);
  if (Array.isArray(res.body)) console.log(`    技术支持记录数: ${res.body.length}`);

  // 11.3 运维响应技术支持
  if (testData.tsId) {
    res = await api.post(`/api/tech-support/${testData.tsId}/respond`, {}, adminToken);
    assert('11.3 响应技术支持', res.status === 200 && res.body.success,
      `status=${res.status}, body=${JSON.stringify(res.body)}`);

    // 11.4 完成维修
    res = await api.post(`/api/tech-support/${testData.tsId}/complete`, {
      result: '已修复，更换传感器'
    }, adminToken);
    assert('11.4 完成维修', res.status === 200 && res.body.success,
      `status=${res.status}, body=${JSON.stringify(res.body)}`);

    // 11.5 获取技术支持详情
    res = await api.get(`/api/tech-support/${testData.tsId}`, adminToken);
    assert('11.5 获取技术支持详情', res.status === 200 && res.body.status === 'completed',
      `status=${res.status}, detailStatus=${res.body.status}`);
  }

  // ---- 12. SN码注册 ----
  header('12. SN码注册 (SN Registry)');

  res = await api.get('/api/sn-registry', adminToken);
  assert('12.1 获取SN注册表', res.status === 200 && Array.isArray(res.body),
    `status=${res.status}, isArray=${Array.isArray(res.body)}`);
  if (Array.isArray(res.body)) console.log(`    SN记录数: ${res.body.length}`);
  testData.snCountBefore = Array.isArray(res.body) ? res.body.length : 0;

  // 12.2 添加/更新SN
  const testSN = 'SN-TEST-' + Date.now().toString(36).toUpperCase();
  res = await api.post('/api/sn-registry', {
    snCode: testSN,
    equipmentType: 'glove',
    handType: 'left',
    status: 'available'
  }, adminToken);
  assert('12.2 添加SN码', res.status === 200 && res.body.success,
    `status=${res.status}, body=${JSON.stringify(res.body)}`);
  testData.testSN = testSN;

  // 12.3 更新已有SN
  res = await api.post('/api/sn-registry', {
    snCode: testSN,
    status: 'damaged',
    damageReason: '磨损'
  }, adminToken);
  assert('12.3 更新SN状态', res.status === 200 && res.body.success,
    `status=${res.status}`);

  // 12.4 发货SN
  res = await api.post('/api/sn-registry/ship', {
    snCode: testSN,
    trackingNumber: 'SF1234567890'
  }, adminToken);
  assert('12.4 SN发货', res.status === 200 && res.body.success,
    `status=${res.status}`);

  // 12.5 维修完成
  res = await api.post('/api/sn-registry/repair-complete', {
    snCode: testSN
  }, adminToken);
  assert('12.5 SN维修完成', res.status === 200 && res.body.success,
    `status=${res.status}`);

  // ---- 13. 弹窗消息 ----
  header('13. 弹窗消息 (Popup Messages)');

  res = await api.get('/api/popup-messages', adminToken);
  assert('13.1 获取弹窗消息列表', res.status === 200 && Array.isArray(res.body),
    `status=${res.status}, isArray=${Array.isArray(res.body)}`);
  if (Array.isArray(res.body)) console.log(`    弹窗消息数: ${res.body.length}`);

  // 13.2 随机消息
  res = await api.get('/api/popup-messages/random?category=submit', adminToken);
  assert('13.2 随机提交消息', res.status === 200 && res.body.text,
    `status=${res.status}, text=${res.body.text}`);

  res = await api.get('/api/popup-messages/random?category=complete', adminToken);
  assert('13.3 随机完成消息', res.status === 200 && res.body.text,
    `status=${res.status}, text=${res.body.text}`);

  // 13.4 添加弹窗消息
  res = await api.post('/api/popup-messages', {
    category: 'submit',
    text: '自动化测试消息: 提交成功!'
  }, adminToken);
  assert('13.4 添加弹窗消息', res.status === 200 && res.body.success,
    `status=${res.status}, body=${JSON.stringify(res.body)}`);
  if (res.body.id) testData.popupMsgId = res.body.id;

  // ---- 14. 运营模块 ----
  header('14. 运营模块 (Operations)');

  // 14.1 工单
  res = await api.get('/api/ops-orders', adminToken);
  assert('14.1 获取工单', res.status === 200 && Array.isArray(res.body),
    `status=${res.status}`);

  // 14.2 客户
  res = await api.get('/api/ops-customers', adminToken);
  assert('14.2 获取客户', res.status === 200 && Array.isArray(res.body),
    `status=${res.status}`);

  // 14.3 生产
  res = await api.get('/api/ops-production', adminToken);
  assert('14.3 获取生产', res.status === 200 && Array.isArray(res.body),
    `status=${res.status}`);

  // ---- 15. 数据完整性 ----
  header('15. 数据完整性');

  res = await api.get('/api/data-integrity', adminToken);
  assert('15.1 数据完整性检查', res.status === 200,
    `status=${res.status}, issues=${res.body.count || 0}`);

  // ---- 16. 同步 ----
  header('16. 同步 (Sync)');

  res = await api.get('/api/sync', adminToken);
  assert('16.1 全量同步', res.status === 200,
    `status=${res.status}`);
  if (res.status === 200) {
    const keys = ['inventory', 'machines', 'transactions', 'snRegistry', 'settings', 'equipmentConfig', 'inventoryConfig'];
    const hasAll = keys.every(k => res.body[k] !== undefined);
    assert('16.2 同步数据完整性', hasAll,
      `缺失字段: ${keys.filter(k => res.body[k] === undefined).join(',')}`);
  }

  // ---- 17. 最后备份 ----
  header('17. 备份信息');

  res = await api.get('/api/last-backup', adminToken);
  assert('17.1 最后备份时间', res.status === 200,
    `status=${res.status}, lastModified=${res.body.lastModified}`);

  // ---- 18. 导出功能 ----
  header('18. 导出功能');

  res = await api.get('/api/export/xlsx', adminToken);
  assert('18.1 导出XLSX', res.status === 200,
    `status=${res.status}, contentType=${res.headers['content-type']}`);
  assert('18.1b XLSX Content-Type',
    (res.headers['content-type'] || '').includes('spreadsheetml') || (res.headers['content-type'] || '').includes('octet'),
    `contentType=${res.headers['content-type']}`);

  res = await api.get('/api/export/tech-support-xlsx', adminToken);
  assert('18.2 导出维修日志XLSX', res.status === 200,
    `status=${res.status}`);

  res = await api.get('/api/export/full', adminToken);
  assert('18.3 导出完整备份ZIP', res.status === 200,
    `status=${res.status}`);

  // ---- 19. 文件上传 ----
  header('19. 文件上传');

  const fakePngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  res = await api.post('/api/upload', {
    filename: 'test.png',
    data: `data:image/png;base64,${fakePngBase64}`
  }, adminToken);
  assert('19.1 上传文件', res.status === 200 && res.body.path,
    `status=${res.status}, body=${JSON.stringify(res.body)}`);
  if (res.body.path) testData.uploadPath = res.body.path;

  // ---- 20. 退出与登录过期 ----
  header('20. 退出 & Token管理');

  // 20.1 退出登录
  res = await api.post('/api/logout', {}, adminToken);
  assert('20.1 退出登录', res.status === 200 && res.body.success,
    `status=${res.status}, body=${JSON.stringify(res.body)}`);

  // 20.2 token失效
  res = await api.get('/api/inventory', adminToken);
  assert('20.2 退出后token失效', res.status === 401,
    `status=${res.status}`);

  // 20.3 重新登录
  res = await api.post('/api/auth/login', { username: 'Yunwei', password: 'yunwei1025' });
  if (res.body.token) tokens['sa-001'] = res.body.token;

  // 20.4 Beacon退出
  if (tokens['sa-001']) {
    res = await api.post('/api/beacon-logout', { token: tokens['sa-001'] });
    assert('20.4 Beacon退出', res.status === 200 && res.body.success,
      `status=${res.status}`);
  }

  // ---- 21. 修改密码 ----
  header('21. 修改密码');

  // 重新登录
  res = await api.post('/api/auth/login', { username: 'Yunwei', password: 'yunwei1025' });
  if (res.body.token) tokens['sa-001'] = res.body.token;

  res = await api.post('/api/change-password', {
    oldPassword: 'yunwei1025',
    newPassword: 'yunwei1025'  // set back to same for safety
  }, tokens['sa-001']);
  assert('21.1 修改密码(新旧相同)', res.status === 200,
    `status=${res.status}, body=${JSON.stringify(res.body)}`);

  // ---- 22. 分组管理 ----
  header('22. 分组管理 (Group Transfers)');

  res = await api.get('/api/group/members', tokens['sa-001']);
  assert('22.1 获取组员', res.status === 200,
    `status=${res.status}`);

  // 获取下属列表找可调配的用户
  res = await api.get('/api/users/subordinates', tokens['sa-001']);
  if (res.status === 200 && Array.isArray(res.body) && res.body.length > 0) {
    const targetUser = res.body[0];
    testData.groupTargetUser = targetUser;

    // 发起调配
    res = await api.post('/api/group/transfer', {
      toAdminId: 'sa-002',  // yunying's ID
      userId: targetUser.id,
      username: targetUser.username,
      direction: 'out',
      reason: '自动化测试调配'
    }, tokens['sa-001']);
    assert('22.2 发起调配', res.status === 200 && res.body.success,
      `status=${res.status}, body=${JSON.stringify(res.body)}`);
    if (res.body.item) testData.groupTransferId = res.body.item.id;

    // 取消调配 (先取消，不用真的让另一方审批)
    if (testData.groupTransferId) {
      res = await api.post(`/api/group/transfer/${testData.groupTransferId}/cancel`, {}, tokens['sa-001']);
      assert('22.3 取消调配', res.status === 200 && res.body.success,
        `status=${res.status}`);
    }
  } else {
    skip('22.2 分组调配测试', '无可用下属');
  }

  // ---- 23. 清理测试数据 ----
  header('23. 清理测试数据');

  // 23.1 删除测试机器
  if (testData.newMachineId) {
    res = await api.del(`/api/machines/${testData.newMachineId}`, tokens['sa-001']);
    assert('23.1 删除测试机器', res.status === 200 && res.body.success,
      `status=${res.status}, body=${JSON.stringify(res.body)}`);
  }

  // 23.2 删除弹窗消息
  if (testData.popupMsgId) {
    res = await api.del(`/api/popup-messages/${testData.popupMsgId}`, tokens['sa-001']);
    assert('23.2 删除测试弹窗消息', res.status === 200 && res.body.success,
      `status=${res.status}, body=${JSON.stringify(res.body)}`);
  }

  // 23.3 删除测试SN
  if (testData.testSN) {
    res = await api.del(`/api/sn-registry/${testData.testSN}`, tokens['sa-001']);
    assert('23.3 删除测试SN', res.status === 200 && res.body.success,
      `status=${res.status}`);
  }

  // 23.4 删除测试用户
  if (testData.newUserId) {
    res = await api.del(`/api/users/${testData.newUserId}`, tokens['sa-001']);
    assert('23.4 删除测试用户', res.status === 200 && res.body.success,
      `status=${res.status}, body=${JSON.stringify(res.body)}`);
  }

  // 23.5 删除测试上传文件
  if (testData.uploadPath) {
    res = await api.post('/api/delete-upload', { filePath: testData.uploadPath }, tokens['sa-001']);
    assert('23.5 删除测试上传文件', res.status === 200,
      `status=${res.status}`);
  }

  // ---- 24. 静态文件服务 ----
  header('24. 静态文件服务');

  res = await api.get('/');
  assert('24.1 首页 HTML', res.status === 200,
    `status=${res.status}`);

  res = await api.get('/operations.html');
  assert('24.2 运营页面', res.status === 200,
    `status=${res.status}`);

  // ---- 打印结果 ----
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  📊 测试结果汇总`);
  console.log(`${'='.repeat(60)}`);
  const total = PASS + FAIL + SKIP;
  console.log(`  ✅ 通过: ${PASS}/${total} (${(PASS/total*100).toFixed(1)}%)`);
  console.log(`  ❌ 失败: ${FAIL}/${total} (${(FAIL/total*100).toFixed(1)}%)`);
  console.log(`  ⏭️  跳过: ${SKIP}/${total} (${(SKIP/total*100).toFixed(1)}%)`);
  console.log(`${'='.repeat(60)}\n`);

  if (FAIL > 0) {
    console.log('⚠️  存在失败测试，请检查上述 ✗ 标记项\n');
    process.exit(1);
  } else {
    console.log('🎉 所有测试通过！\n');
    process.exit(0);
  }
}

main().catch(err => {
  console.error('💥 测试异常:', err.message);
  process.exit(1);
});
