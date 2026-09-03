/**
 * CSRF Protection — Double-Submit Cookie 模式（S4 批次）
 *
 * 设计：
 *   - Server 端发 token：cookie `gms_csrf` (非 HttpOnly) + body `{csrfToken}`
 *   - Frontend 端发 token：内存中存 `this.csrfToken`，每个非 GET 请求带 `X-CSRF-Token` 头
 *   - Server 验证：cookie value === header value，且 token 在 Redis 中存在
 *
 * 三层防护：
 *   1) SameSite=Lax cookie 默认不在跨站 POST 中发送（同源策略）
 *   2) Double-submit：header 必须等于 cookie，攻击者无法跨站读取 cookie
 *   3) Redis 存在性：token 必须由 server 签发过（防止攻击者构造伪 cookie）
 *
 * 跳过条件（不需要 CSRF 保护）：
 *   - GET / HEAD / OPTIONS 请求（无副作用）
 *   - 使用 Bearer Authorization 头（移动端，不是 cookie 鉴权）
 *   - 全局开关 CSRF_ENFORCED=false（部署软启动）
 *
 * 部署策略：
 *   1) 先部署 S4.1+S4.2+S4.5+S4.6（前端开始带头但服务端不强制）→ 观察 24h
 *   2) 然后设 CSRF_ENFORCED=true 启用强制
 */

'use strict';

const CSRF_ENFORCED = process.env.CSRF_ENFORCED !== 'false'; // 默认强制，显式 false 才进入软启动

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * 从 cookie 头解析指定 cookie 的值
 * @param {string} cookieHeader - req.headers['cookie']
 * @param {string} name - cookie 名
 * @returns {string|null}
 */
function readCookie(cookieHeader, name) {
  if (!cookieHeader) return null;
  const pairs = cookieHeader.split(';');
  for (const pair of pairs) {
    const idx = pair.indexOf('=');
    if (idx < 0) continue;
    const k = pair.substring(0, idx).trim();
    const v = pair.substring(idx + 1).trim();
    if (k === name) return v;
  }
  return null;
}

/**
 * 创建 CSRF 中间件工厂
 * @param {object} deps
 * @param {Function} deps.verifyToken - async (token) => boolean，验证 token 是否由 server 签发
 * @param {Function} [deps.sendJSON] - 用于验证失败时发送 403 响应
 */
function createCSRFMiddleware(deps = {}) {
  const { verifyToken, sendJSON } = deps;

  /**
   * 检查请求是否豁免 CSRF（不需要保护）
   * @param {import('http').IncomingMessage} req
   * @returns {boolean}
   */
  function isExempt(req) {
    const method = (req.method || 'GET').toUpperCase();
    // GET/HEAD/OPTIONS 无副作用，豁免
    if (SAFE_METHODS.has(method)) return true;
    // 使用 Bearer Authorization 的请求（移动端 token 鉴权，无 cookie 自动发送）
    const auth = req.headers['authorization'];
    if (auth && auth.startsWith('Bearer ')) return true;
    // 登录/登出端点豁免 — 用户尚未获取 CSRF token，无法在首次登录时提供
    // 登出端点安全影响低（仅清除 cookie，无数据泄露）
    const url = (req.url || '').split('?')[0];
    if (url === '/api/auth/login' || url === '/api/logout') return true;
    return false;
  }

  /**
   * 强制 CSRF 校验：非 GET 请求必须有匹配的 cookie 和 header
   * @returns {Promise<{ok:boolean, error?:string}>}
   */
  async function enforce(req) {
    if (!CSRF_ENFORCED) return { ok: true }; // 全局开关关闭，软启动模式
    if (isExempt(req)) return { ok: true };

    const cookieHeader = req.headers['cookie'] || '';
    const cookieToken = readCookie(cookieHeader, 'gms_csrf');
    const headerToken = req.headers['x-csrf-token'];

    // 1) cookie 和 header 都必须存在
    if (!cookieToken || !headerToken) {
      return { ok: false, error: '缺少 CSRF 令牌' };
    }
    // 2) 两者必须相等（double-submit）
    if (cookieToken !== headerToken) {
      return { ok: false, error: 'CSRF 令牌不匹配' };
    }
    // 3) token 必须由 server 签发过（防攻击者伪造 cookie）
    //    防御性容错：verifyToken 抛错（如 Redis 短暂抖动）时 fail-closed 拒绝请求，
    //    而非让异常冒泡导致请求处理链 500。与 rate-limit.js「Redis 不可用降级」理念一致。
    if (verifyToken) {
      let valid = false;
      try {
        valid = await verifyToken(headerToken);
      } catch {
        // Redis 查询失败等场景：保守拒绝，避免放行伪造 token
        return { ok: false, error: 'CSRF 令牌无效或已过期' };
      }
      if (!valid) return { ok: false, error: 'CSRF 令牌无效或已过期' };
    }

    return { ok: true };
  }

  /**
   * 便捷包装：验证失败时自动发送 403 响应
   * @returns {Promise<boolean>} true=通过（继续处理），false=已拒绝（已响应）
   */
  async function gate(req, res) {
    const r = await enforce(req);
    if (r.ok) return true;
    if (sendJSON) {
      sendJSON(res, { error: r.error || 'CSRF 校验失败' }, 403, req);
    } else {
      try {
        if (!res.headersSent) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: r.error || 'CSRF 校验失败' }));
        }
      } catch {}
    }
    return false;
  }

  return { enforce, gate, isExempt, config: { CSRF_ENFORCED } };
}

module.exports = { createCSRFMiddleware, readCookie };
