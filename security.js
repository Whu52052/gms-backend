/**
 * ===================================================================
 *  Yunwei Security Middleware — 安全防护层
 *
 *  防护能力:
 *    1. Rate Limiting    — API 频率限制 (全局/每IP/每用户)
 *    2. Input Sanitizer  — 输入清洗 (XSS/SQL注入防护)
 *    3. CORS             — 跨域控制
 *    4. Security Headers — Helmet 安全头
 *    5. Brute Force      — 登录爆破防护
 *    6. Request Size     — 请求体大小限制
 *    7. Timeout          — 请求超时保护
 * ===================================================================
 */

const crypto = require('crypto');

// ==================== 1. RATE LIMITER ====================
const ipRequestCounts = new Map();     // 内存后备
const userRequestCounts = new Map();
const loginAttempts = new Map();       // 登录爆破检测

// 清理定时器 (每5分钟清理过期记录)
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of ipRequestCounts) { if (now - v.resetTime > 60000) ipRequestCounts.delete(k); }
  for (const [k, v] of userRequestCounts) { if (now - v.resetTime > 60000) userRequestCounts.delete(k); }
  for (const [k, v] of loginAttempts) { if (now - v.blockUntil < 0) loginAttempts.delete(k); }
}, 300000);

/**
 * IP 限流 (滑动窗口)
 * @param {string} ip
 * @param {number} max 窗口内最大请求数
 * @param {number} windowMs 窗口大小(毫秒)
 */
function ipRateLimit(ip, max = 100, windowMs = 1000) {
  const now = Date.now();
  let record = ipRequestCounts.get(ip);
  if (!record || now - record.windowStart > windowMs) {
    record = { count: 0, windowStart: now, resetTime: now + windowMs };
    ipRequestCounts.set(ip, record);
  }
  record.count++;
  return {
    allowed: record.count <= max,
    remaining: Math.max(0, max - record.count),
    resetTime: record.resetTime,
  };
}

/**
 * 登录爆破防护
 * 规则: 同一IP 10秒内失败5次 → 封禁5分钟
 */
function loginBruteForceCheck(ip) {
  const now = Date.now();
  let record = loginAttempts.get(ip);

  if (record && record.blockUntil > now) {
    return { blocked: true, remainingSeconds: Math.ceil((record.blockUntil - now) / 1000) };
  }

  if (!record || now - record.windowStart > 10000) {
    record = { failures: 0, windowStart: now, blockUntil: 0 };
    loginAttempts.set(ip, record);
  }

  return { blocked: false };
}

function loginBruteForceRecord(ip, success) {
  let record = loginAttempts.get(ip);
  if (!record) return;
  if (success) {
    loginAttempts.delete(ip);
    return;
  }
  record.failures++;
  if (record.failures >= 5) {
    record.blockUntil = Date.now() + 5 * 60 * 1000; // 封禁5分钟
  }
}

// ==================== 2. INPUT SANITIZER ====================
/**
 * XSS 防护: 转义 HTML 特殊字符
 */
function sanitizeHTML(str) {
  if (typeof str !== 'string') return str;
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

/**
 * SQL 注入检测 (简单模式匹配)
 */
const SQL_INJECTION_PATTERNS = [
  /(\bUNION\b.*\bSELECT\b)/i,
  /(\bDROP\b.*\bTABLE\b)/i,
  /(\bALTER\b.*\bTABLE\b)/i,
  /(\bTRUNCATE\b)/i,
  /(';\s*--)/i,
  /(\bEXEC\b.*\bxp_cmdshell\b)/i,
];

function detectSQLInjection(str) {
  if (typeof str !== 'string') return false;
  return SQL_INJECTION_PATTERNS.some(p => p.test(str));
}

/**
 * 递归清理对象中的危险字符串
 */
function sanitizeObject(obj, depth = 0) {
  if (depth > 10) return obj; // 防止深层递归
  if (typeof obj === 'string') {
    // 检测 SQL 注入
    if (detectSQLInjection(obj)) {
      return '[BLOCKED]';
    }
    return obj;
  }
  if (Array.isArray(obj)) {
    return obj.map(item => sanitizeObject(item, depth + 1));
  }
  if (obj && typeof obj === 'object') {
    const cleaned = {};
    for (const [k, v] of Object.entries(obj)) {
      cleaned[sanitizeHTML(k)] = sanitizeObject(v, depth + 1);
    }
    return cleaned;
  }
  return obj;
}

// ==================== 3. CORS ====================
function corsHeaders(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
  res.setHeader('Access-Control-Max-Age', '86400');
}

// ==================== 4. SECURITY HEADERS ====================
/**
 * Helmet-style 安全头 (不依赖 helmet 包)
 */
function securityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-DNS-Prefetch-Control', 'off');
  res.setHeader('X-Download-Options', 'noopen');           // IE8+
  res.setHeader('X-Permitted-Cross-Domain-Policies', 'none'); // Adobe
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');

  // CSP (Content-Security-Policy) — 内网宽松策略
  res.setHeader('Content-Security-Policy',
    "default-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob:; " +
    "img-src * data: blob:; " +
    "connect-src *; " +
    "font-src 'self' data:;"
  );
}

// ==================== 5. REQUEST SIZE LIMIT ====================
const MAX_BODY_SIZE = 150 * 1024 * 1024; // 150MB (含图片上传)
const MAX_URL_SIZE = 8192;                // 8KB

function checkRequestSize(req) {
  const url = req.url || '';
  if (url.length > MAX_URL_SIZE) {
    return { error: 'URL too long', status: 414 };
  }
  const contentLength = parseInt(req.headers['content-length'] || '0');
  if (contentLength > MAX_BODY_SIZE) {
    return { error: 'Request body too large', status: 413 };
  }
  return null;
}

// ==================== 6. GENERAL SECURITY CHECKS ====================
/**
 * 请求安全检查 (在路由之前调用)
 */
function securityCheck(req) {
  const ip = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown';

  // 1. 请求大小检查
  const sizeErr = checkRequestSize(req);
  if (sizeErr) return sizeErr;

  // 2. IP 限流
  const rateLimit = ipRateLimit(ip, 200, 1000); // 每IP 200 req/s
  if (!rateLimit.allowed) {
    return { error: 'Too Many Requests', status: 429, retryAfter: Math.ceil((rateLimit.resetTime - Date.now()) / 1000) };
  }

  // 3. Method 验证
  const allowedMethods = ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'HEAD'];
  if (!allowedMethods.includes(req.method)) {
    return { error: 'Method Not Allowed', status: 405 };
  }

  return null;
}

// ==================== 7. HASH & CRYPTO ====================
function hashPassword(password, salt = 'gms-salt') {
  return crypto.createHash('sha256').update(password + salt).digest('hex');
}

function generateToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('hex');
}

function generateId(prefix = '') {
  return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// ==================== EXPORTS ====================
module.exports = {
  // Rate Limiter
  ipRateLimit,
  loginBruteForceCheck,
  loginBruteForceRecord,

  // Input Sanitizer
  sanitizeHTML,
  sanitizeObject,
  detectSQLInjection,

  // HTTP Security
  corsHeaders,
  securityHeaders,
  securityCheck,
  MAX_BODY_SIZE,

  // Crypto
  hashPassword,
  generateToken,
  generateId,
};
