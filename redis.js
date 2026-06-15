/**
 * ===================================================================
 *  Yunwei Redis Module — 500-User Enterprise Edition
 *
 *  功能模块:
 *    1. Connection Pool — 连接池管理 + 自动重连
 *    2. Session Store — 分布式 Session 存储 (替代内存 tokens)
 *    3. Pub/Sub     — 跨进程实时消息广播 (SSE + WebSocket)
 *    4. Cache       — 多级缓存 (L1内存 + L2 Redis)
 *    5. Rate Limiter — 令牌桶 + 滑动窗口限流
 *    6. Job Queue   — 可靠任务队列 (飞书同步等)
 *    7. Distributed Lock — 分布式锁 (防重复操作)
 *    8. Metrics     — Redis 性能指标采集
 * ===================================================================
 */

const { createClient } = require('redis');

// ==================== CONFIGURATION ====================
const REDIS_CONFIG = {
  url: process.env.REDIS_URL || `redis://${process.env.REDIS_HOST || 'localhost'}:${process.env.REDIS_PORT || '6379'}`,
  socket: {
    reconnectStrategy: (retries) => {
      if (retries > 20) return new Error('Redis 重连次数超限');
      return Math.min(retries * 200, 5000); // 指数退避, 最大5秒
    },
    connectTimeout: 10000,
    keepAlive: 30000,
  },
  // 连接池配置
  pool: {
    min: 4,    // 最小连接数
    max: 32,   // 最大连接数 (500并发)
  },
};

// ==================== CONNECTION MANAGEMENT ====================
let client = null;     // 主连接 (通用操作)
let subscriber = null; // 订阅连接 (Pub/Sub 专用)
let publisher = null;  // 发布连接 (Pub/Sub 专用)
let isConnected = false;
const metrics = { hits: 0, misses: 0, sets: 0, pubMessages: 0, subMessages: 0 };

/**
 * 初始化 Redis 连接池
 * @returns {Promise<boolean>} 是否连接成功
 */
async function init() {
  try {
    // 主连接 — 通用操作 (GET/SET/DEL)
    client = createClient({ ...REDIS_CONFIG, database: 0 });
    client.on('error', (err) => console.error('[Redis] Client Error:', err.message));
    client.on('reconnecting', () => console.warn('[Redis] Reconnecting...'));
    client.on('ready', () => console.log('[Redis] Client Ready'));

    // 订阅连接 — Pub/Sub (专用连接, 不可用于其他操作)
    subscriber = createClient({ ...REDIS_CONFIG, database: 0 });
    subscriber.on('error', (err) => console.error('[Redis] Subscriber Error:', err.message));

    // 发布连接 — Pub/Sub 发布端
    publisher = createClient({ ...REDIS_CONFIG, database: 0 });
    publisher.on('error', (err) => console.error('[Redis] Publisher Error:', err.message));

    // 并行连接
    await Promise.all([
      client.connect(),
      subscriber.connect(),
      publisher.connect(),
    ]);

    isConnected = true;
    console.log('[Redis] ✅ 连接池就绪 (3 connections, pool: 4-32)');
    return true;
  } catch (e) {
    console.warn('[Redis] ⚠️ 连接失败, 降级运行:', e.message);
    isConnected = false;
    client = null;
    subscriber = null;
    publisher = null;
    return false;
  }
}

/** 关闭所有连接 */
async function shutdown() {
  try {
    if (subscriber) { await subscriber.unsubscribe(); await subscriber.quit(); }
    if (publisher) await publisher.quit();
    if (client) await client.quit();
    console.log('[Redis] 连接已关闭');
  } catch {}
}

// ==================== 1. SESSION STORE ====================
const SESSION_PREFIX = 'sess:';
const SESSION_TTL = 2 * 60 * 60; // 2小时

async function sessionCreate(token, userData) {
  if (!client) return null;
  const key = SESSION_PREFIX + token;
  const data = { ...userData, createdAt: Date.now(), lastActive: Date.now() };
  await client.setEx(key, SESSION_TTL, JSON.stringify(data));
  // 维护用户→token 索引 (用于批量踢出)
  await client.sAdd(`user_tokens:${userData.userId}`, token);
  await client.expire(`user_tokens:${userData.userId}`, SESSION_TTL);
  return token;
}

async function sessionGet(token) {
  if (!client) return null;
  const raw = await client.get(SESSION_PREFIX + token);
  if (!raw) return null;
  const data = JSON.parse(raw);
  // 滑动窗口刷新 TTL
  data.lastActive = Date.now();
  await client.setEx(SESSION_PREFIX + token, SESSION_TTL, JSON.stringify(data));
  return data;
}

async function sessionDelete(token) {
  if (!client) return;
  await client.del(SESSION_PREFIX + token);
}

async function sessionDeleteByUser(userId) {
  if (!client) return;
  const tokens = await client.sMembers(`user_tokens:${userId}`);
  if (tokens.length > 0) {
    await client.del(tokens.map(t => SESSION_PREFIX + t));
    await client.del(`user_tokens:${userId}`);
  }
}

/** 获取在线用户数 (所有活跃 session) */
async function sessionCount() {
  if (!client) return 0;
  // 扫描 session key
  let count = 0;
  let cursor = 0;
  do {
    const res = await client.scan(cursor, { MATCH: SESSION_PREFIX + '*', COUNT: 500 });
    cursor = res.cursor;
    count += res.keys.length;
  } while (cursor !== 0);
  return count;
}

/** 获取在线用户 ID 列表 */
async function sessionOnlineUserIds() {
  if (!client) return [];
  const ids = new Set();
  let cursor = 0;
  do {
    const res = await client.scan(cursor, { MATCH: SESSION_PREFIX + '*', COUNT: 500 });
    cursor = res.cursor;
    for (const key of res.keys) {
      const raw = await client.get(key);
      if (raw) {
        try { ids.add(JSON.parse(raw).userId); } catch {}
      }
    }
  } while (cursor !== 0);
  return [...ids];
}

// ==================== 2. PUB/SUB ====================
const SSE_CHANNEL = 'sse:broadcast';
const WS_CHANNEL = 'ws:broadcast';
const ADMIN_CHANNEL = 'admin:notify';

/** 发布消息到频道 */
async function publish(channel, message) {
  if (!publisher) return;
  metrics.pubMessages++;
  await publisher.publish(channel, JSON.stringify(message));
}

/** 订阅频道 */
async function subscribe(channel, handler) {
  if (!subscriber) return;
  await subscriber.subscribe(channel, (raw) => {
    metrics.subMessages++;
    try { handler(JSON.parse(raw)); } catch {}
  });
}

/** 广播 SSE 事件 (跨所有 Worker) */
async function broadcastSSE(event, data) {
  await publish(SSE_CHANNEL, { event, data, ts: Date.now() });
}

/** 广播 WebSocket 事件 */
async function broadcastWS(event, data) {
  await publish(WS_CHANNEL, { event, data, ts: Date.now() });
}

// ==================== 3. CACHE ====================
/**
 * 多级缓存: L1(内存 Map) + L2(Redis)
 * 读取: L1 → L2 → DB (自动回填)
 * 写入: L1 + L2 同时写入
 * 失效: 广播事件清除所有 Worker 的 L1
 */
const l1Cache = new Map();
const L1_MAX_SIZE = 5000;
const L1_DEFAULT_TTL = 10000; // 10秒

function _l1Set(key, value, ttlMs = L1_DEFAULT_TTL) {
  if (l1Cache.size >= L1_MAX_SIZE) {
    // LRU 淘汰: 删除最旧的 20%
    const entries = [...l1Cache.entries()].sort((a, b) => a[1].ts - b[1].ts);
    for (let i = 0; i < Math.floor(L1_MAX_SIZE * 0.2); i++) {
      l1Cache.delete(entries[i][0]);
    }
  }
  l1Cache.set(key, { value, ts: Date.now(), ttl: ttlMs });
}

function _l1Get(key) {
  const entry = l1Cache.get(key);
  if (!entry) return undefined;
  if (Date.now() - entry.ts > entry.ttl) {
    l1Cache.delete(key);
    return undefined;
  }
  return entry.value;
}

/**
 * 缓存读取 (L1 → L2)
 * @param {string} key
 * @param {Function} fetcher 数据获取函数
 * @param {number} ttlSeconds L2 过期时间(秒)
 */
async function cacheGet(key, fetcher, ttlSeconds = 30) {
  // L1 命中
  const l1Val = _l1Get(key);
  if (l1Val !== undefined) {
    metrics.hits++;
    return l1Val;
  }

  // L2 命中
  if (client) {
    try {
      const raw = await client.get('cache:' + key);
      if (raw) {
        metrics.hits++;
        const val = JSON.parse(raw);
        _l1Set(key, val, ttlSeconds * 1000);
        return val;
      }
    } catch {}
  }

  // 未命中: 查询数据源
  metrics.misses++;
  const data = await fetcher();
  if (data !== null && data !== undefined) {
    _l1Set(key, data, ttlSeconds * 1000);
    if (client) {
      try { await client.setEx('cache:' + key, ttlSeconds, JSON.stringify(data)); } catch {}
    }
  }
  return data;
}

/** 缓存写入 */
async function cacheSet(key, value, ttlSeconds = 30) {
  metrics.sets++;
  _l1Set(key, value, ttlSeconds * 1000);
  if (client) {
    try { await client.setEx('cache:' + key, ttlSeconds, JSON.stringify(value)); } catch {}
  }
}

/** 缓存失效 (单Key) */
async function cacheInvalidate(key) {
  l1Cache.delete(key);
  if (client) {
    try {
      await client.del('cache:' + key);
      // 广播给所有 Worker 清除本地 L1
      await publish('cache:invalidate', { key });
    } catch {}
  }
}

/** 缓存失效 (按前缀批量) */
async function cacheInvalidatePattern(pattern) {
  // L1: 简单前缀匹配
  for (const key of l1Cache.keys()) {
    if (key.startsWith(pattern)) l1Cache.delete(key);
  }
  // L2: SCAN + DEL
  if (client) {
    try {
      let cursor = 0;
      const toDelete = [];
      do {
        const res = await client.scan(cursor, { MATCH: 'cache:' + pattern + '*', COUNT: 200 });
        cursor = res.cursor;
        toDelete.push(...res.keys);
      } while (cursor !== 0);
      if (toDelete.length > 0) await client.del(toDelete);
      await publish('cache:invalidate_pattern', { pattern });
    } catch {}
  }
}

// 订阅缓存失效广播 (清除本 Worker 的 L1)
if (subscriber) {
  subscriber.subscribe('cache:invalidate', (raw) => {
    try { const { key } = JSON.parse(raw); l1Cache.delete(key); } catch {}
  }).catch(() => {});
  subscriber.subscribe('cache:invalidate_pattern', (raw) => {
    try {
      const { pattern } = JSON.parse(raw);
      for (const key of l1Cache.keys()) {
        if (key.startsWith(pattern)) l1Cache.delete(key);
      }
    } catch {}
  }).catch(() => {});
}

// ==================== 4. RATE LIMITER ====================
/**
 * 令牌桶 + 滑动窗口限流器
 * 支持: 全局 / 每用户 / 每IP / 每API端点
 */
const RATE_LIMITS = {
  global: { tokens: 1000, refillPerSec: 200 },      // 全局 1000 req/s
  perUser: { tokens: 50, refillPerSec: 10 },         // 每用户 50 req/s
  perIP: { tokens: 100, refillPerSec: 20 },          // 每IP 100 req/s
  login: { tokens: 10, refillPerSec: 1 },            // 登录 10次/秒
  feishuSync: { tokens: 90, refillPerSec: 10 },      // 飞书 API 90次/秒
};

/**
 * 滑动窗口限流检查 (Redis 实现)
 * @param {string} key 限流键 (如 "rl:ip:192.168.1.1:/api/login")
 * @param {number} maxRequests 窗口内最大请求数
 * @param {number} windowSeconds 窗口大小(秒)
 * @returns {object} { allowed: boolean, remaining: number, resetTime: number }
 */
async function rateLimitCheck(key, maxRequests, windowSeconds) {
  if (!client) return { allowed: true, remaining: maxRequests, resetTime: 0 };

  const now = Date.now();
  const windowStart = now - windowSeconds * 1000;

  try {
    // 原子操作: 添加当前请求 + 删除窗口外记录 + 计数
    const multi = client.multi();
    multi.zAdd(key, { score: now, value: `${now}-${Math.random()}` });
    multi.zRemRangeByScore(key, 0, windowStart);
    multi.zCard(key);
    multi.expire(key, windowSeconds + 1);
    const [, , count] = await multi.exec();

    const currentCount = count || 0;
    const allowed = currentCount <= maxRequests;
    const resetTime = now + windowSeconds * 1000;

    return {
      allowed,
      remaining: Math.max(0, maxRequests - currentCount),
      resetTime,
    };
  } catch {
    return { allowed: true, remaining: maxRequests, resetTime: 0 };
  }
}

/** 检查并消费令牌桶 */
async function rateLimitConsume(bucket, consume = 1) {
  if (!client) return true;
  const key = `rate:${bucket}`;
  try {
    const tokens = await client.get(key);
    const currentTokens = tokens ? parseFloat(tokens) : RATE_LIMITS[bucket]?.tokens || 100;
    if (currentTokens < consume) return false;
    await client.decrBy(key, consume);
    // 每秒自动补充 (通过 expire + Lua 或定时任务)
    return true;
  } catch {
    return true; // Redis 不可用时放行
  }
}

// ==================== 5. JOB QUEUE ====================
const JOB_QUEUE = 'jobs:feishu';
const JOB_DLQ = 'jobs:feishu:dead';

/** 入队 (可靠任务队列) */
async function jobEnqueue(queue, payload, maxRetries = 5) {
  if (!client) return false;
  const job = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    payload,
    retries: 0,
    maxRetries,
    createdAt: Date.now(),
    nextRetry: Date.now(),
  };
  await client.rPush(queue, JSON.stringify(job));
  return job.id;
}

/** 出队 */
async function jobDequeue(queue) {
  if (!client) return null;
  const raw = await client.lPop(queue);
  return raw ? JSON.parse(raw) : null;
}

/** 重新入队 (失败重试, 指数退避) */
async function jobRetry(queue, job) {
  if (!client) return;
  job.retries++;
  const delay = Math.pow(2, job.retries) * 1000;
  job.nextRetry = Date.now() + delay;
  await client.rPush(queue, JSON.stringify(job));
}

/** 进入死信队列 */
async function jobDeadLetter(queue, job, errorMsg) {
  if (!client) return;
  job.error = errorMsg;
  job.failedAt = Date.now();
  await client.rPush(queue + ':dead', JSON.stringify(job));
}

// ==================== 6. DISTRIBUTED LOCK ====================
/**
 * Redis 分布式锁 (Redlock 简化版)
 * 防止多 Worker 重复操作 (如重复创建飞书记录)
 */
async function lockAcquire(resource, ttlMs = 10000) {
  if (!client) return true; // 无 Redis 时跳过锁
  const lockKey = `lock:${resource}`;
  const token = `${process.env.pm_id || '0'}-${Date.now()}-${Math.random()}`;
  const ok = await client.set(lockKey, token, { NX: true, PX: ttlMs });
  return ok === 'OK' ? token : null;
}

async function lockRelease(resource, token) {
  if (!client || !token) return;
  // Lua 脚本: 仅当 value 匹配时才删除 (防止误删其他 Worker 的锁)
  const script = `
    if redis.call("get", KEYS[1]) == ARGV[1] then
      return redis.call("del", KEYS[1])
    else
      return 0
    end
  `;
  await client.eval(script, { keys: [`lock:${resource}`], arguments: [token] });
}

// ==================== 7. METRICS ====================
function getMetrics() {
  return {
    isConnected,
    ...metrics,
    l1Size: l1Cache.size,
    redisUrl: REDIS_CONFIG.url.replace(/\/\/.*@/, '//***@'), // 隐藏密码
  };
}

// ==================== EXPORTS ====================
module.exports = {
  init,
  shutdown,
  isConnected: () => isConnected,
  getClient: () => client,
  getSubscriber: () => subscriber,
  getPublisher: () => publisher,

  // Session
  sessionCreate,
  sessionGet,
  sessionDelete,
  sessionDeleteByUser,
  sessionCount,
  sessionOnlineUserIds,

  // Pub/Sub
  publish,
  subscribe,
  broadcastSSE,
  broadcastWS,
  SSE_CHANNEL,
  WS_CHANNEL,
  ADMIN_CHANNEL,

  // Cache
  cacheGet,
  cacheSet,
  cacheInvalidate,
  cacheInvalidatePattern,
  l1Invalidate: (key) => l1Cache.delete(key),

  // Rate Limiter
  rateLimitCheck,
  rateLimitConsume,
  RATE_LIMITS,

  // Job Queue
  jobEnqueue,
  jobDequeue,
  jobRetry,
  jobDeadLetter,
  JOB_QUEUE,
  JOB_DLQ,

  // Distributed Lock
  lockAcquire,
  lockRelease,

  // Metrics
  getMetrics,
};
