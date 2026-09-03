/**
 * Unit tests for lib/client-ip.js — 客户端 IP 提取
 * Run: node --test tests/unit/client-ip.test.js
 */
const { test, describe } = require('node:test');
const assert = require('node:assert');
const { getClientIp, stripV6Prefix } = require('../../lib/client-ip');

function mockReq({ socketAddr, headers = {} }) {
  return { socket: { remoteAddress: socketAddr }, headers };
}

describe('getClientIp', () => {
  test('非本机来源直接返回 socket 地址（不信任 XFF）', () => {
    const req = mockReq({ socketAddr: '203.0.113.5', headers: { 'x-forwarded-for': '1.1.1.1' } });
    assert.strictEqual(getClientIp(req), '203.0.113.5');
  });

  test('本机来源 + XFF → 取 XFF 第一个 IP', () => {
    const req = mockReq({ socketAddr: '127.0.0.1', headers: { 'x-forwarded-for': '203.0.113.10, 10.0.0.1' } });
    assert.strictEqual(getClientIp(req), '203.0.113.10');
  });

  test('本机来源 + X-Real-IP（无 XFF）', () => {
    const req = mockReq({ socketAddr: '127.0.0.1', headers: { 'x-real-ip': '198.51.100.7' } });
    assert.strictEqual(getClientIp(req), '198.51.100.7');
  });

  test('剥掉 IPv6 ::ffff: 前缀', () => {
    const req = mockReq({ socketAddr: '::ffff:203.0.113.5' });
    assert.strictEqual(getClientIp(req), '203.0.113.5');
  });

  test('本机 IPv6 ::1 也信任 XFF', () => {
    const req = mockReq({ socketAddr: '::1', headers: { 'x-forwarded-for': '192.0.2.3' } });
    assert.strictEqual(getClientIp(req), '192.0.2.3');
  });

  test('null req → "unknown"', () => {
    assert.strictEqual(getClientIp(null), 'unknown');
    assert.strictEqual(getClientIp(undefined), 'unknown');
  });

  test('无 socket 无 header → "unknown"', () => {
    assert.strictEqual(getClientIp({ socket: {}, headers: {} }), 'unknown');
  });
});

describe('stripV6Prefix', () => {
  test('剥掉 ::ffff: 前缀', () => {
    assert.strictEqual(stripV6Prefix('::ffff:192.168.1.1'), '192.168.1.1');
  });
  test('无前缀的 IP 不变', () => {
    assert.strictEqual(stripV6Prefix('10.0.0.1'), '10.0.0.1');
    assert.strictEqual(stripV6Prefix('::1'), '::1');
  });
  test('非字符串原样返回', () => {
    assert.strictEqual(stripV6Prefix(null), null);
    assert.strictEqual(stripV6Prefix(123), 123);
  });
});
