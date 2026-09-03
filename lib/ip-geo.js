/**
 * lib/ip-geo.js
 * Server-side IP → place-name resolution with caching.
 *
 * Uses ip-api.com's free JSON endpoint (HTTP, no API key, 45 req/min).
 * Results are cached in Redis (7-day TTL) with an in-memory LRU fallback
 * so the same IP never triggers a second network round-trip.
 *
 * Private/loopback IPs resolve to "本地" without any network call.
 */
'use strict';

const http = require('http');

const MEM_CACHE_MAX = 500;
const memCache = new Map();

function isPrivateIp(ip) {
  if (!ip || ip === 'unknown' || ip === 'localhost') return true;
  return /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.|::1$|fc00:|fe80:)/i.test(ip);
}

function _setMem(ip, location) {
  if (memCache.size >= MEM_CACHE_MAX) {
    const firstKey = memCache.keys().next().value;
    memCache.delete(firstKey);
  }
  memCache.set(ip, location);
}

/**
 * Resolve an IP address to a Chinese place-name string.
 * @param {string} ip        — IPv4 / IPv6 address
 * @param {object|null} redisClient — optional Redis client for persistent caching
 * @returns {Promise<string>} — e.g. "中国 北京市 北京市" or "本地" for private IPs
 */
function lookupIpLocation(ip, redisClient) {
  if (!ip || isPrivateIp(ip)) return Promise.resolve('本地');

  // 1. Redis cache
  if (redisClient) {
    return redisClient.get(`ipgeo:${ip}`)
      .then(cached => {
        if (cached) return cached;
        return _fetchFromApi(ip, redisClient);
      })
      .catch(() => _fetchFromApi(ip, redisClient));
  }

  // 2. In-memory cache only
  if (memCache.has(ip)) return Promise.resolve(memCache.get(ip));
  return _fetchFromApi(ip, null);
}

function _fetchFromApi(ip, redisClient) {
  return new Promise(resolve => {
    const url = `http://ip-api.com/json/${encodeURIComponent(ip)}?lang=zh-CN&fields=status,country,regionName,city`;
    const req = http.get(url, { timeout: 3000 }, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        let location = ip; // fallback to raw IP on any error
        try {
          const json = JSON.parse(data);
          if (json.status === 'success') {
            const parts = [json.country, json.regionName, json.city].filter(Boolean);
            location = parts.join(' ') || ip;
          }
        } catch { /* keep fallback */ }

        _setMem(ip, location);
        if (redisClient) {
          redisClient.set(`ipgeo:${ip}`, location, 'EX', 7 * 24 * 3600).catch(() => {});
        }
        resolve(location);
      });
    });
    req.on('error', () => resolve(ip));
    req.on('timeout', () => { req.destroy(); resolve(ip); });
  });
}

module.exports = { lookupIpLocation, isPrivateIp };
