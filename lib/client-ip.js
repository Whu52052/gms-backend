/**
 * Client IP 提取 — 兼容 nginx 反向代理场景
 *
 * 部署架构：nginx → PM2 3 实例（端口 8765/8766/8767）
 * 若不处理 x-forwarded-for，所有请求来源 IP 都是 127.0.0.1，限流会失效。
 *
 * 安全策略：仅当直连来源是本机（127.0.0.1 / ::1 / ::ffff:127.0.0.1）时
 * 才信任 x-forwarded-for。防止客户端伪造 XFF 头绕过限流。
 */

const LOCAL_IPS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/**
 * 判断请求是否为 HTTPS（用于 Secure cookie 等场景）。
 * 优先级：env HTTPS_ENABLED=true → 总是 true；
 *         否则信任来自本机代理的 x-forwarded-proto=https。
 * @param {import('http').IncomingMessage} req
 * @returns {boolean}
 */
function isHttps(req) {
  if (process.env.HTTPS_ENABLED === 'true') return true;
  if (!req) return false;
  const socketAddr = req.socket?.remoteAddress || '';
  // 仅信任来自本机代理的 proto 头（防客户端伪造）
  if (!LOCAL_IPS.has(socketAddr)) return false;
  const xfp = req.headers['x-forwarded-proto'];
  return xfp ? String(xfp).split(',')[0].trim().toLowerCase() === 'https' : false;
}

/**
 * 从请求对象提取真实客户端 IP。
 * @param {import('http').IncomingMessage} req
 * @returns {string} IP 地址（剥掉 IPv6 ::ffff: 前缀）；无法判断时返回 'unknown'
 */
function getClientIp(req) {
  if (!req) return 'unknown';
  const socketAddr = req.socket?.remoteAddress || req.connection?.remoteAddress || '';
  const isLocal = LOCAL_IPS.has(socketAddr);

  if (isLocal) {
    // 来自 nginx 反代，信任 XFF（取第一个，即最左边的客户端 IP）
    const xff = req.headers['x-forwarded-for'];
    if (xff) {
      const first = String(xff).split(',')[0].trim();
      if (first) return stripV6Prefix(first);
    }
    // nginx 也可能用 X-Real-IP
    const realIp = req.headers['x-real-ip'];
    if (realIp) return stripV6Prefix(String(realIp).trim());
  }

  // 非本机来源：直接用 socket 地址（不信任 XFF，防伪造）
  if (socketAddr) return stripV6Prefix(socketAddr);
  return 'unknown';
}

/** 去掉 IPv4-mapped IPv6 前缀 ::ffff: */
function stripV6Prefix(ip) {
  if (typeof ip !== 'string') return ip;
  if (ip.startsWith('::ffff:')) return ip.slice(7);
  return ip;
}

module.exports = { getClientIp, stripV6Prefix, isHttps };
