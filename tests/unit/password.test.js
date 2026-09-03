/**
 * Unit tests for lib/password.js — S6 scrypt password hashing
 * Run: node --test tests/unit/password.test.js
 *
 * 覆盖：
 *   - hashPassword: scrypt 格式正确性（前缀、分隔符、长度）
 *   - hashPassword: 相同密码两次哈希结果不同（随机盐）
 *   - verifyPassword: scrypt 正确密码 → valid=true
 *   - verifyPassword: scrypt 错误密码 → valid=false
 *   - verifyPassword: scrypt 空密码 → valid=false
 *   - verifyPassword: 旧版 SHA-256 格式正确密码 → valid=true + upgraded=true
 *   - verifyPassword: 旧版 SHA-256 错误密码 → valid=false
 *   - verifyPassword: 非法格式 → valid=false
 *   - verifyPassword: 空输入 → valid=false
 *   - 向后兼容: legacy SHA-256 哈希验证通过
 *   - 自动升级: 旧格式验证通过后返回 newHash
 *
 * 注意: scrypt(N=32768) 每个哈希约 100-200ms，测试控制在合理次数内。
 */
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert');

const {
  hashPassword,
  hashPasswordSync,
  verifyPassword,
  legacyHashPassword,
  SCRYPT_PREFIX,
  SCRYPT_N,
} = require('../../lib/password');

// 测试用密码（强度足以通过 S6 变更密码策略校验）
const TEST_PASSWORD = 'TestPass123';
const LEGACY_PASSWORD = 'OldPass456';

// 预生成 scrypt 哈希（每次测试随机盐，所以不同）
let scryptHash;

describe('password.js — S6 scrypt hashing', () => {
  beforeEach(async () => {
    scryptHash = await hashPassword(TEST_PASSWORD);
  });

  test('hashPassword returns scrypt format with correct prefix', async () => {
    assert.ok(scryptHash.startsWith(SCRYPT_PREFIX),
      `expected "${SCRYPT_PREFIX}..." prefix, got "${scryptHash.slice(0, 20)}..."`);
    const parts = scryptHash.slice(SCRYPT_PREFIX.length).split('$');
    assert.strictEqual(parts.length, 2, 'should have exactly 2 $-separated parts (salt, hash)');
    // salt is base64 (16 bytes → ~24 chars)
    assert.ok(parts[0].length >= 20 && parts[0].length <= 30,
      `salt base64 length should be ~24, got ${parts[0].length}`);
    // hash is hex (64 bytes → 128 chars)
    assert.strictEqual(parts[1].length, 128,
      `expected 128 hex chars for 64-byte hash, got ${parts[1].length}`);
    assert.ok(/^[0-9a-f]{128}$/i.test(parts[1]),
      'hash part should be 128 hex chars');
  });

  test('hashPassword produces different hashes for same password (random salt)', async () => {
    const hash1 = await hashPassword(TEST_PASSWORD);
    const hash2 = await hashPassword(TEST_PASSWORD);
    assert.notStrictEqual(hash1, hash2,
      'same password should produce different hashes due to random salt');
    // But both should verify correctly
    const r1 = await verifyPassword(TEST_PASSWORD, hash1);
    const r2 = await verifyPassword(TEST_PASSWORD, hash2);
    assert.strictEqual(r1.valid, true);
    assert.strictEqual(r2.valid, true);
  });

  test('verifyPassword succeeds with correct scrypt hash', async () => {
    const result = await verifyPassword(TEST_PASSWORD, scryptHash);
    assert.strictEqual(result.valid, true);
    assert.strictEqual(result.upgraded, false); // already scrypt, no upgrade needed
    assert.strictEqual(result.newHash, undefined);
  });

  test('verifyPassword fails with wrong password on scrypt hash', async () => {
    const result = await verifyPassword('WrongPassword1', scryptHash);
    assert.strictEqual(result.valid, false);
    assert.strictEqual(result.upgraded, false);
  });

  test('verifyPassword fails with empty password', async () => {
    const result = await verifyPassword('', scryptHash);
    assert.strictEqual(result.valid, false);
  });

  test('verifyPassword fails with null inputs', async () => {
    const r1 = await verifyPassword(null, scryptHash);
    assert.strictEqual(r1.valid, false);
    const r2 = await verifyPassword(TEST_PASSWORD, null);
    assert.strictEqual(r2.valid, false);
    const r3 = await verifyPassword(null, null);
    assert.strictEqual(r3.valid, false);
  });

  test('verifyPassword with legacy SHA-256 hash — succeeds and flags upgrade', async () => {
    // Create a legacy hash (mimics old hashPassword: sha256 + 'gms-salt')
    const legacyHash = legacyHashPassword(LEGACY_PASSWORD);
    assert.ok(/^[0-9a-f]{64}$/i.test(legacyHash), 'legacy hash should be 64-char hex');

    const result = await verifyPassword(LEGACY_PASSWORD, legacyHash);
    assert.strictEqual(result.valid, true);
    assert.strictEqual(result.upgraded, true);
    assert.ok(result.newHash, 'should provide new scrypt hash for upgrade');
    assert.ok(result.newHash.startsWith(SCRYPT_PREFIX), 'newHash should be scrypt format');
  });

  test('verifyPassword with legacy SHA-256 hash — fails with wrong password', async () => {
    const legacyHash = legacyHashPassword(LEGACY_PASSWORD);
    const result = await verifyPassword('WrongPass999', legacyHash);
    assert.strictEqual(result.valid, false);
    assert.strictEqual(result.upgraded, false);
  });

  test('verifyPassword rejects garbage input', async () => {
    const r1 = await verifyPassword(TEST_PASSWORD, 'garbage-not-a-hash');
    assert.strictEqual(r1.valid, false);
    const r2 = await verifyPassword(TEST_PASSWORD, 'scrypt$invalid');
    assert.strictEqual(r2.valid, false);
    // 64-char hex but with wrong chars
    const r3 = await verifyPassword(TEST_PASSWORD, 'g'.repeat(64));
    assert.strictEqual(r3.valid, false);
  });

  test('auto-upgrade newHash verifies correctly as scrypt', async () => {
    const legacyHash = legacyHashPassword(LEGACY_PASSWORD);
    const result = await verifyPassword(LEGACY_PASSWORD, legacyHash);
    assert.strictEqual(result.upgraded, true);
    // The newHash should be a valid scrypt hash that also verifies
    const reVerify = await verifyPassword(LEGACY_PASSWORD, result.newHash);
    assert.strictEqual(reVerify.valid, true);
    assert.strictEqual(reVerify.upgraded, false); // already upgraded, no double-upgrade
  });

  test('hashPasswordSync produces valid scrypt hash', () => {
    const syncHash = hashPasswordSync(TEST_PASSWORD);
    assert.ok(syncHash.startsWith(SCRYPT_PREFIX));
    // Verify it
    verifyPassword(TEST_PASSWORD, syncHash).then(result => {
      assert.strictEqual(result.valid, true);
    });
  });

  test('scrypt params use expected N value', () => {
    assert.strictEqual(SCRYPT_N, 32768,
      'SCRYPT_N should be 32768 (OWASP 2023 recommended)');
  });
});
