/**
 * Unit tests for realtime.js authenticateConnection — S5.2 WebSocket cookie auth
 * Run: node --test tests/unit/realtime-auth.test.js
 *
 * 覆盖 authenticateConnection 的 6 个 case：
 *   - validateToken 未注入（_validateToken=null）
 *   - 无 cookie 头
 *   - cookie 中无 gms_token
 *   - token 无效（validateToken 返回 null）
 *   - validateToken 抛错（fail-closed 返回 false）
 *   - token 有效（填充 info、加入 userSockets、发 auth_ok）
 *
 * 不依赖 ws 库 / http server —— 仅测纯函数 authenticateConnection(ws, info, cookie)。
 */
const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');

const realtime = require('../../realtime');

/** 构造最小化 mock ws（记录 send 调用，模拟 readyState=1 OPEN） */
function mockWs() {
  const sent = [];
  return {
    readyState: 1,
    _yunweiId: null,
    _alive: true,
    send(payload) { sent.push(JSON.parse(payload)); },
    close() {},
    terminate() {},
    ping() {},
    on() {},
    _sent: sent,
  };
}

/** 构造一个连接 info（与 wss.on('connection') 初始化结构一致） */
function mockInfo(wsId = 'test-ws-id') {
  return {
    id: wsId,
    ip: '127.0.0.1',
    connectedAt: Date.now(),
    userId: null,
    username: null,
    displayName: null,
    role: null,
    system: null,
    authenticated: false,
    lastHeartbeat: Date.now(),
  };
}

const fakeUser = {
  userId: 42,
  username: 'alice',
  displayName: 'Alice',
  role: 'user',
  system: 'maintenance',
};

describe('authenticateConnection — S5.2 WebSocket cookie auth', () => {
  let savedValidateToken;

  beforeEach(() => {
    // Save & clear injected validateToken before each test for isolation.
    // _setValidateToken mutates module state; restore after each test.
    savedValidateToken = null;
    realtime._setValidateToken(null);
  });

  afterEach(() => {
    realtime._setValidateToken(null);
  });

  test('returns false when validateToken not injected (_validateToken=null)', async () => {
    const ws = mockWs();
    const info = mockInfo();
    const result = await realtime.authenticateConnection(ws, info, 'gms_token=abc');
    assert.strictEqual(result, false);
    assert.strictEqual(info.authenticated, false);
    assert.strictEqual(info.userId, null);
    // No auth_ok sent — client should fall back to sending an auth message
    assert.strictEqual(ws._sent.length, 0);
  });

  test('returns false when no cookie header present', async () => {
    realtime._setValidateToken(() => fakeUser);
    const ws = mockWs();
    const info = mockInfo();
    const result = await realtime.authenticateConnection(ws, info, undefined);
    assert.strictEqual(result, false);
    assert.strictEqual(info.authenticated, false);
    assert.strictEqual(ws._sent.length, 0);
  });

  test('returns false when cookie header is empty string', async () => {
    realtime._setValidateToken(() => fakeUser);
    const ws = mockWs();
    const info = mockInfo();
    const result = await realtime.authenticateConnection(ws, info, '');
    assert.strictEqual(result, false);
    assert.strictEqual(info.authenticated, false);
  });

  test('returns false when cookie has no gms_token key', async () => {
    realtime._setValidateToken(() => fakeUser);
    const ws = mockWs();
    const info = mockInfo();
    // Other cookies present, but not gms_token
    const result = await realtime.authenticateConnection(ws, info, 'theme=dark; lang=zh');
    assert.strictEqual(result, false);
    assert.strictEqual(info.authenticated, false);
    assert.strictEqual(ws._sent.length, 0);
  });

  test('returns false when validateToken returns null (invalid/expired token)', async () => {
    realtime._setValidateToken(() => null);
    const ws = mockWs();
    const info = mockInfo();
    const result = await realtime.authenticateConnection(ws, info, 'gms_token=expired-token');
    assert.strictEqual(result, false);
    assert.strictEqual(info.authenticated, false);
    assert.strictEqual(info.userId, null);
    // No auth_ok — client falls back to message auth
    assert.strictEqual(ws._sent.length, 0);
  });

  test('returns false when validateToken throws (fail-closed, no crash)', async () => {
    realtime._setValidateToken(() => { throw new Error('redis down'); });
    const ws = mockWs();
    const info = mockInfo();
    const result = await realtime.authenticateConnection(ws, info, 'gms_token=abc');
    assert.strictEqual(result, false);
    assert.strictEqual(info.authenticated, false);
  });

  test('returns true + authenticates when valid gms_token cookie present', async () => {
    realtime._setValidateToken(() => fakeUser);
    const ws = mockWs();
    const info = mockInfo();
    const result = await realtime.authenticateConnection(ws, info, 'gms_token=valid-token-xyz');
    assert.strictEqual(result, true);
    // info filled with user fields
    assert.strictEqual(info.authenticated, true);
    assert.strictEqual(info.userId, 42);
    assert.strictEqual(info.username, 'alice');
    assert.strictEqual(info.displayName, 'Alice');
    assert.strictEqual(info.role, 'user');
    assert.strictEqual(info.system, 'maintenance');
    // auth_ok message sent to client
    assert.strictEqual(ws._sent.length, 1);
    const msg = ws._sent[0];
    assert.strictEqual(msg.type, 'auth_ok');
    assert.strictEqual(msg.user.userId, 42);
    assert.strictEqual(msg.user.username, 'alice');
    assert.strictEqual(msg.user.system, 'maintenance');
  });

  test('parses gms_token from multi-value cookie header', async () => {
    realtime._setValidateToken(() => fakeUser);
    const ws = mockWs();
    const info = mockInfo();
    // gms_token mixed with other cookies, whitespace variations
    const result = await realtime.authenticateConnection(ws, info, 'theme=dark; gms_token=tok123; lang=en');
    assert.strictEqual(result, true);
    assert.strictEqual(info.authenticated, true);
    assert.strictEqual(info.userId, 42);
  });

  test('passes the parsed gms_token value to validateToken', async () => {
    let receivedToken = null;
    realtime._setValidateToken((t) => { receivedToken = t; return fakeUser; });
    const ws = mockWs();
    const info = mockInfo();
    await realtime.authenticateConnection(ws, info, 'gms_token=my-secret-token');
    assert.strictEqual(receivedToken, 'my-secret-token');
  });

  test('registers connection in userSockets (getMetrics reflects auth)', async () => {
    realtime._setValidateToken(() => fakeUser);
    const ws = mockWs();
    const info = mockInfo();
    await realtime.authenticateConnection(ws, info, 'gms_token=tok');
    const metrics = realtime.getMetrics();
    // One authenticated user now registered
    assert.ok(metrics.authenticatedUsers >= 1, `expected >=1 authenticated user, got ${metrics.authenticatedUsers}`);
  });
});
