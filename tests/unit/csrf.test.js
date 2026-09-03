/**
 * Unit tests for lib/csrf.js — CSRF Double-Submit Cookie 中间件（S4 批次）
 * Run: node --test tests/unit/csrf.test.js
 *
 * 覆盖：
 *   - readCookie 解析（单/多 cookie、空值、值含 =、空白）
 *   - isExempt 豁免判定（GET/HEAD/OPTIONS、Bearer、大小写）
 *   - enforce 强制校验（CSRF_ENFORCED=true 时各分支）
 *   - enforce 软启动（CSRF_ENFORCED=false 全放行）
 *   - gate 403 响应路径（sendJSON 注入 / 原生降级）
 *   - config 开关暴露
 */
const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert');

const CSRF_PATH = require.resolve('../../lib/csrf');

/**
 * 清除 require 缓存后重新加载 csrf 模块，便于在 enforced=true/false 之间切换。
 * lib/csrf.js 在模块顶层读取 process.env.CSRF_ENFORCED，所以必须重载。
 */
function freshCSRF({ enforced = false } = {}) {
  delete require.cache[CSRF_PATH];
  process.env.CSRF_ENFORCED = enforced ? 'true' : 'false';
  return require('../../lib/csrf');
}

/** 构造最小化 mock req */
function mockReq({ method = 'GET', cookie = '', csrfHeader = null, authorization = null } = {}) {
  const headers = {};
  if (cookie) headers['cookie'] = cookie;
  if (csrfHeader !== null) headers['x-csrf-token'] = csrfHeader;
  if (authorization) headers['authorization'] = authorization;
  return { method, headers };
}

/** 构造最小化 mock res（记录 writeHead/end 调用，用于无 sendJSON 时的降级路径） */
function mockRes() {
  const state = {
    statusCode: null,
    body: null,
    headers: {},
    headersSent: false,
    ended: false,
  };
  state.writeHead = (code, h) => {
    state.statusCode = code;
    Object.assign(state.headers, h || {});
  };
  state.setHeader = (name, value) => { state.headers[name.toLowerCase()] = value; };
  state.hasHeader = (name) => Object.prototype.hasOwnProperty.call(state.headers, name.toLowerCase());
  state.end = (data) => { state.ended = true; state.body = data; };
  return state;
}

afterEach(() => { delete process.env.CSRF_ENFORCED; });

// ============================================================================
// readCookie
// ============================================================================
describe('readCookie', () => {
  const { readCookie } = freshCSRF();

  test('单个 cookie 正确解析', () => {
    assert.strictEqual(readCookie('gms_csrf=abc123', 'gms_csrf'), 'abc123');
  });

  test('多个 cookie 中按名查找', () => {
    const h = 'gms_token=xyz; gms_csrf=deadbeef; theme=dark';
    assert.strictEqual(readCookie(h, 'gms_csrf'), 'deadbeef');
    assert.strictEqual(readCookie(h, 'gms_token'), 'xyz');
    assert.strictEqual(readCookie(h, 'theme'), 'dark');
  });

  test('cookie 不存在返回 null', () => {
    assert.strictEqual(readCookie('gms_token=xyz', 'gms_csrf'), null);
  });

  test('空 header 返回 null', () => {
    assert.strictEqual(readCookie('', 'gms_csrf'), null);
    assert.strictEqual(readCookie(null, 'gms_csrf'), null);
    assert.strictEqual(readCookie(undefined, 'gms_csrf'), null);
  });

  test('cookie 值中含 = 不被误解析为分隔符（base64/URL-encoded）', () => {
    // indexOf('=') 只用第一个 =，后续 = 保留在值里
    assert.strictEqual(readCookie('gms_csrf=abc==def', 'gms_csrf'), 'abc==def');
    assert.strictEqual(readCookie('gms_csrf=eyJhbGc==.sig==', 'gms_csrf'), 'eyJhbGc==.sig==');
  });

  test('处理 key/value 周围的空白', () => {
    const h = ' gms_token = xyz ; gms_csrf = token123 ';
    assert.strictEqual(readCookie(h, 'gms_csrf'), 'token123');
  });

  test('不含 = 的 pair 被跳过', () => {
    const h = 'boguspair; gms_csrf=tok';
    assert.strictEqual(readCookie(h, 'gms_csrf'), 'tok');
  });
});

// ============================================================================
// isExempt — 豁免判定
// ============================================================================
describe('createCSRFMiddleware — isExempt', () => {
  const { createCSRFMiddleware } = freshCSRF({ enforced: true });
  const mw = createCSRFMiddleware({});

  test('GET 豁免', () => {
    assert.strictEqual(mw.isExempt(mockReq({ method: 'GET' })), true);
  });

  test('HEAD 豁免', () => {
    assert.strictEqual(mw.isExempt(mockReq({ method: 'HEAD' })), true);
  });

  test('OPTIONS 豁免（预飞）', () => {
    assert.strictEqual(mw.isExempt(mockReq({ method: 'OPTIONS' })), true);
  });

  test('POST 不豁免', () => {
    assert.strictEqual(mw.isExempt(mockReq({ method: 'POST' })), false);
  });

  test('PUT/DELETE/PATCH 不豁免', () => {
    assert.strictEqual(mw.isExempt(mockReq({ method: 'PUT' })), false);
    assert.strictEqual(mw.isExempt(mockReq({ method: 'DELETE' })), false);
    assert.strictEqual(mw.isExempt(mockReq({ method: 'PATCH' })), false);
  });

  test('Bearer Authorization 豁免（移动端 token 鉴权）', () => {
    const req = mockReq({ method: 'POST', authorization: 'Bearer abc.def.ghi' });
    assert.strictEqual(mw.isExempt(req), true);
  });

  test('非 Bearer Authorization 不豁免（如 Basic）', () => {
    const req = mockReq({ method: 'POST', authorization: 'Basic dXNlcjpwdw==' });
    assert.strictEqual(mw.isExempt(req), false);
  });

  test('method 大小写不敏感', () => {
    assert.strictEqual(mw.isExempt(mockReq({ method: 'get' })), true);
    assert.strictEqual(mw.isExempt(mockReq({ method: 'head' })), true);
    assert.strictEqual(mw.isExempt(mockReq({ method: 'options' })), true);
    assert.strictEqual(mw.isExempt(mockReq({ method: 'post' })), false);
  });

  test('method 缺失时默认 GET 豁免', () => {
    assert.strictEqual(mw.isExempt({ headers: {} }), true);
  });
});

// ============================================================================
// enforce — CSRF_ENFORCED=true（强制模式）
// ============================================================================
describe('createCSRFMiddleware — enforce (CSRF_ENFORCED=true)', () => {
  const { createCSRFMiddleware } = freshCSRF({ enforced: true });

  test('GET 请求豁免（无 token 也通过）', async () => {
    const mw = createCSRFMiddleware({});
    const r = await mw.enforce(mockReq({ method: 'GET' }));
    assert.strictEqual(r.ok, true);
  });

  test('POST + Bearer 请求豁免（移动端）', async () => {
    const mw = createCSRFMiddleware({});
    const r = await mw.enforce(mockReq({ method: 'POST', authorization: 'Bearer t' }));
    assert.strictEqual(r.ok, true);
  });

  test('POST 无 cookie 无 header → 缺少 CSRF 令牌', async () => {
    const mw = createCSRFMiddleware({});
    const r = await mw.enforce(mockReq({ method: 'POST' }));
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /缺少 CSRF 令牌/);
  });

  test('POST 仅 cookie 无 header → 缺少 CSRF 令牌', async () => {
    const mw = createCSRFMiddleware({});
    const r = await mw.enforce(mockReq({ method: 'POST', cookie: 'gms_csrf=tok' }));
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /缺少 CSRF 令牌/);
  });

  test('POST 仅 header 无 cookie → 缺少 CSRF 令牌', async () => {
    const mw = createCSRFMiddleware({});
    const r = await mw.enforce(mockReq({ method: 'POST', csrfHeader: 'tok' }));
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /缺少 CSRF 令牌/);
  });

  test('cookie 与 header 不匹配 → 令牌不匹配', async () => {
    const mw = createCSRFMiddleware({});
    const r = await mw.enforce(mockReq({
      method: 'POST',
      cookie: 'gms_csrf=cookie-tok',
      csrfHeader: 'header-tok',
    }));
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /不匹配/);
  });

  test('cookie 与 header 匹配且 verifyToken=true → 通过', async () => {
    const mw = createCSRFMiddleware({ verifyToken: async () => true });
    const r = await mw.enforce(mockReq({
      method: 'POST',
      cookie: 'gms_csrf=sametok',
      csrfHeader: 'sametok',
    }));
    assert.strictEqual(r.ok, true);
  });

  test('cookie 与 header 匹配但 verifyToken=false → 无效或已过期', async () => {
    const mw = createCSRFMiddleware({ verifyToken: async () => false });
    const r = await mw.enforce(mockReq({
      method: 'POST',
      cookie: 'gms_csrf=sametok',
      csrfHeader: 'sametok',
    }));
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /无效或已过期/);
  });

  test('verifyToken 抛错时 fail-closed 拒绝（Redis 抖动不冒泡 500）', async () => {
    const mw = createCSRFMiddleware({
      verifyToken: async () => { throw new Error('redis down'); },
    });
    // 不应 reject；应返回 ok:false
    const r = await mw.enforce(mockReq({
      method: 'POST',
      cookie: 'gms_csrf=t',
      csrfHeader: 't',
    }));
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /无效或已过期/);
  });

  test('未注入 verifyToken 时跳过存在性校验（仅做 double-submit）', async () => {
    const mw = createCSRFMiddleware({});
    const r = await mw.enforce(mockReq({
      method: 'POST',
      cookie: 'gms_csrf=sametok',
      csrfHeader: 'sametok',
    }));
    assert.strictEqual(r.ok, true);
  });

  test('DELETE 请求同样受保护', async () => {
    const mw = createCSRFMiddleware({});
    const r = await mw.enforce(mockReq({ method: 'DELETE' }));
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /缺少 CSRF 令牌/);
  });

  test('verifyToken 接收 headerToken 而非 cookieToken', async () => {
    let received = null;
    const mw = createCSRFMiddleware({ verifyToken: async (t) => { received = t; return true; } });
    await mw.enforce(mockReq({
      method: 'POST',
      cookie: 'gms_csrf=cookie-val',
      csrfHeader: 'header-val',
    }));
    // 不匹配会被前置拦截，所以先构造匹配场景
    assert.strictEqual(received, null);
    // 真正匹配时 verifyToken 收到的是 header 值
    let received2 = null;
    const mw2 = createCSRFMiddleware({ verifyToken: async (t) => { received2 = t; return true; } });
    await mw2.enforce(mockReq({
      method: 'POST',
      cookie: 'gms_csrf=same',
      csrfHeader: 'same',
    }));
    assert.strictEqual(received2, 'same');
  });
});

// ============================================================================
// enforce — CSRF_ENFORCED=false（软启动模式）
// ============================================================================
describe('createCSRFMiddleware — enforce (CSRF_ENFORCED=false 软启动)', () => {
  const { createCSRFMiddleware } = freshCSRF({ enforced: false });

  test('POST 无任何 token 仍放行', async () => {
    const mw = createCSRFMiddleware({});
    const r = await mw.enforce(mockReq({ method: 'POST' }));
    assert.strictEqual(r.ok, true);
  });

  test('POST cookie/header 不匹配仍放行', async () => {
    const mw = createCSRFMiddleware({});
    const r = await mw.enforce(mockReq({
      method: 'POST',
      cookie: 'gms_csrf=a',
      csrfHeader: 'b',
    }));
    assert.strictEqual(r.ok, true);
  });

  test('verifyToken=false 仍放行（软启动期不强制存在性）', async () => {
    const mw = createCSRFMiddleware({ verifyToken: async () => false });
    const r = await mw.enforce(mockReq({
      method: 'POST',
      cookie: 'gms_csrf=t',
      csrfHeader: 't',
    }));
    assert.strictEqual(r.ok, true);
  });

  test('config.CSRF_ENFORCED === false', () => {
    const mw = createCSRFMiddleware({});
    assert.strictEqual(mw.config.CSRF_ENFORCED, false);
  });
});

// ============================================================================
// gate — 403 响应路径
// ============================================================================
describe('createCSRFMiddleware — gate', () => {
  const { createCSRFMiddleware } = freshCSRF({ enforced: true });

  test('enforce 通过时返回 true 且不调用 sendJSON', async () => {
    const calls = [];
    const sendJSON = (res, body, status) => calls.push({ body, status });
    const mw = createCSRFMiddleware({ sendJSON });
    const res = mockRes();
    const ok = await mw.gate(mockReq({ method: 'GET' }), res);
    assert.strictEqual(ok, true);
    assert.strictEqual(calls.length, 0, 'enforce 通过时不应调用 sendJSON');
  });

  test('enforce 失败时返回 false 并通过 sendJSON 响应 403', async () => {
    const calls = [];
    const sendJSON = (res, body, status, req, extra) => calls.push({ res, body, status });
    const mw = createCSRFMiddleware({ sendJSON });
    const res = mockRes();
    const ok = await mw.gate(mockReq({ method: 'POST' }), res);
    assert.strictEqual(ok, false);
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].status, 403);
    assert.match(calls[0].body.error, /缺少 CSRF 令牌/);
    assert.strictEqual(calls[0].res, res, 'sendJSON 应接收同一 res 对象');
  });

  test('未注入 sendJSON 时降级到原生 res.writeHead/end', async () => {
    const mw = createCSRFMiddleware({});
    const res = mockRes();
    const ok = await mw.gate(mockReq({ method: 'POST' }), res);
    assert.strictEqual(ok, false);
    assert.strictEqual(res.statusCode, 403);
    assert.strictEqual(res.ended, true);
    assert.strictEqual(res.headers['Content-Type'], 'application/json');
    const parsed = JSON.parse(res.body);
    assert.match(parsed.error, /缺少 CSRF 令牌/);
  });

  test('令牌不匹配时 error 文案正确透传', async () => {
    const calls = [];
    const sendJSON = (res, body, status) => calls.push({ body, status });
    const mw = createCSRFMiddleware({ sendJSON });
    const res = mockRes();
    await mw.gate(mockReq({
      method: 'POST',
      cookie: 'gms_csrf=a',
      csrfHeader: 'b',
    }), res);
    assert.strictEqual(calls[0].status, 403);
    assert.match(calls[0].body.error, /不匹配/);
  });

  test('verifyToken 抛错时 gate 返回 403 不冒泡异常', async () => {
    const mw = createCSRFMiddleware({
      verifyToken: async () => { throw new Error('boom'); },
      sendJSON: (res, body, status) => {
        res.statusCode = status;
        res.body = JSON.stringify(body);
        res.ended = true;
      },
    });
    const res = mockRes();
    const ok = await mw.gate(mockReq({
      method: 'POST',
      cookie: 'gms_csrf=t',
      csrfHeader: 't',
    }), res);
    assert.strictEqual(ok, false);
    assert.strictEqual(res.statusCode, 403);
    assert.match(JSON.parse(res.body).error, /无效或已过期/);
  });

  test('headersSent=true 时降级路径不重复 end（避免 double-end）', async () => {
    const mw = createCSRFMiddleware({}); // 无 sendJSON，走降级路径
    const res = mockRes();
    res.headersSent = true; // 模拟响应已发送
    const ok = await mw.gate(mockReq({ method: 'POST' }), res);
    assert.strictEqual(ok, false);
    assert.strictEqual(res.ended, false, 'headersSent 时不应再 end');
  });
});

// ============================================================================
// config 暴露
// ============================================================================
describe('createCSRFMiddleware — config 暴露', () => {
  test('enforced=true 时 config.CSRF_ENFORCED === true', () => {
    const { createCSRFMiddleware } = freshCSRF({ enforced: true });
    const mw = createCSRFMiddleware({});
    assert.strictEqual(mw.config.CSRF_ENFORCED, true);
  });

  test('enforced=false 时 config.CSRF_ENFORCED === false', () => {
    const { createCSRFMiddleware } = freshCSRF({ enforced: false });
    const mw = createCSRFMiddleware({});
    assert.strictEqual(mw.config.CSRF_ENFORCED, false);
  });

  test('返回的 middleware 含全部公开方法', () => {
    const { createCSRFMiddleware } = freshCSRF({ enforced: true });
    const mw = createCSRFMiddleware({});
    assert.strictEqual(typeof mw.enforce, 'function');
    assert.strictEqual(typeof mw.gate, 'function');
    assert.strictEqual(typeof mw.isExempt, 'function');
    assert.ok(typeof mw.config === 'object' && mw.config !== null);
  });
});
