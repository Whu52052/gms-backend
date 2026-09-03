/**
 * lib/password.js — S6 密码哈希升级（scrypt）
 *
 * 设计要点：
 *   - 新密码使用 scrypt(N=32768, r=8, p=1) + 随机 16 字节 salt
 *   - 输出格式: "scrypt$<salt-base64>$<hash-hex>"
 *   - 旧密码（SHA-256 格式 "sha256<hex>" 或纯 hex）保持向后兼容
 *   - verifyPassword 自动检测格式：scrypt 走 scrypt 验证，其余走 SHA-256 回退
 *   - upgradeHash 用于登录成功后自动升级旧哈希 → scrypt
 *
 * scrypt 参数选择：
 *   N=32768 (2^15), r=8, p=1 → 单哈希约 100-200ms，CPU 密集抗暴力破解
 *   keylen=64 (512-bit)，maxmem=128MB 防内存 DoS
 *   （Node 默认 maxmem=32MB，此处显式设 128MB 以支持 N=32768）
 */
'use strict';

const crypto = require('crypto');

// scrypt 参数 — 与 OWASP 2023 推荐值对齐（服务器端存储密码）
const SCRYPT_N = 32768;    // CPU 成本（迭代次数 = N * log2(N) ≈ 2^15 * 15 ≈ 500K）
const SCRYPT_R = 8;       // 块大小
const SCRYPT_P = 1;       // 并行度（单线程足够）
const SCRYPT_KEYLEN = 64; // 输出长度 512-bit
const SCRYPT_MAXMEM = 128 * 1024 * 1024; // 128MB 防内存 DoS

// 旧版密码盐值（与 server.js hashPassword 保持一致，用于 verifyPassword 回退）
const LEGACY_SALT = 'gms-salt';

// Hash 格式前缀
const SCRYPT_PREFIX = 'scrypt$';
const SHA256_PREFIX = 'sha256'; // 旧格式可能带此前缀或纯 hex

/**
 * 生成 scrypt 哈希。每次调用生成随机盐。
 * @param {string} password 明文密码
 * @returns {Promise<string>} "scrypt$<salt-b64>$<hash-hex>"
 */
async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, SCRYPT_KEYLEN, {
      N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: SCRYPT_MAXMEM,
    }, (err, derivedKey) => {
      if (err) reject(err);
      else resolve(derivedKey.toString('hex'));
    });
  });
  return `${SCRYPT_PREFIX}${salt.toString('base64')}$${hash}`;
}

/**
 * 同步版本（用于种子数据等同步场景）。仅用于低并发写入。
 * 注意：scryptSync 会阻塞事件循环，不要在高并发路径使用。
 */
function hashPasswordSync(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: SCRYPT_MAXMEM,
  });
  return `${SCRYPT_PREFIX}${salt.toString('base64')}$${hash.toString('hex')}`;
}

/**
 * 验证密码。自动检测哈希格式：
 *   - "scrypt$salt$hash" → scrypt 验证（恒定时间比较）
 *   - "sha256..." 或纯 64-char hex → SHA-256 回退（向后兼容旧用户）
 *   - 其他 → 返回 false
 *
 * @param {string} password 明文密码
 * @param {string} storedHash 数据库中存储的哈希
 * @returns {Promise<{valid:boolean, upgraded:boolean, newHash?:string}>}
 *   upgraded=true 表示密码有效但格式为旧版，调用方应持久化 newHash
 */
async function verifyPassword(password, storedHash) {
  if (!password || !storedHash) return { valid: false, upgraded: false };

  // === scrypt 路径 ===
  if (storedHash.startsWith(SCRYPT_PREFIX)) {
    const parts = storedHash.slice(SCRYPT_PREFIX.length).split('$');
    if (parts.length !== 2) return { valid: false, upgraded: false };
    try {
      const salt = Buffer.from(parts[0], 'base64');
      const expectedHash = parts[1];
      const actualHash = await new Promise((resolve, reject) => {
        crypto.scrypt(password, salt, SCRYPT_KEYLEN, {
          N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: SCRYPT_MAXMEM,
        }, (err, derivedKey) => {
          if (err) reject(err);
          else resolve(derivedKey.toString('hex'));
        });
      });
      // 恒定时间比较
      const valid = crypto.timingSafeEqual(
        Buffer.from(expectedHash, 'hex'),
        Buffer.from(actualHash, 'hex')
      );
      return { valid, upgraded: false };
    } catch {
      return { valid: false, upgraded: false };
    }
  }

  // === SHA-256 回退路径（向后兼容）===
  // 旧版 hashPassword: crypto.createHash('sha256').update(pw + 'gms-salt').digest('hex')
  let legacyHash = storedHash;
  if (storedHash.startsWith(SHA256_PREFIX)) {
    legacyHash = storedHash.slice(SHA256_PREFIX.length);
  }
  // 验证是否为合法 SHA-256 hex（64 字符）
  if (!/^[0-9a-f]{64}$/i.test(legacyHash)) {
    return { valid: false, upgraded: false };
  }
  const actualHash = crypto.createHash('sha256').update(password + LEGACY_SALT).digest('hex');
  const valid = actualHash === legacyHash;
  if (valid) {
    // 密码正确但格式为旧版 → 返回 upgraded=true 让调用方自动升级
    const newHash = await hashPassword(password);
    return { valid: true, upgraded: true, newHash };
  }
  return { valid: false, upgraded: false };
}

/**
 * 旧版 hashPassword 纯函数（用于种子数据 / 已哈希数据的格式转换）
 * 仅用于内部迁移，不要在新代码中使用。
 */
function legacyHashPassword(pw) {
  return crypto.createHash('sha256').update(pw + LEGACY_SALT).digest('hex');
}

module.exports = {
  hashPassword,
  hashPasswordSync,
  verifyPassword,
  legacyHashPassword,
  // 导出常量供测试使用
  SCRYPT_N,
  SCRYPT_R,
  SCRYPT_P,
  SCRYPT_KEYLEN,
  SCRYPT_MAXMEM,
  LEGACY_SALT,
  SCRYPT_PREFIX,
};
