/**
 * Glove Management System - Backend Server (Cluster + Redis Edition)
 * Storage: MySQL (mysql2) + Redis (session/cache/pubsub) + SSE for real-time sync
 * Performance: Node.js cluster (multi-core) + Redis Pub/Sub + gzip + memory cache
 * Target: 500 concurrent users
 */
require('dotenv').config();

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const cluster = require('cluster');
const os = require('os');

// ==================== FEISHU SYNC ====================
const feishu = require('./feishu');

// ==================== REALTIME ENGINE ====================
const realtime = require('./realtime');

// ==================== REDIS CLIENT ====================
const redis = require('redis');
const REDIS_URL = process.env.REDIS_URL || `redis://${process.env.REDIS_HOST || 'localhost'}:${process.env.REDIS_PORT || '6379'}`;
let redisClient, redisSub, redisPub;

async function initRedis() {
  try {
    redisClient = redis.createClient({
      url: REDIS_URL,
      socket: {
        reconnectStrategy: (retries) => {
          if (retries > 20) {
            console.error('[Redis] Max retries reached, running without Redis');
            return new Error('Max retries exceeded');
          }
          const delay = Math.min(retries * 500, 5000);
          console.warn(`[Redis] Reconnect attempt ${retries} in ${delay}ms`);
          return delay;
        },
      },
    });
    redisSub = redisClient.duplicate();
    redisPub = redisClient.duplicate();

    // 关键：捕获 Redis 错误，防止 crash 整个进程
    const onError = (role) => (err) => {
      console.error(`[Redis ${role}] Error (non-fatal):`, err.message);
    };
    redisClient.on('error', onError('client'));
    redisSub.on('error', onError('sub'));
    redisPub.on('error', onError('pub'));

    await Promise.all([redisClient.connect(), redisSub.connect(), redisPub.connect()]);
    console.log(`[Worker ${process.env.pm_id || '?'}] Redis connected: ${REDIS_URL}`);
    return true;
  } catch (e) {
    console.warn(`[Worker ${process.env.pm_id || '?'}] Redis not available (running without): ${e.message}`);
    redisClient = null; redisSub = null; redisPub = null;
    return false;
  }
}

// ==================== REDIS-ASSISTED CACHE ====================
async function _redisGet(key) {
  if (!redisClient) return null;
  try { const v = await redisClient.get(key); return v ? JSON.parse(v) : null; } catch { return null; }
}
async function _redisSet(key, value, ttlSeconds = 30) {
  if (!redisClient) return;
  try { await redisClient.setEx(key, ttlSeconds, JSON.stringify(value)); } catch {}
}
async function _redisDel(key) {
  if (!redisClient) return;
  try { await redisClient.unlink(key); } catch {}
}

// ==================== CONFIG ====================
const PORT = process.env.PORT || 8765;
// SECURITY WARNING: Database credentials should be set via environment variables in production!
// Do NOT hardcode credentials in source code. Use DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME env vars.

// ========== 主库（写） ==========
const DB_HOST = process.env.DB_HOST || process.env.MYSQL_HOST || '';
const DB_PORT = parseInt(process.env.DB_PORT || process.env.MYSQL_PORT || '3306');
const DB_USER = process.env.DB_USER || process.env.MYSQL_USER || '';
const DB_PASSWORD = process.env.DB_PASSWORD || process.env.MYSQL_PASSWORD || '';
const DB_NAME = process.env.DB_NAME || process.env.MYSQL_DATABASE || 'gms';

// ========== 从库（读） - 可选，用于读写分离 ==========
const DB_HOST_READ = process.env.DB_HOST_READ || process.env.MYSQL_HOST_READ || '';
const DB_PORT_READ = parseInt(process.env.DB_PORT_READ || process.env.MYSQL_PORT_READ || '3306');
const DB_USER_READ = process.env.DB_USER_READ || process.env.MYSQL_USER_READ || '';
const DB_PASSWORD_READ = process.env.DB_PASSWORD_READ || process.env.MYSQL_PASSWORD_READ || '';

// Validate required database config
if (!DB_HOST || !DB_USER || !DB_PASSWORD) {
  console.error('[FATAL] Database credentials not configured. Set DB_HOST, DB_USER, DB_PASSWORD environment variables.');
  process.exit(1);
}

// ========== 服务器角色标识 ==========
const SERVER_ROLE = process.env.SERVER_ROLE || 'primary'; // primary | secondary
const SERVER_ID = process.env.SERVER_ID || `server-${PORT}-${Date.now()}`;

const UPLOADS_DIR = path.join(__dirname, 'uploads');
const DATA_DIR = path.join(__dirname, 'data');
const TOKEN_EXPIRY = 2 * 60 * 60 * 1000; // 2 hours sliding window

// ==================== DATABASE ====================
const mysql = require('mysql2/promise');

if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

let pool; // 主连接池（写）
let readPool; // 读连接池（从库，可选）
let poolStats = {
  acquired: 0,
  leaked: 0,
  totalQueries: 0,
  slowQueries: 0,
  lastReset: Date.now(),
};
const activeConnections = new Map();
const LEAK_DETECTION_THRESHOLD = 30000;
const QUERY_TIMEOUT = 15000;
const SLOW_QUERY_THRESHOLD = 5000;

function getPoolInfo() {
  if (!pool) return { connected: false };
  try {
    return {
      connected: true,
      totalConnections: pool.totalConnections || 0,
      activeConnections: pool.activeConnections || 0,
      idleConnections: pool.idleConnections || 0,
      waitingRequests: pool.waitingConnections || 0,
      connectionLimit: pool.config.connectionLimit,
      queueLimit: pool.config.queueLimit,
      trackedActive: activeConnections.size,
      leaked: poolStats.leaked,
      totalQueries: poolStats.totalQueries,
      slowQueries: poolStats.slowQueries,
    };
  } catch {
    return { connected: false };
  }
}

async function initPool() {
  if (pool) {
    try { await pool.end(); } catch {}
    pool = null;
  }
  if (readPool) {
    try { await readPool.end(); } catch {}
    readPool = null;
  }
  activeConnections.clear();

  // ========== 主库连接池 ==========
  const initConn = await mysql.createConnection({
    host: DB_HOST, port: DB_PORT, user: DB_USER, password: DB_PASSWORD,
    charset: 'utf8mb4',
    connectTimeout: 10000,
  });
  await initConn.execute(`CREATE DATABASE IF NOT EXISTS \`${DB_NAME}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  await initConn.end();

  pool = mysql.createPool({
    host: DB_HOST, port: DB_PORT, user: DB_USER, password: DB_PASSWORD,
    database: DB_NAME,
    charset: 'utf8mb4',
    waitForConnections: true,
    connectionLimit: 80,
    queueLimit: 200,
    enableKeepAlive: true,
    keepAliveInitialDelay: 10000,
    connectTimeout: 10000,
    idleTimeout: 60000,
    maxIdle: 20,
  });

  // ========== 从库连接池（可选，用于读写分离） ==========
  if (DB_HOST_READ && DB_USER_READ && DB_PASSWORD_READ) {
    try {
      readPool = mysql.createPool({
        host: DB_HOST_READ,
        port: DB_PORT_READ,
        user: DB_USER_READ,
        password: DB_PASSWORD_READ,
        database: DB_NAME,
        charset: 'utf8mb4',
        waitForConnections: true,
        connectionLimit: 50, // 读库连接数较少
        queueLimit: 100,
        enableKeepAlive: true,
        keepAliveInitialDelay: 10000,
        connectTimeout: 10000,
        idleTimeout: 60000,
        maxIdle: 15,
      });
      console.log(`[DB] 从库连接池已创建: ${DB_HOST_READ}:${DB_PORT_READ}`);
    } catch (e) {
      console.warn('[DB] 从库连接失败，所有查询走主库:', e.message);
      readPool = null;
    }
  } else {
    console.log('[DB] 无从库配置，所有查询走主库');
  }

  pool.on('connection', async (conn) => {
    try {
      await conn.execute("SET NAMES utf8mb4 COLLATE utf8mb4_unicode_ci");
      await conn.execute("SET CHARACTER SET utf8mb4");
    } catch {}
  });

  pool.on('acquire', (conn) => {
    poolStats.acquired++;
    const connId = conn.threadId || Math.random().toString(36).slice(2);
    activeConnections.set(connId, {
      acquiredAt: Date.now(),
      stack: new Error().stack,
      threadId: conn.threadId,
    });
    (conn).__trackId = connId;
  });

  pool.on('release', (conn) => {
    const connId = conn.__trackId;
    if (connId) activeConnections.delete(connId);
  });

  pool.on('error', (err) => {
    console.error('[DB] Pool error (non-fatal):', err.message);
  });

  const _origExecute = pool.execute.bind(pool);
  const _origQuery = pool.query.bind(pool);

  function withTimeout(promise, timeoutMs, sql) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Query timeout after ${timeoutMs}ms: ${String(sql).slice(0, 100)}`));
      }, timeoutMs);
      promise.then(
        (result) => { clearTimeout(timer); resolve(result); },
        (err) => { clearTimeout(timer); reject(err); }
      );
    });
  }

  pool.execute = async function(...args) {
    const startTime = Date.now();
    poolStats.totalQueries++;
    try {
      const result = await withTimeout(_origExecute(...args), QUERY_TIMEOUT, args[0]);
      const elapsed = Date.now() - startTime;
      if (elapsed > SLOW_QUERY_THRESHOLD) {
        poolStats.slowQueries++;
        console.warn(`[DB] Slow query (${elapsed}ms): ${String(args[0]).slice(0, 100)}`);
      }
      return result;
    } catch (e) {
      if (e.message && (e.message.includes('Pool is closed') || e.message.includes('ECONNRESET') || e.message.includes('ETIMEDOUT') || e.message.includes('PROTOCOL_CONNECTION_LOST'))) {
        console.warn('[DB] Connection issue detected, reinitializing pool...', e.message);
        try { await initPool(); } catch(e2) { console.error('[DB] Reconnect failed:', e2.message); }
        throw e;
      }
      throw e;
    }
  };

  pool.query = async function(...args) {
    const startTime = Date.now();
    poolStats.totalQueries++;
    try {
      const result = await withTimeout(_origQuery(...args), QUERY_TIMEOUT, args[0]);
      const elapsed = Date.now() - startTime;
      if (elapsed > SLOW_QUERY_THRESHOLD) {
        poolStats.slowQueries++;
        console.warn(`[DB] Slow query (${elapsed}ms): ${String(args[0]).slice(0, 100)}`);
      }
      return result;
    } catch (e) {
      if (e.message && (e.message.includes('Pool is closed') || e.message.includes('ECONNRESET') || e.message.includes('ETIMEDOUT') || e.message.includes('PROTOCOL_CONNECTION_LOST'))) {
        console.warn('[DB] Connection issue detected, reinitializing pool...', e.message);
        try { await initPool(); } catch(e2) { console.error('[DB] Reconnect failed:', e2.message); }
        throw e;
      }
      throw e;
    }
  };

  const _leakDetector = setInterval(() => {
    const now = Date.now();
    let leaked = 0;
    for (const [connId, info] of activeConnections) {
      const held = now - info.acquiredAt;
      if (held > LEAK_DETECTION_THRESHOLD) {
        leaked++;
        if (leaked <= 3) {
          console.warn(`[DB] Potential connection leak: held for ${held}ms, threadId=${info.threadId}`);
        }
      }
    }
    if (leaked > 0) {
      poolStats.leaked = leaked;
      console.warn(`[DB] Leak detector: ${leaked} connections held > ${LEAK_DETECTION_THRESHOLD}ms`);
    } else {
      poolStats.leaked = 0;
    }

    const info = getPoolInfo();
    if (info.connected) {
      const usagePercent = info.activeConnections / info.connectionLimit * 100;
      if (usagePercent > 80) {
        console.warn(`[DB] Pool usage high: ${info.activeConnections}/${info.connectionLimit} (${usagePercent.toFixed(1)}%), waiting=${info.waitingRequests}`);
      }
    }
  }, 10000);
  if (_leakDetector.unref) _leakDetector.unref();

  const _healthCheck = setInterval(async () => {
    try {
      await _origExecute('SELECT 1');
    } catch (e) {
      if (e.message && (e.message.includes('Pool is closed') || e.message.includes('ECONNRESET') || e.message.includes('ETIMEDOUT') || e.message.includes('PROTOCOL_CONNECTION_LOST'))) {
        console.warn('[DB] Health check failed, reconnecting...', e.message);
        try { await initPool(); } catch(e2) { console.error('[DB] Reconnect failed:', e2.message); }
      }
    }
  }, 30000);
  if (_healthCheck.unref) _healthCheck.unref();

  const conn = await pool.getConnection();
  await conn.ping();
  conn.release();
  console.log('[DB] MySQL connected:', DB_HOST + ':' + DB_PORT + '/' + DB_NAME);
  console.log('[DB] Pool config: limit=80, queueLimit=200, queryTimeout=' + QUERY_TIMEOUT + 'ms, leakThreshold=' + LEAK_DETECTION_THRESHOLD + 'ms');
}

function initDB() {
  const statements = [
    `CREATE TABLE IF NOT EXISTS inventory (
      inv_type VARCHAR(64) PRIMARY KEY,
      quantity INT DEFAULT 0,
      updatedAt VARCHAR(64),
      updatedBy VARCHAR(64)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE IF NOT EXISTS machines (
      id VARCHAR(64) PRIMARY KEY,
      data MEDIUMTEXT
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE IF NOT EXISTS transactions (
      id VARCHAR(64) PRIMARY KEY,
      data MEDIUMTEXT
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE IF NOT EXISTS audit_log (
      id VARCHAR(64) PRIMARY KEY,
      data MEDIUMTEXT
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE IF NOT EXISTS settings (
      skey VARCHAR(64) PRIMARY KEY,
      value MEDIUMTEXT
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE IF NOT EXISTS users (
      id VARCHAR(64) PRIMARY KEY,
      username VARCHAR(64) UNIQUE,
      passwordHash VARCHAR(128),
      role VARCHAR(32),
      \`system\` VARCHAR(32),
      createdBy VARCHAR(64),
      createdAt VARCHAR(64)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE IF NOT EXISTS equipment_config (
      id VARCHAR(64) PRIMARY KEY,
      data MEDIUMTEXT
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE IF NOT EXISTS inventory_config (
      id VARCHAR(64) PRIMARY KEY,
      data MEDIUMTEXT
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE IF NOT EXISTS ops_orders (
      id VARCHAR(64) PRIMARY KEY,
      data MEDIUMTEXT
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE IF NOT EXISTS ops_customers (
      id VARCHAR(64) PRIMARY KEY,
      data MEDIUMTEXT
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE IF NOT EXISTS ops_production (
      id VARCHAR(64) PRIMARY KEY,
      data MEDIUMTEXT
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE IF NOT EXISTS sn_registry (
      snCode VARCHAR(128) PRIMARY KEY,
      equipmentType VARCHAR(64),
      handType VARCHAR(16),
      status VARCHAR(32) DEFAULT 'available',
      machineNumber VARCHAR(64),
      trackingNumber VARCHAR(128),
      damageReason TEXT,
      shippedAt VARCHAR(64),
      repairedAt VARCHAR(64),
      updatedAt VARCHAR(64),
      attachment TEXT,
      INDEX idx_sn_updated (updatedAt),
      INDEX idx_sn_status (status),
      INDEX idx_sn_equipment (equipmentType),
      INDEX idx_sn_machine (machineNumber)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE IF NOT EXISTS tech_support (
      id VARCHAR(64) PRIMARY KEY,
      data MEDIUMTEXT
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE IF NOT EXISTS group_transfers (
      id VARCHAR(64) PRIMARY KEY,
      data MEDIUMTEXT
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE IF NOT EXISTS popup_messages (
      id VARCHAR(64) PRIMARY KEY,
      category VARCHAR(32),
      text TEXT,
      createdBy VARCHAR(64),
      createdAt VARCHAR(64)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE IF NOT EXISTS task_progress (
      id INT AUTO_INCREMENT PRIMARY KEY,
      userId VARCHAR(64) NOT NULL,
      date VARCHAR(16) NOT NULL,
      startProgress DECIMAL(10,2) DEFAULT 0,
      currentProgress DECIMAL(10,2) DEFAULT 0,
      dayProgress DECIMAL(10,2) DEFAULT 0,
      history JSON,
      createdAt VARCHAR(64),
      updatedAt VARCHAR(64),
      UNIQUE KEY unique_user_date (userId, date)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE IF NOT EXISTS tech_support_memory (
      id INT AUTO_INCREMENT PRIMARY KEY,
      category VARCHAR(32) NOT NULL,
      text TEXT NOT NULL,
      useCount INT DEFAULT 1,
      lastUsedAt VARCHAR(64),
      createdBy VARCHAR(64),
      createdAt VARCHAR(64),
      UNIQUE KEY unique_category_text (category, text(255))
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  ];
  return Promise.all(statements.map(sql => pool.execute(sql)));
}

function migrateDB() {
  const migrations = [
    `ALTER TABLE sn_registry ADD COLUMN attachment MEDIUMTEXT`,
    `ALTER TABLE sn_registry MODIFY COLUMN attachment MEDIUMTEXT`,
    `ALTER TABLE sn_registry ADD COLUMN trackingNumber VARCHAR(128)`,
    `ALTER TABLE sn_registry ADD COLUMN shippedAt VARCHAR(64)`,
    `ALTER TABLE sn_registry ADD COLUMN repairedAt VARCHAR(64)`,
    `ALTER TABLE users ADD COLUMN parentId VARCHAR(64)`,
    `ALTER TABLE users ADD COLUMN displayName VARCHAR(64)`,
    `ALTER TABLE users ADD COLUMN status VARCHAR(16) DEFAULT 'active'`,
    `ALTER TABLE users ADD COLUMN passwordPlain VARCHAR(128)`,
    `UPDATE users SET displayName = username WHERE displayName IS NULL`,
    // Performance indexes (MySQL 5.7+ and 8.0 compatible)
    `CREATE INDEX idx_sn_updated ON sn_registry(updatedAt)`,
    `CREATE INDEX idx_sn_status ON sn_registry(status)`,
    `CREATE INDEX idx_sn_equipment ON sn_registry(equipmentType)`,
    `CREATE INDEX idx_sn_machine ON sn_registry(machineNumber)`,
  ];
  return Promise.all(migrations.map(sql =>
    pool.execute(sql).catch(() => { /* column likely already exists */ })
  ));
}

async function seedDefaults() {
  const [[{ c }]] = await pool.execute('SELECT COUNT(*) as c FROM users');
  if (c === 0) {
    const users = [
      ['sa-001', 'Yunwei', hashPassword('yunwei1025'), 'superadmin', 'maintenance', '运维超管', null, new Date().toISOString()],
      ['sa-002', 'yunying', hashPassword('yunying1025'), 'superadmin', 'operations', '运营超管', null, new Date().toISOString()],
      ['admin-001', 'admin', hashPassword('admin123'), 'admin', 'maintenance', '管理员', null, new Date().toISOString()],
    ];
    for (const u of users) {
      await pool.execute(
        'INSERT INTO users (id, username, passwordHash, role, \`system\`, displayName, createdBy, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        u
      );
    }
  }

  const [[{ c: eqCount }]] = await pool.execute('SELECT COUNT(*) as c FROM equipment_config');
  if (eqCount === 0) {
    const defaults = [
      { id: 'glove', name: '纯手套设备', icon: '🧤', consumes: [{ inventoryType: 'left_glove', handType: 'left', quantity: 1 }, { inventoryType: 'right_glove', handType: 'right', quantity: 1 }], createdAt: new Date().toISOString() },
      { id: 'dexterous', name: '灵巧手设备', icon: '🤖', consumes: [{ inventoryType: 'left_glove', handType: 'left', quantity: 1 }, { inventoryType: 'right_glove', handType: 'right', quantity: 1 }, { inventoryType: 'left_dexterous_hand', handType: 'left', quantity: 1 }, { inventoryType: 'right_dexterous_hand', handType: 'right', quantity: 1 }], createdAt: new Date().toISOString() },
      { id: 'gripper', name: '夹爪设备', icon: '🔧', consumes: [{ inventoryType: 'gripper', handType: null, quantity: 2 }], createdAt: new Date().toISOString() },
    ];
    for (const d of defaults) {
      await pool.execute('INSERT INTO equipment_config (id, data) VALUES (?, ?)', [d.id, JSON.stringify(d)]);
    }
  }

  const [[{ c: invCfgCount }]] = await pool.execute('SELECT COUNT(*) as c FROM inventory_config');
  if (invCfgCount === 0) {
    const defaults = [
      { id: 'left_glove', name: '左手手套', icon: '🧤', hasLeftRight: false, createdAt: new Date().toISOString() },
      { id: 'right_glove', name: '右手手套', icon: '🧤', hasLeftRight: false, createdAt: new Date().toISOString() },
      { id: 'left_dexterous_hand', name: '左手灵巧手', icon: '🤖', hasLeftRight: false, createdAt: new Date().toISOString() },
      { id: 'right_dexterous_hand', name: '右手灵巧手', icon: '🤖', hasLeftRight: false, createdAt: new Date().toISOString() },
      { id: 'gripper', name: '夹爪', icon: '🔧', hasLeftRight: false, createdAt: new Date().toISOString() },
    ];
    for (const d of defaults) {
      await pool.execute('INSERT INTO inventory_config (id, data) VALUES (?, ?)', [d.id, JSON.stringify(d)]);
    }
  }

  // Seed popup messages
  const [[{ c: popupCount }]] = await pool.execute('SELECT COUNT(*) as c FROM popup_messages');
  if (popupCount === 0) {
    const submitMsgs = [
      '辛苦了！运维人员正在风雨兼程赶来救你！', '请求已发射到运维星球，外星人正在处理中...', '你的勇气令人钦佩，故障已经被吓跑了一半！',
      '提交成功！运维小哥哥已经开始磨刀霍霍了！', '收到！我们的维修大师正在热身准备！', '已通知运维团队，他们激动得跳了起来！',
      '故障颤抖吧！运维英雄即将登场！', '你的请求像火箭一样飞向了运维中心！', '太好了，又一个挑战！运维人员摩拳擦掌中！',
      '提交成功！运维猫咪已经出发去修理了！', '收到请求！运维超人正在穿披风！', '故障别跑！运维战士即将到达战场！',
      '你的耐心是最大的美德，运维团队全力出击！', '请求已进入运维加速器，光速处理中！', '运维小队：终于有活干了，冲啊！',
      '提交成功！你的设备正在等待被拯救！', '收到！维修工具已经自动打包完毕！', '运维大佬露出了自信的微笑！',
      '故障代码：已投降。运维人员：出发！', '你的设备发出了求救信号，救援正在路上！', '运维军团已集结，准备攻城拔寨！',
      '提交成功！运维小飞侠已起飞！', '收到！运维忍者已潜入修复模式！', '故障君请准备好，运维大侠要来挑战了！',
      '你的请求已被标记为“十万火急”！', '运维咖啡已煮好，准备通宵作战！', '收到！运维AI已启动自动修复程序（开玩笑的）！',
      '故障：我害怕。运维：那就对了！', '你的设备正在做深呼吸，维修马上开始！', '运维团队：让我们看看是谁又在搞事情！',
      '提交成功！维修小精灵已被释放！', '运维人员已戴上安全帽，准备进入战场！', '收到！你的设备即将重获新生！',
      '故障已被列入运维团队的“待揍清单”！', '运维超级赛亚人正在充能！', '你的请求正在以5G速度传递到运维中心！',
      '运维人员：来吧，展示！', '收到！维修机器人已启动（其实是人工的）！', '故障：我要被打败了吗？运维：是的！',
      '你的设备即将迎来它的“整容手术”！', '运维团队搓了搓手：这个我擅长！', '提交成功！维修模式ON！',
      '运维人员正在做热身运动，马上就到！', '收到！你的设备即将满血复活！', '运维大佬：区区小故障，不足挂齿！',
      '你的请求被运维团队视为今日挑战！', '故障：等等我还没准备好！运维：太晚了！', '运维小队已装备完毕，请求出战！',
      '提交成功！维修能量已充满100%！', '收到！你的设备正在享受VIP维修服务！',
    ];
    const completeMsgs = [
      '辛苦了，小哥哥！你是最棒的维修大师！', '维修完成！你简直是设备界的救世主！', '太厉害了！故障在你面前不堪一击！',
      '完美修复！运维之星非你莫属！', '辛苦了！设备对你感激涕零！', '维修完毕！你的技术让人叹为观止！',
      '故障已被你KO！冠军！', '辛苦了！设备已经满血复活啦！', '你是维修界的传说！',
      '完成！你是设备世界的超级英雄！', '辛苦了大佬！设备给你比心！', '完美！维修之神降临人间！',
      '故障：我认输了。你：那当然！', '辛苦了！设备说它再也不敢坏了！', '维修完毕！你的速度比闪电还快！',
      '太强了！故障见到你就跑了！', '辛苦了！设备已经在给你写感谢信了！', '完成！你是运维团队的MVP！',
      '维修大师出手，故障无处遁形！', '辛苦了！你的维修能量爆棚了！', '太棒了！设备已经在庆祝重生了！',
      '辛苦了！你的技术已经超越了人类极限！', '故障已修复，你简直就是魔法师！', '维修完成！你是最闪亮的星！',
      '辛苦了！设备感动得都要哭了！', '完美修复！你让故障瑟瑟发抖！', '运维之王，非你莫属！',
      '辛苦了！故障已经被送进了回收站！', '维修完毕！你是设备们的偶像！', '太强了！故障看到你的名字就投降了！',
      '辛苦了！设备给你颁发了最佳维修奖！', '完成！你是运维界的扛把子！', '故障已经被你的气场吓退了！',
      '辛苦了！设备已经在朋友圈夸你了！', '维修完毕！你是行走的维修百科全书！', '你的维修速度让光速都自愧不如！',
      '辛苦了！设备说下次还找你修！', '完美！你是维修界的扛把子！', '故障已被彻底消灭，和平降临！',
      '辛苦了！你是运维团队的定海神针！', '维修完成！设备给你点了100个赞！', '太强了！故障已经被你打进了冷宫！',
      '辛苦了！设备已经在写回忆录了！', '完成！你的维修技艺堪称艺术！', '故障已被你降维打击！',
      '辛苦了！设备决定以后好好表现！', '维修完毕！你是运维界的传说！', '你的维修能力已经超出了系统评分范围！',
      '辛苦了！设备给你比了个大大的心！', '完美！故障已经被永远封印了！',
    ];
    for (const text of submitMsgs) {
      const id = 'pm-s-' + Math.random().toString(36).slice(2, 10);
      await pool.execute('INSERT INTO popup_messages (id, category, text, createdBy, createdAt) VALUES (?, ?, ?, ?, ?)',
        [id, 'submit', text, 'system', new Date().toISOString()]);
    }
    for (const text of completeMsgs) {
      const id = 'pm-c-' + Math.random().toString(36).slice(2, 10);
      await pool.execute('INSERT INTO popup_messages (id, category, text, createdBy, createdAt) VALUES (?, ?, ?, ?, ?)',
        [id, 'complete', text, 'system', new Date().toISOString()]);
    }
  }
}

// ==================== DATA MIGRATION FROM JSON ====================
async function migrateFromJSON() {
  const flagFile = path.join(DATA_DIR, '.migrated_to_mysql');
  if (fs.existsSync(flagFile)) return;

  const jsonFiles = {
    inventory: 'inventory.json',
    machines: 'machines.json',
    transactions: 'transactions.json',
    audit_log: 'audit_log.json',
    settings: 'settings.json',
    users: 'users.json',
    equipment_config: 'equipment_config.json',
    inventory_config: 'inventory_config.json',
    ops_orders: 'ops_orders.json',
    ops_customers: 'ops_customers.json',
    ops_production: 'ops_production.json',
  };

  for (const [table, file] of Object.entries(jsonFiles)) {
    const filePath = path.join(DATA_DIR, file);
    if (!fs.existsSync(filePath)) continue;

    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (table === 'settings') {
        for (const [k, v] of Object.entries(data)) {
          await pool.execute('REPLACE INTO settings (skey, value) VALUES (?, ?)', [k, JSON.stringify(v)]);
        }
      } else if (table === 'inventory') {
        for (const item of data) {
          await pool.execute(
            'REPLACE INTO inventory (inv_type, quantity, updatedAt, updatedBy) VALUES (?, ?, ?, ?)',
            [item.type, item.quantity, item.updatedAt || null, item.updatedBy || '']
          );
        }
      } else if (table === 'users') {
        for (const u of data) {
          await pool.execute(
            'REPLACE INTO users (id, username, passwordHash, role, \`system\`, createdBy, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [u.id, u.username, u.passwordHash, u.role || 'user', u.system || 'maintenance', u.createdBy || null, u.createdAt || new Date().toISOString()]
          );
        }
      } else if (Array.isArray(data)) {
        for (const item of data) {
          const id = item.id || item.type || ('_' + Math.random().toString(36).slice(2));
          await pool.execute(`REPLACE INTO ${validateTable(table)} (id, data) VALUES (?, ?)`, [id, JSON.stringify(item)]);
        }
      }
      console.log(`  √ 已迁移 ${file} → ${table}`);
    } catch (e) {
      console.log(`  ✗ 迁移 ${file} 失败: ${e.message}`);
    }
  }

  fs.writeFileSync(flagFile, new Date().toISOString());
  console.log('  JSON → MySQL 迁移完成\n');
}

// ==================== AUTH ====================
// Format seconds into "X分Y秒" display
function _fmtDuration(seconds) {
  if (seconds == null) return '-';
  const s = Math.round(seconds);
  if (s <= 0) return '0分钟';
  if (s < 60) return '小于1分钟';
  const m = Math.round(s / 60);
  if (m < 60) return m + '分钟';
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm > 0 ? h + '时' + rm + '分' : h + '小时';
}

// SECURITY NOTE: Using a global salt is acceptable for internal systems.
// For production systems handling sensitive data, consider using per-user random salts with bcrypt.
function hashPassword(pw) {
  return crypto.createHash('sha256').update(pw + 'gms-salt').digest('hex');
}

// ==================== TOKEN / SESSION (Redis-backed) ====================
const tokens = {};     // in-memory fallback when Redis not available
const tokensPath = path.join(DATA_DIR, 'tokens.json');

function saveTokens() {
  try { fs.writeFileSync(tokensPath, JSON.stringify(tokens)); } catch {}
}

// Restore tokens on restart (fallback only)
try {
  if (fs.existsSync(tokensPath)) {
    Object.assign(tokens, JSON.parse(fs.readFileSync(tokensPath, 'utf8')));
  }
} catch {}

async function createToken(user) {
  const token = crypto.randomBytes(32).toString('hex');
  const tokenData = {
    userId: user.id, username: user.username,
    displayName: user.displayName || user.username,
    role: user.role, system: user.system || 'maintenance',
    expires: Date.now() + TOKEN_EXPIRY, lastActive: Date.now(),
  };
  // Redis primary + memory fallback
  if (redisClient) {
    await _redisSet(`tk:${token}`, tokenData, TOKEN_EXPIRY / 1000);
    await redisClient.sAdd(`u:tk:${user.id}`, token);
  }
  tokens[token] = tokenData;
  saveTokens();
  return token;
}

async function validateToken(token) {
  // Try Redis first
  let t = null;
  if (redisClient) {
    try {
      const raw = await redisClient.get(`tk:${token}`);
      if (raw) {
        t = JSON.parse(raw);
        // Refresh TTL (sliding window)
        t.expires = Date.now() + TOKEN_EXPIRY;
        t.lastActive = Date.now();
        await redisClient.setEx(`tk:${token}`, TOKEN_EXPIRY / 1000, JSON.stringify(t));
        return t;
      }
    } catch {}
  }
  // Memory fallback
  t = tokens[token];
  if (!t || t.expires < Date.now()) {
    if (t) { delete tokens[token]; saveTokens(); }
    return null;
  }
  t.expires = Date.now() + TOKEN_EXPIRY;
  t.lastActive = Date.now();
  return t;
}

async function invalidateUserTokens(userId) {
  if (redisClient) {
    try {
      const members = await redisClient.sMembers(`u:tk:${userId}`);
      if (members.length > 0) {
        await redisClient.del(...members.map(k => `tk:${k.replace('tk:', '')}`));
        await redisClient.del(`u:tk:${userId}`);
      }
    } catch {}
  }
  Object.keys(tokens).forEach(k => { if (tokens[k].userId === userId) delete tokens[k]; });
  saveTokens();
}

// 获取在线用户ID集合（从Redis或内存）
async function getOnlineUserIds() {
  const onlineIds = new Set();
  if (redisClient) {
    try {
      // 扫描所有 tk:* key，获取在线用户
      const keys = [];
      for await (const key of redisClient.scanIterator({ MATCH: 'tk:*', COUNT: 100 })) {
        keys.push(key);
      }
      for (const key of keys) {
        try {
          const raw = await redisClient.get(key);
          if (raw) {
            const t = JSON.parse(raw);
            if (t.expires > Date.now()) {
              onlineIds.add(t.userId);
            }
          }
        } catch {}
      }
      return onlineIds;
    } catch (e) {
      console.warn('[Redis] getOnlineUserIds failed, fallback to memory:', e.message);
    }
  }
  // 内存降级方案
  Object.values(tokens).forEach(t => { if (t.expires > Date.now()) onlineIds.add(t.userId); });
  return onlineIds;
}

// ==================== REALTIME (SSE + WebSocket 双通道) ====================
// realtime 引擎统一管理 SSE 和 WebSocket 连接
// SSE 客户端通过 realtime.addSSEClient/res 添加
// broadcastSSE 保留为便捷函数, 实际走 realtime 引擎
const sseClients = realtime.getSSEClients();

function broadcastSSE(event, data) {
  // 通过 realtime 引擎同时投递到 WS + SSE (含 Redis 跨 Worker)
  realtime.deliver(event, data, { force: true });
  // 兼容旧逻辑: 缓存失效
  _invalidateCache(event);
}

// ==================== IN-MEMORY CACHE + REQUEST COALESCING ====================
const _cache = new Map();
const _inflight = new Map();  // key -> Promise (prevents thundering herd)
const CACHE_TTL = {
  equipment_config: 120000,  // 2min
  inventory_config: 120000,  // 2min
  sn_registry: 15000,        // 15s
  machines: 15000,           // 15s
  tech_support: 10000,       // 10s
  sync: 60000,               // 60s
};

function _invalidateCache(event) {
  const map = {
    'equipment_config_updated': 'equipment_config',
    'inventory_config_updated': 'inventory_config',
    'sn_registry_updated': 'sn_registry',
    'machines_updated': 'machines',
    'inventory_updated': 'sync',
    'transactions_updated': 'sync',
    'tech_support_updated': 'tech_support',
    'settings_updated': 'sync',
    'users_updated': 'sync',
  };
  for (const [evt, key] of Object.entries(map)) {
    if (event === evt) _cache.delete(key);
  }
  // tech_support changes also invalidate sync cache
  if (event === 'tech_support_updated') _cache.delete('sync');
  // Note: sync cache uses its own TTL (30s), NOT invalidated on every SSE event
  // to prevent thundering herd — 200 users × every broadcast = DB overload
}

async function _cached(key, fetcher, ttlOverride) {
  const ttl = ttlOverride || CACHE_TTL[key] || 3000;
  // Check cache
  const entry = _cache.get(key);
  if (entry && (Date.now() - entry.ts) < ttl) return entry.data;

  // Single-flight: if already fetching, wait for that result
  if (_inflight.has(key)) return _inflight.get(key);

  const promise = (async () => {
    try {
      const data = await fetcher();
      _cache.set(key, { data, ts: Date.now() });
      return data;
    } finally {
      _inflight.delete(key);
    }
  })();

  _inflight.set(key, promise);
  return promise;
}

// ==================== JSON HELPERS ====================
const ALLOWED_TABLES = new Set([
  'machines', 'transactions', 'audit_log',
  'equipment_config', 'inventory_config',
  'ops_orders', 'ops_customers', 'ops_production',
  'tech_support', 'group_transfers',
]);

function validateTable(table) {
  if (!ALLOWED_TABLES.has(table)) throw new Error(`Invalid table name: ${table}`);
  return table;
}

async function readJSONArray(table, limit) {
  try {
    validateTable(table);
    let sql = `SELECT data FROM ${table} ORDER BY id DESC`;
    const effectiveLimit = limit ? parseInt(limit) : 500;
    sql += ` LIMIT ${Math.min(effectiveLimit, 50000)}`;
    const [rows] = await pool.execute(sql);
    return rows.map(r => JSON.parse(r.data)).reverse();
  } catch(e) {
    console.error('[DB] readJSONArray error:', table, e.message);
    return [];
  }
}

async function readJSONById(table, id) {
  validateTable(table);
  const [rows] = await pool.execute(`SELECT data FROM ${table} WHERE id = ?`, [id]);
  return rows.length > 0 ? JSON.parse(rows[0].data) : null;
}

async function saveJSON(table, id, obj) {
  validateTable(table);
  await pool.execute(`REPLACE INTO ${table} (id, data) VALUES (?, ?)`, [id, JSON.stringify(obj)]);
}

async function deleteJSON(table, id) {
  validateTable(table);
  await pool.execute(`DELETE FROM ${table} WHERE id = ?`, [id]);
}

async function readJSONObject(table) {
  const [rows] = await pool.execute(`SELECT skey, value FROM ${table}`);
  const obj = {};
  rows.forEach(r => { try { obj[r.skey] = JSON.parse(r.value); } catch { obj[r.skey] = r.value; } });
  return obj;
}

// ==================== ROUTER HELPERS ====================
function parseBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    const MAX = 150 * 1024 * 1024;
    const timer = setTimeout(() => { req.destroy(); resolve({}); }, 120000);
    req.on('data', c => {
      size += c.length;
      if (size > MAX) { clearTimeout(timer); req.destroy(); resolve({}); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      clearTimeout(timer);
      try { resolve(JSON.parse(Buffer.concat(chunks).toString())); } catch { resolve({}); }
    });
    req.on('error', () => { clearTimeout(timer); resolve({}); });
  });
}

function sendJSON(res, data, status = 200, req, extraHeaders = {}) {
  const body = Buffer.from(JSON.stringify(data), 'utf-8');
  const accept = (req && req.headers && req.headers['accept-encoding']) || '';
  const useGzip = accept.includes('gzip') && body.length > 1024;
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
    ...extraHeaders,
  };
  if (useGzip) {
    headers['Content-Encoding'] = 'gzip';
    res.writeHead(status, headers);
    res.end(zlib.gzipSync(body));
  } else {
    res.writeHead(status, headers);
    res.end(body);
  }
}

function parseCookies(cookieHeader) {
  const cookies = {};
  if (!cookieHeader) return cookies;
  cookieHeader.split(';').forEach(pair => {
    const idx = pair.indexOf('=');
    if (idx > 0) cookies[pair.substring(0, idx).trim()] = pair.substring(idx + 1).trim();
  });
  return cookies;
}

async function requireAuth(req, res) {
  let token = null;
  // 1. Try Bearer header first (primary auth method)
  const auth = req.headers['authorization'];
  if (auth && auth.startsWith('Bearer ')) {
    token = auth.slice(7);
  }
  // 2. Fall back to cookie
  if (!token && req.headers['cookie']) {
    const cookies = parseCookies(req.headers['cookie']);
    token = cookies.gms_token || null;
  }
  if (!token) { sendJSON(res, { error: '未登录' }, 401); return null; }
  const user = await validateToken(token);
  if (!user) { sendJSON(res, { error: '登录已过期' }, 401); return null; }
  return user;
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.pdf': 'application/pdf',
};

function serveStatic(req, res) {
  let filePath = req.url.split('?')[0];
  if (filePath === '/') filePath = '/index.html';
  filePath = path.join(__dirname, filePath);
  if (!filePath.startsWith(__dirname)) return false;
  const ext = path.extname(filePath);
  if (!MIME_TYPES[ext]) return false;
  try {
    // Use memory cache for static assets (1h TTL)
    const cached = getStaticFile(filePath, MIME_TYPES[ext], filePath);
    if (!cached) return false;
    const accept = req.headers['accept-encoding'] || '';
    const useGzip = accept.includes('gzip') && cached.gzipped && cached.gzipped.length < cached.data.length;
    const headers = {
      'Content-Type': cached.contentType,
      'Cache-Control': 'public, max-age=3600',
      'ETag': '"' + cached.ts.toString(36) + '"',
    };
    if (useGzip) {
      headers['Content-Encoding'] = 'gzip';
      res.writeHead(200, headers);
      res.end(cached.gzipped);
    } else {
      res.writeHead(200, headers);
      res.end(cached.data);
    }
    return true;
  } catch { return false; }
}

// ==================== API HANDLERS ====================

// -- Auth --
async function handleLogin(req, res, body) {
  const { username, password } = body;
  // Input validation: prevent empty, too long, or malicious input
  if (!username || !password) return sendJSON(res, { error: '请输入用户名和密码' }, 400);
  const trimmedUsername = username.trim();
  const trimmedPassword = password.trim();
  if (trimmedUsername.length < 2 || trimmedUsername.length > 64) return sendJSON(res, { error: '用户名长度需在2-64字符之间' }, 400);
  if (trimmedPassword.length < 4 || trimmedPassword.length > 128) return sendJSON(res, { error: '密码长度需在4-128字符之间' }, 400);
  // SQL injection check
  if (/[;'"\-\-]/.test(trimmedUsername)) return sendJSON(res, { error: '用户名包含非法字符' }, 400);

  // Brute force protection
  const clientIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || 'unknown';
  const bruteCheck = require('./security').loginBruteForceCheck(clientIp);
  if (bruteCheck.blocked) {
    return sendJSON(res, { error: `登录尝试过多，请等待 ${bruteCheck.remainingSeconds} 秒后再试` }, 429);
  }

  const [rows] = await pool.execute('SELECT * FROM users WHERE username = ?', [trimmedUsername]);
  const loginSuccess = rows.length > 0 && rows[0].passwordHash === hashPassword(trimmedPassword);
  require('./security').loginBruteForceRecord(clientIp, loginSuccess);

  if (!loginSuccess) {
    return sendJSON(res, { error: '用户名或密码错误' }, 401);
  }
  const user = rows[0];
  // Check if user account is disabled
  if (user.status === 'disabled') return sendJSON(res, { error: '账户已被禁用，请联系管理员' }, 403);
  // Clean expired/stale tokens and invalidate user's existing tokens
  await invalidateUserTokens(user.id);
  const STALE_THRESHOLD = 3 * 60 * 1000;
  Object.keys(tokens).forEach(k => {
    const t = tokens[k];
    if (t.expires < Date.now() || (Date.now() - (t.lastActive || 0)) > STALE_THRESHOLD) delete tokens[k];
  });
  saveTokens();
  const token = await createToken(user);
  sendJSON(res, { token, user: { id: user.id, username: user.username, displayName: user.displayName || user.username, role: user.role, system: user.system || 'maintenance' } }, 200, req, {
    'Set-Cookie': `gms_token=${token}; Path=/; Max-Age=604800; SameSite=Lax`,
  });
}

async function handleTokenVerify(req, res, body) {
  const { token } = body;
  if (!token) return sendJSON(res, { valid: false, error: 'Missing token' }, 400);
  const user = await validateToken(token);
  if (!user) return sendJSON(res, { valid: false, error: 'Invalid or expired token' }, 401);
  sendJSON(res, { valid: true, user: { userId: user.userId, username: user.username, role: user.role, system: user.system } });
}

async function handleForceLogout(req, res, user, targetUserId) {
  if (user.role !== 'admin' && user.role !== 'superadmin') return sendJSON(res, { error: '无权限' }, 403);
  await invalidateUserTokens(targetUserId);
  saveTokens();
  broadcastSSE('users_updated', {});
  sendJSON(res, { success: true });
}

async function handleGetUsers(req, res, user) {
  if (user.role !== 'admin' && user.role !== 'superadmin') return sendJSON(res, { error: '无权限' }, 403);
  const [allUsers] = await pool.execute('SELECT * FROM users');
  // Everyone only sees users in their own system (运营 ↔ 运维 隔离)
  let users = allUsers.filter(u => (u.system || 'maintenance') === user.system);
  if (user.role === 'admin') {
    // Admin only sees their own subordinates (via parentId or createdBy)
    users = users.filter(u => u.id === user.userId || u.parentId === user.userId || u.createdBy === user.userId);
  }
  // Superadmin sees all users within their own system
  const onlineIds = await getOnlineUserIds();
  sendJSON(res, users.map(u => ({ id: u.id, username: u.username, displayName: u.displayName || u.username, role: u.role, system: u.system || 'maintenance', status: u.status || 'active', parentId: u.parentId || null, createdAt: u.createdAt, online: onlineIds.has(u.id) })));
}

async function handleAddUser(req, res, user, body) {
  if (user.role !== 'admin' && user.role !== 'superadmin') return sendJSON(res, { error: '无权限添加用户' }, 403);
  const { username, password, role, system, displayName } = body;
  if (!username || !password) return sendJSON(res, { error: '请输入用户名和密码' }, 400);
  const trimmedUsername = username.trim();
  const trimmedPassword = password.trim();
  // Validate username
  if (trimmedUsername.length < 2 || trimmedUsername.length > 64) return sendJSON(res, { error: '用户名长度需在2-64字符之间' }, 400);
  if (/[;'"\-\-]/.test(trimmedUsername)) return sendJSON(res, { error: '用户名包含非法字符' }, 400);
  // Validate password strength
  if (trimmedPassword.length < 6) return sendJSON(res, { error: '密码至少6个字符' }, 400);
  if (!/[A-Za-z]/.test(trimmedPassword) || !/[0-9]/.test(trimmedPassword)) return sendJSON(res, { error: '密码需包含字母和数字' }, 400);
  if (user.role === 'admin' && role === 'admin') return sendJSON(res, { error: '管理员只能创建普通用户' }, 403);
  if (role === 'superadmin') return sendJSON(res, { error: '无法创建超级管理员账户' }, 403);
  const [existing] = await pool.execute('SELECT id FROM users WHERE username = ?', [trimmedUsername]);
  if (existing.length > 0) return sendJSON(res, { error: '用户名已存在' }, 400);
  const id = 'u-' + Date.now().toString(36);
  const userSystem = system || user.system || 'maintenance';
  // When admin creates a user, set parentId to establish hierarchy
  const parentId = (user.role === 'admin' || user.role === 'superadmin') ? user.userId : null;
  await pool.execute(
    'INSERT INTO users (id, username, passwordHash, passwordPlain, role, `system`, displayName, createdBy, parentId, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [id, trimmedUsername, hashPassword(trimmedPassword), trimmedPassword, role || 'user', userSystem, displayName || trimmedUsername, user.userId, parentId, new Date().toISOString()]
  );
  broadcastSSE('users_updated', {});
  sendJSON(res, { success: true, user: { id, username: trimmedUsername, displayName: displayName || trimmedUsername, role: role || 'user', system: userSystem, parentId } });
}

async function handleDeleteUser(req, res, user, userId) {
  if (user.role !== 'admin' && user.role !== 'superadmin') return sendJSON(res, { error: '无权限删除用户' }, 403);
  const [target] = await pool.execute('SELECT * FROM users WHERE id = ?', [userId]);
  if (target.length === 0) return sendJSON(res, { error: '用户不存在' }, 404);
  if (target[0].role === 'superadmin') return sendJSON(res, { error: '无法删除超级管理员' }, 403);
  if (user.role === 'admin' && target[0].role === 'admin') return sendJSON(res, { error: '管理员无法删除其他管理员' }, 403);
  if (user.userId === userId) return sendJSON(res, { error: '无法删除自己' }, 400);
  await pool.execute('DELETE FROM users WHERE id = ?', [userId]);
  await invalidateUserTokens(userId);
  saveTokens();
  broadcastSSE('users_updated', {});
  sendJSON(res, { success: true });
}

async function handleUpdateUser(req, res, user, userId, body) {
  const { username, password } = body;
  if (!username || !username.trim()) return sendJSON(res, { error: '用户名不能为空' }, 400);

  const [target] = await pool.execute('SELECT * FROM users WHERE id = ?', [userId]);
  if (target.length === 0) return sendJSON(res, { error: '用户不存在' }, 404);
  const targetUser = target[0];

  const isSelf = user.userId === userId;
  const isAdmin = user.role === 'admin';
  const isSuper = user.role === 'superadmin';

  if (!isSelf && !isAdmin && !isSuper) return sendJSON(res, { error: '无权限修改该账户' }, 403);
  if (!isSelf && isAdmin && targetUser.role === 'admin') return sendJSON(res, { error: '管理员无法修改其他管理员' }, 403);
  if (!isSelf && isAdmin && targetUser.role === 'superadmin') return sendJSON(res, { error: '无权限修改超级管理员' }, 403);
  // Admin can only modify their own group members (subordinates)
  if (!isSelf && isAdmin && targetUser.role === 'user') {
    if (targetUser.parentId !== user.userId && targetUser.createdBy !== user.userId) {
      return sendJSON(res, { error: '只能修改自己组员的账户' }, 403);
    }
  }
  // Superadmin: same-system only, cannot modify other superadmins
  if (!isSelf && isSuper) {
    if (targetUser.role === 'superadmin') return sendJSON(res, { error: '无法修改其他超级管理员' }, 403);
    if (targetUser.system !== user.system) return sendJSON(res, { error: '只能修改本系统内的用户' }, 403);
  }

  const [dup] = await pool.execute('SELECT id FROM users WHERE username = ? AND id != ?', [username.trim(), userId]);
  if (dup.length > 0) return sendJSON(res, { error: '用户名已存在' }, 400);

  if (password && password.trim()) {
    await pool.execute('UPDATE users SET username = ?, passwordHash = ?, passwordPlain = ? WHERE id = ?', [username.trim(), hashPassword(password.trim()), password.trim(), userId]);
  } else {
    await pool.execute('UPDATE users SET username = ? WHERE id = ?', [username.trim(), userId]);
  }

  if (isSelf) {
    Object.values(tokens).forEach(t => { if (t.userId === userId) t.username = username.trim(); });
    saveTokens();
  }

  broadcastSSE('users_updated', {});
  sendJSON(res, { success: true, message: '修改成功' });
}

async function handleGetOnlineUsers(req, res, user) {
  if (user.role !== 'admin' && user.role !== 'superadmin') return sendJSON(res, { error: '无权限' }, 403);
  const onlineIds = await getOnlineUserIds();
  // 从Redis获取用户详细信息（需要遍历所有token获取username/role）
  const online = [];
  if (redisClient) {
    try {
      for await (const key of redisClient.scanIterator({ MATCH: 'tk:*', COUNT: 100 })) {
        const raw = await redisClient.get(key);
        if (raw) {
          const t = JSON.parse(raw);
          if (t.expires > Date.now() && onlineIds.has(t.userId)) {
            online.push({ userId: t.userId, username: t.username, role: t.role });
          }
        }
      }
    } catch {}
  }
  // 如果Redis失败，使用内存降级
  if (online.length === 0) {
    const seen = new Set();
    Object.values(tokens).forEach(t => {
      if (t.expires > Date.now() && !seen.has(t.userId)) {
        seen.add(t.userId);
        online.push({ userId: t.userId, username: t.username, role: t.role });
      }
    });
  }
  sendJSON(res, online);
}

async function handleGetSubordinates(req, res, user) {
  if (user.role !== 'admin' && user.role !== 'superadmin') return sendJSON(res, { error: '无权限' }, 403);
  const [allUsers] = await pool.execute('SELECT * FROM users WHERE parentId = ? OR createdBy = ?', [user.userId, user.userId]);
  const onlineIds = await getOnlineUserIds();
  sendJSON(res, allUsers.map(u => ({ id: u.id, username: u.username, role: u.role, system: u.system || 'maintenance', parentId: u.parentId || null, createdAt: u.createdAt, online: onlineIds.has(u.id) })));
}

async function handlePromoteUser(req, res, user, userId) {
  // Only superadmin can promote users to admin
  if (user.role !== 'superadmin') return sendJSON(res, { error: '仅超级管理员可执行晋升操作' }, 403);
  const [target] = await pool.execute('SELECT * FROM users WHERE id = ?', [userId]);
  if (target.length === 0) return sendJSON(res, { error: '用户不存在' }, 404);
  if (target[0].role === 'superadmin') return sendJSON(res, { error: '无法修改超级管理员角色' }, 403);
  if (target[0].role === 'admin') {
    // Demote to user
    await pool.execute('UPDATE users SET role = ? WHERE id = ?', ['user', userId]);
    broadcastSSE('users_updated', {});
    return sendJSON(res, { success: true, message: '已降级为普通用户', newRole: 'user' });
  }
  // Promote to admin
  await pool.execute('UPDATE users SET role = ? WHERE id = ?', ['admin', userId]);
  broadcastSSE('users_updated', {});
  sendJSON(res, { success: true, message: '已晋升为管理员', newRole: 'admin' });
}

async function handleToggleUserStatus(req, res, authUser, userId) {
  if (authUser.role !== 'admin' && authUser.role !== 'superadmin') return sendJSON(res, { error: '仅管理员可执行此操作' }, 403);
  const [target] = await pool.execute('SELECT * FROM users WHERE id = ?', [userId]);
  if (target.length === 0) return sendJSON(res, { error: '用户不存在' }, 404);
  if (target[0].role === 'superadmin') return sendJSON(res, { error: '无法禁用超级管理员' }, 403);
  if (authUser.role === 'admin' && target[0].role === 'admin') return sendJSON(res, { error: '管理员无法禁用其他管理员' }, 403);
  const currentStatus = target[0].status || 'active';
  const newStatus = currentStatus === 'disabled' ? 'active' : 'disabled';
  await pool.execute('UPDATE users SET status = ? WHERE id = ?', [newStatus, userId]);
  // If disabled, invalidate all their tokens (force logout)
  if (newStatus === 'disabled') {
    await invalidateUserTokens(userId);
    saveTokens();
  }
  broadcastSSE('users_updated', {});
  sendJSON(res, { success: true, status: newStatus, message: newStatus === 'disabled' ? '已禁用' : '已启用' });
}

async function handleGetTechSupportList(req, res, authUser) {
  // 使用缓存（10秒TTL）避免每次请求都加载+解析555条JSON
  const items = await _cached('tech_support', async () => {
    const [rows] = await pool.execute('SELECT data FROM tech_support ORDER BY id DESC');
    return rows.map(r => JSON.parse(r.data));
  });
  // 权限过滤（运营系统用户只看自己的）
  let filtered = items;
  if (authUser.system === 'operations' && authUser.role !== 'superadmin') {
    if (authUser.role === 'admin') {
      const [subs] = await pool.execute('SELECT id FROM users WHERE parentId = ?', [authUser.userId]);
      const subIds = new Set(subs.map(s => s.id));
      subIds.add(authUser.userId);
      filtered = items.filter(item => subIds.has(item.submitterId));
    } else {
      filtered = items.filter(item => item.submitterId === authUser.userId);
    }
  }
  filtered.sort((a, b) => new Date(b.submittedAt || 0) - new Date(a.submittedAt || 0));
  sendJSON(res, filtered);
}

async function handleGetTechSupportDetail(req, res, authUser, id) {
  const [rows] = await pool.execute('SELECT data FROM tech_support WHERE id = ?', [id]);
  if (rows.length === 0) return sendJSON(res, { error: '请求不存在' }, 404);
  const item = JSON.parse(rows[0].data);
  if (authUser.system === 'operations' && authUser.role !== 'superadmin') {
    let allowed = item.submitterId === authUser.userId;
    if (!allowed && authUser.role === 'admin') {
      // Admin can also view subordinates' requests
      const [sub] = await pool.execute('SELECT id FROM users WHERE id = ? AND parentId = ?', [item.submitterId, authUser.userId]);
      allowed = sub.length > 0;
    }
    if (!allowed) return sendJSON(res, { error: '无权限查看' }, 403);
  }
  sendJSON(res, item);
}

async function handleGetRepairResults(req, res) {
  const [rows] = await pool.execute('SELECT data FROM tech_support ORDER BY id DESC LIMIT 2000');
  const results = new Set();
  for (const row of rows) {
    try {
      const item = JSON.parse(row.data);
      if (item.result && item.result.trim()) results.add(item.result.trim());
    } catch {}
  }
  sendJSON(res, [...results].sort());
}

// ==================== 共享记忆（故障说明 / 维修结果） ====================
async function handleGetMemoryList(req, res, authUser, category) {
  if (category === 'fault_description') {
    if (authUser.system !== 'operations' && authUser.role !== 'superadmin') {
      return sendJSON(res, { error: '仅运营用户可查看故障说明记忆' }, 403);
    }
  } else if (category === 'repair_result') {
    if (authUser.system !== 'maintenance' && authUser.role !== 'superadmin') {
      return sendJSON(res, { error: '仅运维用户可查看维修结果记忆' }, 403);
    }
  } else {
    return sendJSON(res, { error: '无效的分类' }, 400);
  }

  const [rows] = await pool.execute(
    'SELECT text, useCount, lastUsedAt FROM tech_support_memory WHERE category = ? ORDER BY useCount DESC, lastUsedAt DESC LIMIT 50',
    [category]
  );
  sendJSON(res, rows);
}

async function handleAddMemory(req, res, authUser, category, body) {
  const text = (body && body.text || '').trim();
  if (!text || text.length < 2) {
    return sendJSON(res, { error: '内容太短' }, 400);
  }
  if (text.length > 1000) {
    return sendJSON(res, { error: '内容太长（最多1000字）' }, 400);
  }

  if (category === 'fault_description') {
    if (authUser.system !== 'operations' && authUser.role !== 'superadmin') {
      return sendJSON(res, { error: '仅运营用户可添加故障说明记忆' }, 403);
    }
  } else if (category === 'repair_result') {
    if (authUser.system !== 'maintenance' && authUser.role !== 'superadmin') {
      return sendJSON(res, { error: '仅运维用户可添加维修结果记忆' }, 403);
    }
  } else {
    return sendJSON(res, { error: '无效的分类' }, 400);
  }

  const now = new Date().toISOString();
  try {
    const [existing] = await pool.execute(
      'SELECT id FROM tech_support_memory WHERE category = ? AND text = ?',
      [category, text]
    );
    if (existing.length > 0) {
      await pool.execute(
        'UPDATE tech_support_memory SET useCount = useCount + 1, lastUsedAt = ? WHERE id = ?',
        [now, existing[0].id]
      );
    } else {
      await pool.execute(
        'INSERT INTO tech_support_memory (category, text, useCount, lastUsedAt, createdBy, createdAt) VALUES (?, ?, 1, ?, ?, ?)',
        [category, text, now, authUser.userId, now]
      );
    }
    sendJSON(res, { success: true });
  } catch (e) {
    sendJSON(res, { error: e.message }, 500);
  }
}

async function handleSubmitTechSupport(req, res, authUser, body) {
  // Only operations users (or superadmin) can submit
  if (authUser.system !== 'operations' && authUser.role !== 'superadmin') {
    return sendJSON(res, { error: '仅运营用户可提交技术支持请求' }, 403);
  }
  const { equipmentType, equipmentTypeName, machineId, machineNumber, faultType, faultDescription } = body;
  if (!equipmentType || !machineId || !faultType) {
    return sendJSON(res, { error: '请填写所有必填字段' }, 400);
  }

  // 检查该设备是否已有未完成的技术支持（使用缓存避免全表扫描）
  const machineNo = machineNumber || machineId;
  const existingItems = await _cached('tech_support', async () => {
    const [rows] = await pool.execute('SELECT data FROM tech_support ORDER BY id DESC');
    return rows.map(r => JSON.parse(r.data));
  });
  const unfinished = existingItems.find(
    item => (item.machineNumber === machineNo || item.machineId === machineId) &&
            (item.status === 'pending' || item.status === 'responded')
  );
  if (unfinished) {
    const statusLabel = unfinished.status === 'pending' ? '待响应' : '处理中';
    return sendJSON(res, {
      error: `设备 ${machineNo} 已有 ${statusLabel} 的技术支持请求（提交人：${unfinished.submitterName}），请等待维修完成后再提交`,
    }, 400);
  }
  const now = new Date().toISOString();
  const id = 'ts-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const item = {
    id,
    submitterId: authUser.userId,
    submitterName: authUser.displayName || authUser.username,
    equipmentType,
    equipmentTypeName: equipmentTypeName || equipmentType,
    machineId,
    machineNumber: machineNumber || machineId,
    faultType,
    faultDescription: faultDescription || '',
    status: 'pending',
    responderId: null,
    responderName: null,
    respondedAt: null,
    completedAt: null,
    result: '',
    submittedAt: now,
    createdAt: now,
    waitSeconds: null,
    repairSeconds: null,
    totalSeconds: null,
  };
  await pool.execute('INSERT INTO tech_support (id, data) VALUES (?, ?)', [id, JSON.stringify(item)]);
  // Update machine status to waiting_repair
  await _updateMachineStatusByNumber(item.machineNumber, 'waiting_repair');
  broadcastSSE('tech_support_updated', { action: 'created', id });
  broadcastSSE('machines_updated', {});
  sendJSON(res, { success: true, item });
  // 实时通知: 飞书多维表格同步 + 飞书群消息推送
  setImmediate(() => {
    realtime.notifyNewTechSupport(item);
    feishu.syncToFeishu(item).catch(e => console.error('[Feishu] Sync err:', e.message));
    feishu.sendGroupMessage(
      '🔧 新的技术支持请求',
      `**提交人：** ${item.submitterName}\n**设备：** ${item.equipmentTypeName || item.equipmentType}\n**机器编号：** ${item.machineNumber}\n**故障类型：** ${item.faultType}\n**故障描述：** ${item.faultDescription || '无'}\n**提交时间：** ${new Date(item.submittedAt).toLocaleString('zh-CN')}\n\n[查看详情](http://10.5.50.100:8765)`
    ).catch(e => console.error('[Feishu] Notify err:', e.message));
  });
}

async function handleRespondTechSupport(req, res, authUser, id) {
  // Only maintenance users can respond
  if (authUser.system !== 'maintenance' && authUser.role !== 'superadmin') {
    return sendJSON(res, { error: '仅运维人员可响应技术支持请求' }, 403);
  }
  const [rows] = await pool.execute('SELECT data FROM tech_support WHERE id = ?', [id]);
  if (rows.length === 0) return sendJSON(res, { error: '请求不存在' }, 404);
  const item = JSON.parse(rows[0].data);
  if (item.status !== 'pending') {
    return sendJSON(res, { error: '该请求已被响应或已完成' }, 400);
  }
  const now = new Date().toISOString();
  item.status = 'responded';
  item.responderId = authUser.userId;
  item.responderName = authUser.username;
  item.respondedAt = now;
  item.waitSeconds = Math.round((new Date(now) - new Date(item.submittedAt)) / 1000);
  await pool.execute('REPLACE INTO tech_support (id, data) VALUES (?, ?)', [id, JSON.stringify(item)]);
  // Update machine status to repairing
  await _updateMachineStatusByNumber(item.machineNumber, 'repairing');
  broadcastSSE('tech_support_updated', { action: 'responded', id });
  broadcastSSE('machines_updated', {});
  sendJSON(res, { success: true, item });
  // 🔴 微信级实时通知: 运营提交人立即看到"已响应"
  setImmediate(() => {
    realtime.notifyTechResponded(item);
    feishu.syncToFeishu(item).catch(e => console.error("[Feishu] Sync err:", e.message));
  });
}

async function handleCompleteTechSupport(req, res, authUser, id, body) {
  // Only maintenance users can complete
  if (authUser.system !== 'maintenance' && authUser.role !== 'superadmin') {
    return sendJSON(res, { error: '仅运维人员可完成技术支持请求' }, 403);
  }
  const [rows] = await pool.execute('SELECT data FROM tech_support WHERE id = ?', [id]);
  if (rows.length === 0) return sendJSON(res, { error: '请求不存在' }, 404);
  const item = JSON.parse(rows[0].data);
  if (item.status === 'completed' || item.status === 'closed') {
    return sendJSON(res, { error: '该请求已完成' }, 400);
  }
  if (item.status !== 'responded') {
    return sendJSON(res, { error: '请先响应技术支持请求，再进行维修完成' }, 400);
  }
  const result = (body && body.result || '').trim();
  if (!result) return sendJSON(res, { error: '维修结果为必填项，请填写维修结果' }, 400);
  const now = new Date().toISOString();
  item.status = 'completed';
  item.completedAt = now;
  item.result = result;
  item.repairSeconds = Math.round((new Date(now) - new Date(item.respondedAt)) / 1000);
  item.totalSeconds = Math.round((new Date(now) - new Date(item.submittedAt)) / 1000);
  await pool.execute('REPLACE INTO tech_support (id, data) VALUES (?, ?)', [id, JSON.stringify(item)]);
  // Restore machine status to online
  await _updateMachineStatusByNumber(item.machineNumber, 'online');
  broadcastSSE('tech_support_updated', { action: 'completed', id });
  broadcastSSE('machines_updated', {});
  sendJSON(res, { success: true, item });
  // 实时通知: 飞书同步
  setImmediate(() => {
    realtime.notifyTechCompleted(item);
    feishu.syncToFeishu(item).catch(e => console.error("[Feishu] Sync err:", e.message));
  });
}

async function handleDeleteTechSupport(req, res, authUser, id) {
  // Only maintenance system admin/superadmin can delete
  if (authUser.system !== 'maintenance' || (authUser.role !== 'admin' && authUser.role !== 'superadmin')) {
    return sendJSON(res, { error: '仅运维系统管理员可删除维修日志' }, 403);
  }
  const item = await readJSONById('tech_support', id);
  if (!item) return sendJSON(res, { error: '记录不存在' }, 404);
  await deleteJSON('tech_support', id);
  broadcastSSE('tech_support_updated', { action: 'deleted', id });
  sendJSON(res, { success: true });
  // Sync delete to Feishu (background, zero impact on response time)
  setImmediate(() => feishu.deleteFromFeishu(id).catch(e => console.error("[Feishu] Delete err:", e.message)));
}

async function handleGetUserRepairStats(req, res, authUser, userId) {
  try {
  const isOps = authUser.system === 'operations';
  const isSuper = authUser.role === 'superadmin';
  const isAdmin = authUser.role === 'admin';

  // 自己可以看自己
  if (userId === authUser.userId) {
    // 允许
  } else if (isSuper) {
    // 超级管理员可以看所有人
  } else if (isAdmin) {
    // 管理员/组长：只能看自己的组员
    const [sub] = await pool.execute(
      'SELECT id FROM users WHERE id = ? AND (parentId = ? OR createdBy = ?)',
      [userId, authUser.userId, authUser.userId]
    );
    if (sub.length === 0) {
      return sendJSON(res, { error: '无权限查看该用户数据' }, 403);
    }
  } else if (isOps && authUser.role === 'user') {
    // 运营系统普通组员：可以看同组的人
    const [me] = await pool.execute('SELECT parentId, createdBy FROM users WHERE id = ?', [authUser.userId]);
    const leaderId = me[0]?.parentId || me[0]?.createdBy;
    if (!leaderId) {
      return sendJSON(res, { error: '无权限查看该用户数据' }, 403);
    }
    // 目标用户是组长本人，或者和我同一个组长
    const [colleague] = await pool.execute(
      'SELECT id FROM users WHERE id = ? AND (id = ? OR parentId = ? OR createdBy = ?)',
      [userId, leaderId, leaderId, leaderId]
    );
    if (colleague.length === 0) {
      return sendJSON(res, { error: '无权限查看该用户数据' }, 403);
    }
  } else {
    return sendJSON(res, { error: '无权限查看' }, 403);
  }

  // Get user info
  const [userRows] = await pool.execute('SELECT id, username, displayName, role, `system`, createdAt FROM users WHERE id = ?', [userId]);
  if (userRows.length === 0) return sendJSON(res, { error: '用户不存在' }, 404);
  const userInfo = userRows[0];

  // Get tech support items (from cache with error handling)
  let userItems = [];
  try {
    const items = await _cached('tech_support', async () => {
      const [rows] = await pool.execute('SELECT data FROM tech_support ORDER BY id DESC');
      return rows.map(r => {
        try { return JSON.parse(r.data); } catch (e) { return null; }
      }).filter(Boolean);
    });
    userItems = items.filter(item => item.submitterId === userId);
  } catch (e) {
    console.error('[UserStats] Query tech_support error:', e.message);
    userItems = [];
  }

  // Calculate date ranges
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStart = new Date(yesterday.getFullYear(), yesterday.getMonth(), yesterday.getDate()).toISOString();
  const yesterdayEnd = todayStart;
  const weekAgo = new Date(now);
  weekAgo.setDate(weekAgo.getDate() - 7);
  const weekStart = weekAgo.toISOString();
  // Helper: get completed items within a date range
  const getCompletedInRange = (list, start, end) => list.filter(item => {
    if (item.status !== 'completed' || !item.completedAt) return false;
    const t = item.completedAt;
    return t >= start && (!end || t < end);
  });
  // Calculate stats
  const weekItems = getCompletedInRange(userItems, weekStart, null);
  const weekTechSupportSeconds = weekItems.reduce((sum, item) => sum + (item.totalSeconds || 0), 0);
  const yesterdayItems = getCompletedInRange(userItems, yesterdayStart, yesterdayEnd);
  const yesterdayRepairSeconds = yesterdayItems.reduce((sum, item) => sum + (item.repairSeconds || 0), 0);
  const todayItems = getCompletedInRange(userItems, todayStart, null);
  const todayRepairSeconds = todayItems.reduce((sum, item) => sum + (item.repairSeconds || 0), 0);
  // Repair logs (all items, latest first, limited to 50)
  const repairLogs = userItems.slice(0, 50).map(item => ({
    id: item.id,
    machineNumber: item.machineNumber,
    equipmentTypeName: item.equipmentTypeName,
    faultType: item.faultType,
    faultDescription: item.faultDescription,
    status: item.status,
    result: item.result,
    submittedAt: item.submittedAt,
    respondedAt: item.respondedAt,
    completedAt: item.completedAt,
    responderName: item.responderName,
    waitSeconds: item.waitSeconds,
    repairSeconds: item.repairSeconds,
    totalSeconds: item.totalSeconds,
  }));
  sendJSON(res, {
    user: {
      id: userInfo.id,
      username: userInfo.username,
      displayName: userInfo.displayName || userInfo.username,
      role: userInfo.role,
      system: userInfo.system,
      createdAt: userInfo.createdAt,
    },
    stats: {
      weekTechSupportSeconds,
      yesterdayRepairSeconds,
      todayRepairSeconds,
      totalSubmitted: userItems.length,
      totalCompleted: userItems.filter(i => i.status === 'completed').length,
    },
    repairLogs,
  });
  } catch (e) {
    console.error('[UserStats] Unexpected error:', e);
    sendJSON(res, { error: '加载失败：' + e.message }, 500);
  }
}

// ==================== TASK PROGRESS (任务进度) ====================
async function handleSubmitTaskProgress(req, res, authUser, body) {
  // 只有普通用户可以提交任务进度，管理员不行
  if (authUser.role !== 'user') {
    return sendJSON(res, { error: '仅普通组员可提交任务进度' }, 403);
  }

  const { progress, note } = body || {};
  const numProgress = parseFloat(progress);
  if (isNaN(numProgress)) {
    return sendJSON(res, { error: '进度值无效' }, 400);
  }

  const today = new Date().toISOString().split('T')[0];
  const hour = new Date().getHours();

  const [existing] = await pool.execute(
    'SELECT * FROM task_progress WHERE userId = ? AND date = ?',
    [authUser.userId, today]
  );

  if (existing.length > 0) {
    const record = existing[0];
    const history = JSON.parse(record.history || '[]');
    const lastEntry = history[history.length - 1];

    if (lastEntry && hour - lastEntry.hour < 1) {
      return sendJSON(res, { error: '距离上次提交不足1小时，请稍后再试' }, 400);
    }

    const dayProgress = numProgress - (record.startProgress || numProgress);
    history.push({
      hour,
      progress: numProgress,
      note: note || '',
      submittedAt: new Date().toISOString()
    });

    await pool.execute(
      'UPDATE task_progress SET currentProgress = ?, dayProgress = ?, history = ?, updatedAt = ? WHERE id = ?',
      [numProgress, dayProgress, JSON.stringify(history), new Date().toISOString(), record.id]
    );
  } else {
    await pool.execute(
      'INSERT INTO task_progress (userId, date, startProgress, currentProgress, dayProgress, history, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [authUser.userId, today, numProgress, numProgress, 0, JSON.stringify([{
        hour,
        progress: numProgress,
        note: note || '',
        submittedAt: new Date().toISOString()
      }]), new Date().toISOString()]
    );
  }

  sendJSON(res, { success: true, message: '进度已提交' });
}

async function handleGetTaskProgress(req, res, authUser) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const date = url.searchParams.get('date') || new Date().toISOString().split('T')[0];
  const targetUserId = url.searchParams.get('userId');
  const isAdmin = authUser.role === 'admin' || authUser.role === 'superadmin';

  // 获取同组人员ID列表
  let groupUserIds = [];
  let groupUsers = [];

  if (isAdmin) {
    // 管理员：获取自己的组员
    const [subs] = await pool.execute(
      'SELECT id, username, displayName FROM users WHERE parentId = ? OR createdBy = ? ORDER BY username',
      [authUser.userId, authUser.userId]
    );
    groupUsers = subs;
    groupUserIds = subs.map(s => s.id);
  } else {
    // 普通组员：找到自己的组长，然后获取同组所有人
    const [me] = await pool.execute('SELECT parentId, createdBy FROM users WHERE id = ?', [authUser.userId]);
    const leaderId = me[0]?.parentId || me[0]?.createdBy;
    if (leaderId) {
      // 获取组长信息
      const [leader] = await pool.execute('SELECT id, username, displayName FROM users WHERE id = ?', [leaderId]);
      // 获取同组组员
      const [subs] = await pool.execute(
        'SELECT id, username, displayName FROM users WHERE parentId = ? OR createdBy = ? ORDER BY username',
        [leaderId, leaderId]
      );
      groupUsers = [...leader, ...subs];
      groupUserIds = groupUsers.map(u => u.id);
    }
  }

  // 如果指定了userId，只返回该用户的进度（有权限检查）
  if (targetUserId) {
    if (targetUserId !== authUser.userId && !groupUserIds.includes(targetUserId)) {
      return sendJSON(res, { error: '无权限查看该用户进度' }, 403);
    }
    const [record] = await pool.execute(
      'SELECT tp.*, u.username, u.displayName FROM task_progress tp JOIN users u ON tp.userId = u.id WHERE tp.userId = ? AND tp.date = ?',
      [targetUserId, date]
    );
    return sendJSON(res, {
      date,
      targetUser: groupUsers.find(u => u.id === targetUserId) || { id: targetUserId },
      progress: record[0] || null,
      groupUsers,
    });
  }

  // 返回自己和同组所有人的进度
  let myProgress = null;
  let groupProgress = [];

  if (groupUserIds.length > 0) {
    const placeholders = groupUserIds.map(() => '?').join(',');
    const [records] = await pool.execute(
      `SELECT tp.*, u.username, u.displayName FROM task_progress tp JOIN users u ON tp.userId = u.id WHERE tp.userId IN (${placeholders}) AND tp.date = ?`,
      [...groupUserIds, date]
    );
    groupProgress = records;
  }

  // 找出自己的进度
  const myRecord = groupProgress.find(r => r.userId === authUser.userId);
  myProgress = myRecord || null;

  const result = {
    userId: authUser.userId,
    username: authUser.username,
    date,
    myProgress,
    groupProgress: groupProgress.filter(r => r.userId !== authUser.userId),
    groupUsers,
    isAdmin,
  };

  sendJSON(res, result);
}

// Helper: Update the latest machine record's status by machineNumber
async function _updateMachineStatusByNumber(machineNumber, newStatus) {
  if (!machineNumber) return;
  try {
    const [allRows] = await pool.execute('SELECT id, data FROM machines');
    let latestRow = null;
    let latestTime = 0;
    let matchCount = 0;
    for (const row of allRows) {
      let d;
      try { d = JSON.parse(row.data); } catch { continue; }
      if (d.machineNumber === machineNumber) {
        matchCount++;
        const t = d.updatedAt ? new Date(d.updatedAt).getTime() : 0;
        if (t > latestTime || latestRow === null) { latestTime = t; latestRow = { id: row.id, data: d }; }
      }
    }
    if (latestRow) {
      latestRow.data.status = newStatus;
      latestRow.data.updatedAt = new Date().toISOString();
      await pool.execute('REPLACE INTO machines (id, data) VALUES (?, ?)', [latestRow.id, JSON.stringify(latestRow.data)]);
      console.log(`[Machine Status] ${machineNumber} -> ${newStatus} (matched ${matchCount} records)`);
    } else {
      console.log(`[Machine Status] ${machineNumber} not found in ${allRows.length} machine records`);
    }
  } catch (e) {
    console.error('[Machine Status Update Error]', e.message);
  }
}

// ==================== POPUP MESSAGES ====================
async function handleGetPopupMessages(req, res, authUser) {
  const url = new URL(req.url, 'http://localhost');
  const category = url.searchParams.get('category') || '';
  let sql = 'SELECT * FROM popup_messages';
  const params = [];
  if (category) { sql += ' WHERE category = ?'; params.push(category); }
  sql += ' ORDER BY createdAt DESC';
  const [rows] = await pool.execute(sql, params);
  sendJSON(res, rows.map(r => ({ id: r.id, category: r.category, text: r.text, createdBy: r.createdBy, createdAt: r.createdAt })));
}

async function handleGetRandomPopupMessage(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const category = url.searchParams.get('category') || 'submit';
  const [rows] = await pool.execute('SELECT text FROM popup_messages WHERE category = ? ORDER BY RAND() LIMIT 1', [category]);
  if (rows.length === 0) {
    // Fallback messages if none in DB
    const fallbacks = {
      submit: '提交成功！运维人员正在赶来！',
      complete: '维修完成！辛苦了！',
    };
    return sendJSON(res, { text: fallbacks[category] || '操作成功！' });
  }
  sendJSON(res, { text: rows[0].text });
}

async function handleAddPopupMessage(req, res, authUser, body) {
  if (authUser.role !== 'admin' && authUser.role !== 'superadmin') {
    return sendJSON(res, { error: '仅管理员可管理弹窗句子' }, 403);
  }
  const { category, text } = body;
  if (!category || !text || !text.trim()) {
    return sendJSON(res, { error: '分类和内容不能为空' }, 400);
  }
  if (!['submit', 'complete'].includes(category)) {
    return sendJSON(res, { error: '无效的分类，可选值：submit, complete' }, 400);
  }
  const id = 'pm-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  await pool.execute('INSERT INTO popup_messages (id, category, text, createdBy, createdAt) VALUES (?, ?, ?, ?, ?)',
    [id, category, text.trim(), authUser.userId, new Date().toISOString()]);
  sendJSON(res, { success: true, id });
}

async function handleDeletePopupMessage(req, res, authUser, id) {
  if (authUser.role !== 'admin' && authUser.role !== 'superadmin') {
    return sendJSON(res, { error: '仅管理员可管理弹窗句子' }, 403);
  }
  await pool.execute('DELETE FROM popup_messages WHERE id = ?', [id]);
  sendJSON(res, { success: true });
}

// ==================== GROUP TRANSFERS ====================
// Group leader (admin with system='operations') can transfer members between groups
// Both leaders must approve for the transfer to take effect

async function handleCreateGroupTransfer(req, res, authUser, body) {
  if (authUser.role !== 'admin' && authUser.role !== 'superadmin') {
    return sendJSON(res, { error: '仅组长可发起调配' }, 403);
  }
  const { toAdminId, userId, username, direction, reason } = body;
  if (!toAdminId || !userId || !direction) {
    return sendJSON(res, { error: '缺少必要参数: toAdminId, userId, direction' }, 400);
  }
  if (direction !== 'out' && direction !== 'in') {
    return sendJSON(res, { error: 'direction必须为 out 或 in' }, 400);
  }

  // Verify the other admin exists
  const [adminRows] = await pool.execute(
    'SELECT id, username FROM users WHERE id = ? AND (role = ? OR role = ?)',
    [toAdminId, 'admin', 'superadmin']
  );
  if (adminRows.length === 0) return sendJSON(res, { error: '目标组长不存在或不是管理员' }, 404);

  // Verify the user exists
  const [userRows] = await pool.execute('SELECT id, username, parentId FROM users WHERE id = ?', [userId]);
  if (userRows.length === 0) return sendJSON(res, { error: '被调配用户不存在' }, 404);

  const id = 'gt-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const now = new Date().toISOString();
  const item = {
    id,
    fromAdminId: authUser.userId,
    fromAdminName: authUser.username,
    toAdminId: adminRows[0].id,
    toAdminName: adminRows[0].username,
    userId: userRows[0].id,
    username: userRows[0].username,
    direction,
    status: 'pending',
    reason: reason || '',
    createdAt: now,
    updatedAt: now,
  };

  await pool.execute('REPLACE INTO group_transfers (id, data) VALUES (?, ?)', [id, JSON.stringify(item)]);
  broadcastSSE('group_transfer_updated', { action: 'created', id });
  sendJSON(res, { success: true, item });
}

async function handleApproveGroupTransfer(req, res, authUser, transferId) {
  if (authUser.role !== 'admin' && authUser.role !== 'superadmin') {
    return sendJSON(res, { error: '仅组长可审批调配' }, 403);
  }
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [rows] = await conn.execute('SELECT data FROM group_transfers WHERE id = ? FOR UPDATE', [transferId]);
    if (rows.length === 0) { await conn.rollback(); conn.release(); return sendJSON(res, { error: '调配请求不存在' }, 404); }
    const item = JSON.parse(rows[0].data);
    if (item.status !== 'pending') { await conn.rollback(); conn.release(); return sendJSON(res, { error: '该请求已处理' }, 400); }
    if (item.toAdminId !== authUser.userId && item.fromAdminId !== authUser.userId) {
      await conn.rollback(); conn.release(); return sendJSON(res, { error: '您不是该调配的相关组长，无权审批' }, 403);
    }
    await conn.execute('UPDATE users SET parentId = ? WHERE id = ?', [item.toAdminId, item.userId]);
    item.status = 'completed';
    item.completedAt = new Date().toISOString();
    item.updatedAt = new Date().toISOString();
    await conn.execute('REPLACE INTO group_transfers (id, data) VALUES (?, ?)', [transferId, JSON.stringify(item)]);
    await conn.commit();
    broadcastSSE('users_updated', {});
    broadcastSSE('group_transfer_updated', { action: 'approved', id: transferId });
    sendJSON(res, { success: true, item });
  } catch (e) {
    await conn.rollback();
    sendJSON(res, { error: '审批失败: ' + e.message }, 500);
  } finally {
    conn.release();
  }
}

async function handleRejectGroupTransfer(req, res, authUser, transferId) {
  if (authUser.role !== 'admin' && authUser.role !== 'superadmin') {
    return sendJSON(res, { error: '仅组长可拒绝调配' }, 403);
  }
  const [rows] = await pool.execute('SELECT data FROM group_transfers WHERE id = ?', [transferId]);
  if (rows.length === 0) return sendJSON(res, { error: '调配请求不存在' }, 404);
  const item = JSON.parse(rows[0].data);
  if (item.status !== 'pending') return sendJSON(res, { error: '该请求已处理' }, 400);
  if (item.toAdminId !== authUser.userId && item.fromAdminId !== authUser.userId) {
    return sendJSON(res, { error: '您不是该调配的相关组长，无权拒绝' }, 403);
  }
  item.status = 'rejected';
  item.rejectedBy = authUser.userId;
  item.rejectedByName = authUser.username;
  item.updatedAt = new Date().toISOString();
  await pool.execute('REPLACE INTO group_transfers (id, data) VALUES (?, ?)', [transferId, JSON.stringify(item)]);
  broadcastSSE('group_transfer_updated', { action: 'rejected', id: transferId });
  sendJSON(res, { success: true, item });
}

async function handleCancelGroupTransfer(req, res, authUser, transferId) {
  const [rows] = await pool.execute('SELECT data FROM group_transfers WHERE id = ?', [transferId]);
  if (rows.length === 0) return sendJSON(res, { error: '调配请求不存在' }, 404);
  const item = JSON.parse(rows[0].data);
  if (item.fromAdminId !== authUser.userId && authUser.role !== 'superadmin') {
    return sendJSON(res, { error: '只能取消自己发起的调配' }, 403);
  }
  if (item.status !== 'pending') return sendJSON(res, { error: '只能取消失效的请求' }, 400);
  item.status = 'cancelled';
  item.updatedAt = new Date().toISOString();
  await pool.execute('REPLACE INTO group_transfers (id, data) VALUES (?, ?)', [transferId, JSON.stringify(item)]);
  broadcastSSE('group_transfer_updated', { action: 'cancelled', id: transferId });
  sendJSON(res, { success: true, item });
}

async function handleGetGroupTransfers(req, res, authUser) {
  if (authUser.role !== 'admin' && authUser.role !== 'superadmin') {
    return sendJSON(res, { error: '仅组长可查看调配记录' }, 403);
  }
  const [rows] = await pool.execute('SELECT data FROM group_transfers ORDER BY id DESC');
  const all = rows.map(r => JSON.parse(r.data));
  // Filter: show transfers where this admin is involved (as fromAdmin or toAdmin)
  const mine = all.filter(t =>
    t.fromAdminId === authUser.userId || t.toAdminId === authUser.userId
  );
  sendJSON(res, mine);
}

async function handleGetGroupMembers(req, res, authUser) {
  const isLeader = authUser.role === 'admin' || authUser.role === 'superadmin';
  // System isolation
  let systemFilter = '';
  const params = [];
  if (authUser.role !== 'superadmin') {
    systemFilter = 'AND `system` = ?';
    params.push(authUser.system || 'maintenance');
  }
  const [users] = await pool.execute(
    `SELECT id, username, displayName, role, \`system\`, parentId, createdBy, createdAt
     FROM users WHERE role = 'user' ${systemFilter} ORDER BY username`, params
  );
  // Group by parentId
  const groups = {};
  users.forEach(u => {
    const parent = u.parentId || u.createdBy || 'unknown';
    if (!groups[parent]) groups[parent] = { adminId: parent, members: [] };
    groups[parent].members.push(u);
  });
  // Get admin names (only from same system for non-superadmin)
  const adminIds = Object.keys(groups);
  if (adminIds.length > 0) {
    let adminParams = [...adminIds];
    let adminSystemFilter = '';
    if (authUser.role !== 'superadmin') {
      adminSystemFilter = 'AND `system` = ?';
      adminParams.push(authUser.system || 'maintenance');
    }
    const [admins] = await pool.execute(
      `SELECT id, username, displayName FROM users WHERE id IN (${adminIds.map(() => '?').join(',')}) ${adminSystemFilter}`,
      adminParams
    );
    admins.forEach(a => {
      if (groups[a.id]) groups[a.id].adminName = a.displayName || a.username;
    });
    // Remove groups whose admin wasn't found (different system)
    for (const gid of Object.keys(groups)) {
      if (!groups[gid].adminName) delete groups[gid];
    }
  }

  const allGroups = Object.values(groups);

  // 普通用户：只返回自己所在的组
  if (!isLeader) {
    const myGroups = allGroups.filter(g =>
      g.adminId === authUser.userId ||
      g.members.some(m => m.id === authUser.userId)
    );
    // 如果没在组里，就查一下自己的组长
    if (myGroups.length === 0) {
      const [me] = await pool.execute('SELECT parentId, createdBy FROM users WHERE id = ?', [authUser.userId]);
      const leaderId = me[0]?.parentId || me[0]?.createdBy;
      if (leaderId && groups[leaderId]) {
        myGroups.push(groups[leaderId]);
      }
    }
    sendJSON(res, myGroups);
    return;
  }

  sendJSON(res, allGroups);
}

async function handleLogout(req, res, user) {
  const auth = req.headers['authorization'];
  if (auth && auth.startsWith('Bearer ')) {
    const token = auth.slice(7);
    if (redisClient) { try { await redisClient.del(`tk:${token}`); } catch {} }
    delete tokens[token];
    saveTokens();
  }
  broadcastSSE('users_updated', {});
  sendJSON(res, { success: true }, 200, req, {
    'Set-Cookie': 'gms_token=; Path=/; Max-Age=0',
  });
}

async function handleBeaconLogout(req, res, body) {
  if (body && body.token) {
    if (redisClient) { try { await redisClient.del(`tk:${body.token}`); } catch {} }
    delete tokens[body.token];
    saveTokens();
    broadcastSSE('users_updated', {});
  }
  sendJSON(res, { success: true });
}

async function handleChangePassword(req, res, user, body) {
  const { oldPassword, newPassword } = body;
  if (!oldPassword || !newPassword) return sendJSON(res, { error: '请输入旧密码和新密码' }, 400);
  const trimmedPw = newPassword.trim();
  if (trimmedPw.length < 6) return sendJSON(res, { error: '新密码至少6个字符' }, 400);
  if (!/[A-Za-z]/.test(trimmedPw) || !/[0-9]/.test(trimmedPw)) return sendJSON(res, { error: '新密码需包含字母和数字' }, 400);
  const [rows] = await pool.execute('SELECT * FROM users WHERE id = ?', [user.userId]);
  if (rows.length === 0) return sendJSON(res, { error: '用户不存在' }, 404);
  if (rows[0].passwordHash !== hashPassword(oldPassword)) return sendJSON(res, { error: '旧密码错误' }, 403);
  await pool.execute('UPDATE users SET passwordHash = ? WHERE id = ?', [hashPassword(trimmedPw), user.userId]);
  sendJSON(res, { success: true });
}

// Reset another user's password (superadmin → admin, admin → group members)
async function handleResetPassword(req, res, user, userId, body) {
  const { newPassword } = body;
  const trimmedPw = (newPassword || '').trim();
  if (!trimmedPw || trimmedPw.length < 6) return sendJSON(res, { error: '新密码至少6个字符' }, 400);
  if (!/[A-Za-z]/.test(trimmedPw) || !/[0-9]/.test(trimmedPw)) return sendJSON(res, { error: '新密码需包含字母和数字' }, 400);

  // Only admin and superadmin can reset others' passwords
  if (user.role !== 'admin' && user.role !== 'superadmin') return sendJSON(res, { error: '无权限' }, 403);

  // Cannot reset own password through this endpoint
  if (user.userId === userId) return sendJSON(res, { error: '请使用修改密码功能修改自己的密码' }, 400);

  const [target] = await pool.execute('SELECT * FROM users WHERE id = ?', [userId]);
  if (target.length === 0) return sendJSON(res, { error: '用户不存在' }, 404);
  const targetUser = target[0];

  // Superadmin: can reset admin/user passwords, same-system only, cannot reset other superadmins
  if (user.role === 'superadmin') {
    if (targetUser.role === 'superadmin') return sendJSON(res, { error: '无法重置其他超级管理员的密码' }, 403);
    if (targetUser.system !== user.system) return sendJSON(res, { error: '只能重置本系统内用户的密码' }, 403);
  }

  // Admin: can only reset their own group members' passwords (not other admins)
  if (user.role === 'admin') {
    if (targetUser.role === 'admin' || targetUser.role === 'superadmin') return sendJSON(res, { error: '无法重置管理员或超级管理员的密码' }, 403);
    if (targetUser.parentId !== user.userId && targetUser.createdBy !== user.userId) {
      return sendJSON(res, { error: '只能重置自己组员的密码' }, 403);
    }
  }

  await pool.execute('UPDATE users SET passwordHash = ?, passwordPlain = ? WHERE id = ?', [hashPassword(trimmedPw), trimmedPw, userId]);

  // Invalidate target user's tokens (force re-login)
  await invalidateUserTokens(userId);
  saveTokens();

  broadcastSSE('users_updated', {});
  sendJSON(res, { success: true, message: '密码重置成功' });
}

// 查看组员密码（仅admin/superadmin可查看自己组员）
async function handleGetUserPassword(req, res, user, userId) {
  if (user.role !== 'admin' && user.role !== 'superadmin') return sendJSON(res, { error: '无权限' }, 403);

  const [target] = await pool.execute('SELECT * FROM users WHERE id = ?', [userId]);
  if (target.length === 0) return sendJSON(res, { error: '用户不存在' }, 404);
  const targetUser = target[0];

  // 不能查看自己的密码
  if (user.userId === userId) return sendJSON(res, { error: '无法查看自己的密码' }, 400);

  // 不能查看超级管理员的密码
  if (targetUser.role === 'superadmin') return sendJSON(res, { error: '无法查看超级管理员的密码' }, 403);

  // 系统隔离：只能查看本系统用户
  if (targetUser.system !== user.system) return sendJSON(res, { error: '只能查看本系统内用户的密码' }, 403);

  // admin 只能查看自己组员的密码
  if (user.role === 'admin') {
    if (targetUser.role === 'admin') return sendJSON(res, { error: '无法查看其他管理员的密码' }, 403);
    if (targetUser.parentId !== user.userId && targetUser.createdBy !== user.userId) {
      return sendJSON(res, { error: '只能查看自己组员的密码' }, 403);
    }
  }

  // superadmin 不能查看其他超级管理员
  if (user.role === 'superadmin' && targetUser.role === 'superadmin') {
    return sendJSON(res, { error: '无法查看超级管理员的密码' }, 403);
  }

  const password = targetUser.passwordPlain || '';
  sendJSON(res, {
    success: true,
    username: targetUser.username,
    displayName: targetUser.displayName || targetUser.username,
    password: password || '(历史用户密码不可查，可重置)'
  });
}

// -- Inventory --
async function handleGetAllInventory(req, res, user) {
  const [rows] = await pool.execute('SELECT * FROM inventory');
  sendJSON(res, rows.map(r => ({ type: r.inv_type, quantity: r.quantity, updatedAt: r.updatedAt, updatedBy: r.updatedBy })));
}

async function handleGetInventory(req, res, user, type) {
  const [rows] = await pool.execute('SELECT * FROM inventory WHERE inv_type = ?', [type]);
  if (rows.length > 0) {
    sendJSON(res, { type: rows[0].inv_type, quantity: rows[0].quantity, updatedAt: rows[0].updatedAt, updatedBy: rows[0].updatedBy });
  } else {
    sendJSON(res, { type, quantity: 0, updatedAt: null, updatedBy: '' });
  }
}

async function handleAdjustInventory(req, res, user, type, body) {
  const { delta } = body;
  if (typeof delta !== 'number' || !Number.isFinite(delta)) return sendJSON(res, { error: 'delta 必须为有效数字' }, 400);
  if (user.role !== 'admin' && user.role !== 'superadmin') return sendJSON(res, { error: '无权限调整库存' }, 403);
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [rows] = await conn.execute('SELECT quantity FROM inventory WHERE inv_type = ? FOR UPDATE', [type]);
    const currentQty = rows.length > 0 ? rows[0].quantity : 0;
    const newQty = currentQty + (delta || 0);
    if (newQty < 0) { await conn.rollback(); return sendJSON(res, { success: false, message: '库存不足' }, 400); }
    await conn.execute(
      'REPLACE INTO inventory (inv_type, quantity, updatedAt, updatedBy) VALUES (?, ?, ?, ?)',
      [type, newQty, new Date().toISOString(), user.username]
    );
    await conn.commit();
    broadcastSSE('inventory_updated', { type, quantity: newQty, updatedBy: user.username });
    sendJSON(res, { success: true, newQuantity: newQty });
  } catch (e) {
    await conn.rollback();
    sendJSON(res, { error: e.message }, 500);
  } finally {
    conn.release();
  }
}

// -- Machines --
async function handleGetMachines(req, res, user) {
  const result = await _cached('machines', async () => {
    const [rows] = await pool.execute('SELECT data FROM machines ORDER BY id DESC LIMIT 5000');
    const all = rows.map(r => JSON.parse(r.data));
    const latest = new Map();
    for (const m of all) {
      const num = m.machineNumber;
      if (!num) continue;
      if (!latest.has(num)) latest.set(num, m);
    }
    return Array.from(latest.values());
  });
  sendJSON(res, result);
}
async function handleAddMachine(req, res, user, body) {
  // 普通用户可添加上下线记录（含损坏/调用标记）
  const id = body.id || ('m-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6));
  await saveJSON('machines', id, { ...body, id });
  broadcastSSE('machines_updated', {});
  sendJSON(res, { success: true, machine: { ...body, id } });
}
async function handleDeleteMachine(req, res, user, machineId) {
  if (user.role !== 'admin' && user.role !== 'superadmin') return sendJSON(res, { error: '无删除权限' }, 403);
  await deleteJSON('machines', machineId);
  broadcastSSE('machines_updated', {});
  sendJSON(res, { success: true });
}

// -- Transactions --
async function handleGetTransactions(req, res, user) {
  const url = new URL(req.url, 'http://localhost');
  const limit = Math.max(1, parseInt(url.searchParams.get('limit')) || 10000);
  sendJSON(res, await readJSONArray('transactions', Math.min(limit, 50000)));
}
async function handleAddTransaction(req, res, user, body) {
  // 普通用户可添加交易记录（含损坏/调用/上下线等操作）
  const id = body.id || ('tx-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6));
  await saveJSON('transactions', id, { ...body, id, timestamp: body.timestamp || new Date().toISOString() });
  broadcastSSE('transactions_updated', {});
  sendJSON(res, { success: true, transaction: { ...body, id } });
}
async function handleDeleteTransaction(req, res, user, txId) {
  if (user.role !== 'admin' && user.role !== 'superadmin') return sendJSON(res, { error: '无删除权限' }, 403);
  const item = await readJSONById('transactions', txId);
  if (!item) return sendJSON(res, { error: '交易记录不存在' }, 404);
  await deleteJSON('transactions', txId);
  broadcastSSE('transactions_updated', {});
  sendJSON(res, { success: true });
}

// -- Inventory Transfer (物资调拨) --
async function handleTransferInventory(req, res, authUser, body) {
  if (authUser.role !== 'admin' && authUser.role !== 'superadmin') return sendJSON(res, { error: '仅管理员可执行调拨' }, 403);
  const { invType, quantity, destination, note } = body;
  if (!invType || !quantity || !destination) return sendJSON(res, { error: '请填写库存类型、数量和调拨目的地' }, 400);
  const qty = parseInt(quantity);
  if (isNaN(qty) || qty <= 0) return sendJSON(res, { error: '数量必须为正整数' }, 400);
  const dest = (destination || '').trim();
  if (!dest) return sendJSON(res, { error: '调拨目的地不能为空' }, 400);

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [rows] = await conn.execute('SELECT quantity FROM inventory WHERE inv_type = ? FOR UPDATE', [invType]);
    const currentQty = rows.length > 0 ? rows[0].quantity : 0;
    if (currentQty < qty) {
      await conn.rollback();
      return sendJSON(res, { error: `库存不足，当前仅有 ${currentQty} 件` }, 400);
    }
    const newQty = currentQty - qty;
    const now = new Date().toISOString();
    await conn.execute('REPLACE INTO inventory (inv_type, quantity, updatedAt, updatedBy) VALUES (?, ?, ?, ?)',
      [invType, newQty, now, authUser.username]);

    // Record transaction
    const txId = 'tf-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    await conn.execute('INSERT INTO transactions (id, data) VALUES (?, ?)', [txId, JSON.stringify({
      id: txId, equipmentType: invType, direction: 'out', quantity: qty,
      updatedBy: authUser.username, timestamp: now, note: note || `调拨至${dest}`,
      transferDestination: dest, isTransfer: true,
    })]);

    await conn.commit();
    broadcastSSE('inventory_updated', { type: invType, quantity: newQty, updatedBy: authUser.username });
    broadcastSSE('transactions_updated', {});
    sendJSON(res, { success: true, newQuantity: newQty, transferred: qty, destination: dest });
  } catch (e) {
    await conn.rollback();
    sendJSON(res, { error: '调拨失败: ' + e.message }, 500);
  } finally {
    conn.release();
  }
}

// Get transfer stats for dashboard
async function handleGetTransferStats(req, res) {
  const [txRows] = await pool.execute('SELECT data FROM transactions ORDER BY id DESC LIMIT 5000');
  const transfers = txRows.map(r => JSON.parse(r.data)).filter(t => t.isTransfer);
  const today = new Date().setHours(0, 0, 0, 0);
  const todayTransfers = transfers.filter(t => new Date(t.timestamp).getTime() >= today);
  const monthTransfers = transfers.filter(t => {
    const d = new Date(t.timestamp);
    const now = new Date();
    return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
  });
  const byDest = {};
  transfers.forEach(t => {
    const dest = t.transferDestination || '未知';
    byDest[dest] = (byDest[dest] || 0) + t.quantity;
  });
  sendJSON(res, {
    total: transfers.reduce((s, t) => s + t.quantity, 0),
    today: todayTransfers.reduce((s, t) => s + t.quantity, 0),
    thisMonth: monthTransfers.reduce((s, t) => s + t.quantity, 0),
    byDestination: Object.entries(byDest).map(([k, v]) => ({ destination: k, quantity: v })).sort((a, b) => b.quantity - a.quantity),
    recent: transfers.slice(0, 10),
  });
}

// -- Audit Log --
async function handleGetAuditLog(req, res, user) {
  const url = new URL(req.url, 'http://localhost');
  const limit = Math.max(1, parseInt(url.searchParams.get('limit')) || 500);
  sendJSON(res, await readJSONArray('audit_log', Math.min(limit, 5000)));
}

// -- Settings --
async function handleGetSettings(req, res, user) {
  sendJSON(res, await readJSONObject('settings'));
}
async function handleSaveSettings(req, res, user, body) {
  if (user.role !== 'admin' && user.role !== 'superadmin') return sendJSON(res, { error: '仅管理员可修改系统设置' }, 403);
  for (const [k, v] of Object.entries(body)) {
    await pool.execute('REPLACE INTO settings (skey, value) VALUES (?, ?)', [k, JSON.stringify(v)]);
  }
  broadcastSSE('settings_updated', {});
  sendJSON(res, { success: true });
}

// -- Equipment Config --
async function handleGetEquipmentConfig(req, res, authUser) {
  // Auth required
  if (!authUser) return sendJSON(res, { error: '未登录' }, 401);
  const result = await _cached('equipment_config', () => readJSONArray('equipment_config'));
  sendJSON(res, result);
}
async function handleSaveEquipmentConfig(req, res, authUser, body) {
  if (authUser.role !== 'admin' && authUser.role !== 'superadmin') return sendJSON(res, { error: '无权限修改设备配置' }, 403);
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.execute('DELETE FROM equipment_config');
    if (Array.isArray(body)) {
      for (const item of body) {
        await conn.execute('INSERT INTO equipment_config (id, data) VALUES (?, ?)', [item.id, JSON.stringify(item)]);
      }
    }
    await conn.commit();
    broadcastSSE('equipment_config_updated', {});
    sendJSON(res, { success: true });
  } catch (e) {
    await conn.rollback();
    sendJSON(res, { error: '保存失败: ' + e.message }, 500);
  } finally {
    conn.release();
  }
}
async function handleDeleteEquipmentConfig(req, res, authUser, id) {
  if (authUser.role !== 'admin' && authUser.role !== 'superadmin') return sendJSON(res, { error: '无权限删除设备配置' }, 403);
  await deleteJSON('equipment_config', id);
  broadcastSSE('equipment_config_updated', {});
  sendJSON(res, { success: true });
}

// -- Inventory Config --
async function handleGetInventoryConfig(req, res, authUser) {
  // Auth required
  if (!authUser) return sendJSON(res, { error: '未登录' }, 401);
  const result = await _cached('inventory_config', () => readJSONArray('inventory_config'));
  sendJSON(res, result);
}
async function handleSaveInventoryConfig(req, res, authUser, body) {
  if (authUser.role !== 'admin' && authUser.role !== 'superadmin') return sendJSON(res, { error: '无权限修改库存配置' }, 403);
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.execute('DELETE FROM inventory_config');
    if (Array.isArray(body)) {
      for (const item of body) {
        await conn.execute('INSERT INTO inventory_config (id, data) VALUES (?, ?)', [item.id, JSON.stringify(item)]);
      }
    }
    await conn.commit();
    broadcastSSE('inventory_config_updated', {});
    sendJSON(res, { success: true });
  } catch (e) {
    await conn.rollback();
    sendJSON(res, { error: '保存失败: ' + e.message }, 500);
  } finally {
    conn.release();
  }
}
async function handleDeleteInventoryConfig(req, res, authUser, id) {
  if (authUser.role !== 'admin' && authUser.role !== 'superadmin') return sendJSON(res, { error: '无权限删除库存配置' }, 403);
  await deleteJSON('inventory_config', id);
  broadcastSSE('inventory_config_updated', {});
  sendJSON(res, { success: true });
}

// -- Data Integrity --
async function handleDataIntegrity(req, res) {
  const issues = [];
  const [inv] = await pool.execute('SELECT * FROM inventory');
  inv.forEach(i => { if (i.quantity < 0) issues.push({ type: 'negative_stock', item: i.inv_type, detail: `库存为负数: ${i.quantity}` }); });
  const machines = await readJSONArray('machines');
  const eqConfig = await readJSONArray('equipment_config');
  machines.forEach(m => { if (!eqConfig.find(e => e.id === m.deviceType)) issues.push({ type: 'orphaned_machine', item: m.machineNumber, detail: `设备类型 "${m.deviceType}" 不存在` }); });
  sendJSON(res, { issues, count: issues.length });
}

// -- Operations --
async function handleGetOps(req, res, table) {
  validateTable(table);
  sendJSON(res, await readJSONArray(table));
}
async function handleSaveOps(req, res, table, body) {
  validateTable(table);
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.execute(`DELETE FROM ${table}`);
    if (Array.isArray(body)) {
      for (const item of body) {
        await conn.execute(`INSERT INTO ${table} (id, data) VALUES (?, ?)`, [item.id || ('_' + Date.now().toString(36)), JSON.stringify(item)]);
      }
    }
    await conn.commit();
    broadcastSSE(`${table}_updated`, {});
    sendJSON(res, { success: true });
  } catch (e) {
    await conn.rollback();
    sendJSON(res, { error: '保存失败: ' + e.message }, 500);
  } finally {
    conn.release();
  }
}

// -- Last Backup --
function handleLastBackup(req, res) {
  try {
    const stat = fs.statSync(path.join(DATA_DIR, 'gms.db'));
    sendJSON(res, { lastModified: stat.mtime.toISOString() });
  } catch { sendJSON(res, { lastModified: null }); }
}

// -- XLSX Export --
async function handleExportXLSX(req, res, user) {
  const XLSX = require('xlsx');
  const transactions = await readJSONArray('transactions');
  const invConfigs = await readJSONArray('inventory_config');
  const eqConfigs = await readJSONArray('equipment_config');
  const cfgMap = {};
  invConfigs.forEach(c => { cfgMap[c.id] = c; if (c.hasLeftRight) { cfgMap[c.id + '_left'] = { name: c.name + '左手' }; cfgMap[c.id + '_right'] = { name: c.name + '右手' }; } });

  const rows = transactions.map(t => {
    // 设备类型 + 左右手合并到一个列
    let equipLabel = '';
    const handLabel = t.handType === 'left' ? '左手' : t.handType === 'right' ? '右手' : '';
    const cfg = cfgMap[t.equipmentType];
    if (cfg) {
      // 如果有 handType，在设备名前面加上左右手
      equipLabel = handLabel ? handLabel + cfg.name : cfg.name;
    } else if (t.equipmentType === 'glove') {
      equipLabel = handLabel ? handLabel + '手套' : '手套';
    } else if (t.equipmentType === 'dexterous_hand') {
      equipLabel = handLabel ? handLabel + '灵巧手' : '灵巧手';
    } else {
      equipLabel = handLabel ? handLabel + t.equipmentType : t.equipmentType;
    }
    // 更新人：兼容多种字段名
    const updater = t.updatedBy || t.user || t.updatedby || '';
    return {
      '时间': t.timestamp ? new Date(t.timestamp).toLocaleString('zh-CN') : '',
      '设备类型': equipLabel,
      '出入库': t.direction === 'in' ? '入库' : t.direction === 'out' ? '出库' : (t.direction || ''),
      '数量': t.quantity || 0,
      'SN码': t.snCode || '',
      '机器编号': t.machineNumber || '',
      '更新人': updater,
      '备注': t.note || '',
    };
  });

  const ws = XLSX.utils.json_to_sheet(rows);
  ws['!cols'] = [
    { wch: 22 }, { wch: 16 }, { wch: 8 }, { wch: 8 },
    { wch: 8 }, { wch: 18 }, { wch: 14 }, { wch: 12 }, { wch: 22 }
  ];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '流水记录');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

  const filename = encodeURIComponent('流水记录-' + new Date().toISOString().slice(0, 10));
  res.writeHead(200, {
    'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'Content-Disposition': `attachment; filename*=UTF-8''${filename}.xlsx`,
    'Access-Control-Allow-Origin': '*',
  });
  res.end(buf);
}

// -- Tech Support XLSX Export --
async function handleExportTechSupportXLSX(req, res, user) {
  const XLSX = require('xlsx');
  const url = new URL(req.url, 'http://localhost');
  const dateParam = url.searchParams.get('date');       // YYYY-MM-DD
  const startParam = url.searchParams.get('start');     // ISO datetime
  const endParam = url.searchParams.get('end');         // ISO datetime
  const startTime = url.searchParams.get('startTime');  // HH:MM e.g. "07:00"
  const endTime = url.searchParams.get('endTime');      // HH:MM e.g. "02:00"

  const items = await readJSONArray('tech_support');
  // Permission: operations users only see their own
  let data = (user.system === 'operations' && user.role !== 'superadmin')
    ? items.filter(i => i.submitterId === user.userId)
    : items;

  // Date/time range filter
  if (dateParam || startParam || endParam || startTime || endTime) {
    data = data.filter(t => {
      const ts = t.submittedAt ? new Date(t.submittedAt) : null;
      if (!ts || isNaN(ts.getTime())) return false;

      if (dateParam) {
        // Single date: match YYYY-MM-DD
        const d = dateParam.split('-').map(Number);
        if (ts.getFullYear() !== d[0] || ts.getMonth() + 1 !== d[1] || ts.getDate() !== d[2]) return false;
      }

      if (startParam) {
        if (ts < new Date(startParam)) return false;
      }
      if (endParam) {
        if (ts > new Date(endParam)) return false;
      }

      if (startTime || endTime) {
        const hourMin = ts.getHours() * 60 + ts.getMinutes();
        if (startTime) {
          const [sh, sm] = startTime.split(':').map(Number);
          const startMin = sh * 60 + sm;
          if (endTime) {
            const [eh, em] = endTime.split(':').map(Number);
            const endMin = eh * 60 + em;
            if (endMin < startMin) {
              if (hourMin < startMin && hourMin > endMin) return false;
            } else {
              if (hourMin < startMin || hourMin > endMin) return false;
            }
          } else {
            if (hourMin < startMin) return false;
          }
        } else if (endTime) {
          // Only endTime specified: filter items before endTime
          const [eh, em] = endTime.split(':').map(Number);
          const endMin = eh * 60 + em;
          if (hourMin > endMin) return false;
        }
      }
      return true;
    });
  }

  const statusMap = { pending: '待响应', responded: '处理中', completed: '已完成', closed: '已关闭' };
  const rows = data.map(t => ({
    '提交时间': t.submittedAt ? new Date(t.submittedAt).toLocaleString('zh-CN') : '-',
    '设备编号': t.machineNumber || t.machineId || '-',
    '故障设备': t.equipmentTypeName || t.equipmentType || '-',
    '故障现象': t.faultType || '-',
    '故障说明': t.faultDescription || '-',
    '提交人': t.submitterName || '-',
    '维修状态': statusMap[t.status] || t.status || '-',
    '维修人员': t.responderName || '-',
    '响应时间': t.respondedAt ? new Date(t.respondedAt).toLocaleString('zh-CN') : '-',
    '恢复时间': t.completedAt ? new Date(t.completedAt).toLocaleString('zh-CN') : '-',
    '等待时长': _fmtDuration(t.waitSeconds),
    '维修时长': _fmtDuration(t.repairSeconds),
    '总时长': _fmtDuration(t.totalSeconds),
    '处理结果': t.result || '-',
  }));

  const ws = XLSX.utils.json_to_sheet(rows);
  ws['!cols'] = [
    { wch: 22 }, { wch: 14 }, { wch: 16 }, { wch: 14 }, { wch: 22 },
    { wch: 12 }, { wch: 10 }, { wch: 12 }, { wch: 22 }, { wch: 22 },
    { wch: 14 }, { wch: 14 }, { wch: 12 }, { wch: 22 },
  ];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '维修日志');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

  const filename = encodeURIComponent('维修日志-' + new Date().toISOString().slice(0, 10));
  res.writeHead(200, {
    'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'Content-Disposition': `attachment; filename*=UTF-8''${filename}.xlsx`,
    'Access-Control-Allow-Origin': '*',
  });
  res.end(buf);
}

// -- Clear All Data --
async function handleClearAllData(req, res, user) {
  if (user.role !== 'admin' && user.role !== 'superadmin') return sendJSON(res, { error: '仅管理员可执行此操作' }, 403);
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const tables = ['inventory', 'machines', 'transactions', 'audit_log',
      'ops_orders', 'ops_customers', 'ops_production', 'sn_registry', 'tech_support',
      'equipment_config', 'inventory_config', 'settings', 'group_transfers', 'popup_messages'];
    for (const t of tables) await conn.execute('DELETE FROM ' + t);
    await conn.commit();
    // Clean uploaded photo files
    try {
      if (fs.existsSync(UPLOADS_DIR)) {
        fs.readdirSync(UPLOADS_DIR).forEach(f => { try { fs.unlinkSync(path.join(UPLOADS_DIR, f)); } catch {} });
      }
    } catch {}
    const events = ['inventory', 'machines', 'transactions', 'audit_log', 'ops_orders', 'ops_customers', 'ops_production', 'sn_registry', 'tech_support', 'equipment_config', 'inventory_config', 'group_transfers'];
    events.forEach(e => broadcastSSE(e + '_updated', {}));
    sendJSON(res, { success: true });
  } catch (e) {
    await conn.rollback();
    sendJSON(res, { error: '清除失败: ' + e.message }, 500);
  } finally {
    conn.release();
  }
}

// -- Full Export (ZIP) --
async function handleExportFull(req, res, user) {
  if (user.role !== 'admin' && user.role !== 'superadmin') return sendJSON(res, { error: '仅管理员可执行此操作' }, 403);
  const AdmZip = require('adm-zip');
  const zip = new AdmZip();

  const [inv] = await pool.execute('SELECT * FROM inventory');
  const machines = await readJSONArray('machines', 50000);
  const transactions = await readJSONArray('transactions', 50000);
  const auditLog = await readJSONArray('audit_log', 50000);
  const settings = await readJSONObject('settings');
  const [snReg] = await pool.execute('SELECT * FROM sn_registry');
  const equipmentConfig = await readJSONArray('equipment_config', 500);
  const inventoryConfig = await readJSONArray('inventory_config', 500);
  const opsOrders = await readJSONArray('ops_orders', 50000);
  const opsCustomers = await readJSONArray('ops_customers', 50000);
  const opsProduction = await readJSONArray('ops_production', 50000);
  const [tsRows] = await pool.execute('SELECT data FROM tech_support');
  const techSupport = tsRows.map(r => JSON.parse(r.data));
  const [userRows] = await pool.execute('SELECT id, username, passwordHash, role, `system`, displayName, parentId, createdBy, createdAt, status FROM users');
  const [popupRows] = await pool.execute('SELECT * FROM popup_messages');

  const backup = {
    version: '4.0-mysql',
    exportedAt: new Date().toISOString(),
    inventory: inv.map(r => ({ type: r.inv_type, quantity: r.quantity, updatedAt: r.updatedAt, updatedBy: r.updatedBy })),
    machines, transactions, auditLog, settings,
    snRegistry: snReg.map(r => ({
      snCode: r.snCode, equipmentType: r.equipmentType, handType: r.handType,
      status: r.status, machineNumber: r.machineNumber, damageReason: r.damageReason,
      trackingNumber: r.trackingNumber, attachment: r.attachment, updatedAt: r.updatedAt,
      shippedAt: r.shippedAt, repairedAt: r.repairedAt
    })),
    equipmentConfig, inventoryConfig, opsOrders, opsCustomers, opsProduction, techSupport,
    users: userRows, popupMessages: popupRows,
  };
  zip.addFile('backup.json', Buffer.from(JSON.stringify(backup, null, 2), 'utf8'));

  try {
    if (fs.existsSync(UPLOADS_DIR)) {
      fs.readdirSync(UPLOADS_DIR).forEach(f => {
        const fp = path.join(UPLOADS_DIR, f);
        if (fs.statSync(fp).isFile()) zip.addLocalFile(fp, 'uploads');
      });
    }
  } catch (e) { console.error('[EXPORT] Failed to include uploads:', e.message); }

  const buf = zip.toBuffer();
  const filename = `gms-backup-${new Date().toISOString().slice(0, 10)}.zip`;
  res.writeHead(200, {
    'Content-Type': 'application/zip',
    'Content-Disposition': `attachment; filename="${filename}"`,
    'Content-Length': buf.length,
  });
  res.end(buf);
}

// -- Full Import (ZIP) --
async function handleImportFull(req, res, user, body) {
  if (user.role !== 'admin' && user.role !== 'superadmin') return sendJSON(res, { error: '仅管理员可执行此操作' }, 403);
  if (!body || !body.zipData) return sendJSON(res, { error: '缺少备份数据' }, 400);

  const AdmZip = require('adm-zip');
    const buf = Buffer.from(body.zipData, 'base64');
    const zip = new AdmZip(buf);
    const entries = zip.getEntries();

    const jsonEntry = entries.find(e => e.entryName === 'backup.json');
    if (!jsonEntry) return sendJSON(res, { error: '备份文件中未找到 backup.json' }, 400);
    const backup = JSON.parse(jsonEntry.getData().toString('utf8'));

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      // Phase 1: Delete all data in transaction
      const tables = ['inventory', 'machines', 'transactions', 'audit_log', 'sn_registry',
        'ops_orders', 'ops_customers', 'ops_production', 'tech_support',
        'settings', 'equipment_config', 'inventory_config', 'group_transfers', 'popup_messages'];
      for (const t of tables) await conn.execute('DELETE FROM ' + t);

      // Phase 2: Restore all data in same transaction
      // Restore inventory
      if (Array.isArray(backup.inventory)) {
        for (const r of backup.inventory) {
          await conn.execute('REPLACE INTO inventory (inv_type, quantity, updatedAt, updatedBy) VALUES (?, ?, ?, ?)',
            [r.type, r.quantity, r.updatedAt, r.updatedBy]);
        }
      }

      // Restore JSON blob tables
      const jsonTables = {
        machines: 'machines', transactions: 'transactions', auditLog: 'audit_log',
        equipmentConfig: 'equipment_config', inventoryConfig: 'inventory_config',
        opsOrders: 'ops_orders', opsCustomers: 'ops_customers', opsProduction: 'ops_production',
        techSupport: 'tech_support',
      };
      for (const [jsonKey, table] of Object.entries(jsonTables)) {
        if (Array.isArray(backup[jsonKey])) {
          for (const item of backup[jsonKey]) {
            const id = item.id || item.snCode || item.type || ('_' + Math.random().toString(36).slice(2));
            await conn.execute(`REPLACE INTO ${table} (id, data) VALUES (?, ?)`, [id, JSON.stringify(item)]);
          }
        }
      }

      // Restore settings
      if (backup.settings && typeof backup.settings === 'object') {
        for (const [k, v] of Object.entries(backup.settings)) {
          await conn.execute('REPLACE INTO settings (skey, value) VALUES (?, ?)', [k, JSON.stringify(v)]);
        }
      }

      // Restore SN registry
      if (Array.isArray(backup.snRegistry)) {
        for (const r of backup.snRegistry) {
          await conn.execute(
            'REPLACE INTO sn_registry (snCode, equipmentType, handType, status, machineNumber, damageReason, trackingNumber, attachment, updatedAt, shippedAt, repairedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [r.snCode, r.equipmentType || null, r.handType || null, r.status || 'available',
              r.machineNumber || null, r.damageReason || null, r.trackingNumber || null,
              r.attachment || null, r.updatedAt || new Date().toISOString(),
              r.shippedAt || null, r.repairedAt || null]
          );
        }
      }

      // Restore users
      if (Array.isArray(backup.users)) {
        for (const u of backup.users) {
          await conn.execute(
            'REPLACE INTO users (id, username, passwordHash, role, `system`, displayName, parentId, createdBy, createdAt, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [u.id, u.username, u.passwordHash, u.role || 'user', u.system || 'maintenance', u.displayName || u.username, u.parentId || null, u.createdBy || null, u.createdAt || new Date().toISOString(), u.status || 'active']
          );
        }
      }
      // Restore popup messages
      if (Array.isArray(backup.popupMessages)) {
        for (const p of backup.popupMessages) {
          await conn.execute('REPLACE INTO popup_messages (id, category, text, createdBy, createdAt) VALUES (?, ?, ?, ?, ?)',
            [p.id, p.category, p.text, p.createdBy || 'system', p.createdAt || new Date().toISOString()]);
        }
      }

      await conn.commit();
    } catch (e) {
      await conn.rollback();
      console.error('[IMPORT] Failed:', e.message);
      return sendJSON(res, { error: '恢复失败: ' + e.message }, 500);
    } finally {
      conn.release();
    }

    // Clean uploads dir (outside transaction — file I/O)
    try {
      if (fs.existsSync(UPLOADS_DIR)) {
        fs.readdirSync(UPLOADS_DIR).forEach(f => { try { fs.unlinkSync(path.join(UPLOADS_DIR, f)); } catch {} });
      }
    } catch {}

    // Restore uploaded files
    entries.forEach(e => {
      if (e.entryName.startsWith('uploads/') && !e.isDirectory) {
        const fname = path.basename(e.entryName);
        if (fname) fs.writeFileSync(path.join(UPLOADS_DIR, fname), e.getData());
      }
    });

    const eventNames = ['inventory', 'machines', 'transactions', 'audit_log', 'sn_registry',
      'equipment_config', 'inventory_config', 'settings',
      'ops_orders', 'ops_customers', 'ops_production', 'tech_support'];
    eventNames.forEach(t => broadcastSSE(t + '_updated', {}));

    sendJSON(res, { success: true, message: '数据恢复成功' });
}

// Helper: Map SN equipmentType + handType to inventory type key
function _snToInvType(equipmentType, handType) {
  if (equipmentType === 'glove') {
    if (handType === 'left') return 'left_glove';
    if (handType === 'right') return 'right_glove';
    return 'right_glove'; // default when handType is missing/invalid for gloves
  }
  if (equipmentType === 'dexterous_hand') {
    if (handType === 'left') return 'left_dexterous_hand';
    if (handType === 'right') return 'right_dexterous_hand';
    return 'right_dexterous_hand'; // default when handType is missing/invalid
  }
  if (handType === 'left' || handType === 'right') return equipmentType + '_' + handType;
  return equipmentType || 'left_glove';
}

// ==================== SN REGISTRY ====================
async function handleGetSNRegistry(req, res, authUser) {
  // Auth required
  if (!authUser) return sendJSON(res, { error: '未登录' }, 401);
  const rows = await _cached('sn_registry', async () => {
    const [r] = await pool.execute('SELECT * FROM sn_registry ORDER BY updatedAt DESC LIMIT 5000');
    return r;
  });
  sendJSON(res, rows);
}

async function handleUpsertSNRegistry(req, res, authUser, body) {
  // 普通用户可标记损坏/调用，但不能改其他字段（equipmentType/handType等由管理员设置）
  const { snCode, equipmentType, handType, status, machineNumber, damageReason, trackingNumber, attachment, shippedAt, repairedAt } = body;
  if (!snCode) return sendJSON(res, { error: 'SN码不能为空' }, 400);
  const now = new Date().toISOString();
  const [existing] = await pool.execute('SELECT * FROM sn_registry WHERE snCode = ?', [snCode]);
  if (existing.length > 0) {
    // 普通用户只能更新 status / machineNumber / damageReason，其他字段保持原值
    const isAdmin = authUser.role === 'admin' || authUser.role === 'superadmin';
    const fields = ['equipmentType', 'handType', 'status', 'machineNumber', 'trackingNumber', 'damageReason', 'shippedAt', 'repairedAt', 'attachment'];
    const vals = {};
    fields.forEach(f => {
      if (f === 'equipmentType' || f === 'handType' || f === 'attachment') {
        // 这些字段只有管理员可修改
        vals[f] = (isAdmin && body[f] !== undefined) ? body[f] : existing[0][f];
      } else {
        vals[f] = body[f] !== undefined ? body[f] : existing[0][f];
      }
    });
    vals.updatedAt = now;
    await pool.execute(
      'UPDATE sn_registry SET equipmentType=?, handType=?, status=?, machineNumber=?, trackingNumber=?, damageReason=?, shippedAt=?, repairedAt=?, attachment=?, updatedAt=? WHERE snCode=?',
      [vals.equipmentType, vals.handType, vals.status, vals.machineNumber, vals.trackingNumber, vals.damageReason, vals.shippedAt, vals.repairedAt, vals.attachment, vals.updatedAt, snCode]
    );
  } else {
    await pool.execute(
      'INSERT INTO sn_registry (snCode,equipmentType,handType,status,machineNumber,trackingNumber,damageReason,shippedAt,repairedAt,attachment,updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      [snCode, equipmentType || '', handType || '', status || 'available', machineNumber || '', trackingNumber || '', damageReason || '', shippedAt || '', repairedAt || '', attachment || '', now]
    );
  }
  broadcastSSE('sn_registry_updated', {});
  sendJSON(res, { success: true });
}

async function handleShipSN(req, res, authUser, body) {
  const { snCode, trackingNumber } = body;
  if (!snCode || !trackingNumber) return sendJSON(res, { error: '缺少SN码或快递单号' }, 400);
  const [existing] = await pool.execute('SELECT status FROM sn_registry WHERE snCode = ?', [snCode]);
  if (existing.length === 0) return sendJSON(res, { error: 'SN码不存在' }, 404);
  if (existing[0].status !== 'damaged') return sendJSON(res, { error: `当前状态 "${existing[0].status}" 不支持发货，仅有"损坏"状态的SN码可以发货返厂` }, 400);
  const now = new Date().toISOString();
  await pool.execute(
    'UPDATE sn_registry SET status=?, trackingNumber=?, shippedAt=?, updatedAt=? WHERE snCode=?',
    ['in_repair', trackingNumber, now, now, snCode]
  );
  broadcastSSE('sn_registry_updated', {});
  sendJSON(res, { success: true });
}

async function handleRepairCompleteSN(req, res, authUser, body) {
  const { snCode } = body;
  if (!snCode) return sendJSON(res, { error: '缺少SN码' }, 400);
  const now = new Date().toISOString();
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [existing] = await conn.execute('SELECT * FROM sn_registry WHERE snCode = ? FOR UPDATE', [snCode]);
    if (existing.length > 0 && (existing[0].status === 'damaged' || existing[0].status === 'in_repair')) {
      const invType = _snToInvType(existing[0].equipmentType, existing[0].handType);
      const [rows] = await conn.execute('SELECT quantity FROM inventory WHERE inv_type = ? FOR UPDATE', [invType]);
      const currentQty = rows.length > 0 ? rows[0].quantity : 0;
      await conn.execute(
        'REPLACE INTO inventory (inv_type, quantity, updatedAt, updatedBy) VALUES (?, ?, ?, ?)',
        [invType, currentQty + 1, now, '系统']
      );
      await conn.execute(
        'UPDATE sn_registry SET status=?, repairedAt=?, updatedAt=? WHERE snCode=?',
        ['available', now, now, snCode]
      );
      await conn.commit();
      broadcastSSE('inventory_updated', { type: invType, quantity: currentQty + 1, updatedBy: '系统' });
      broadcastSSE('sn_registry_updated', {});
      sendJSON(res, { success: true });
    } else {
      await conn.rollback();
      sendJSON(res, { error: '该SN码状态不支持维修完成操作' }, 400);
    }
  } catch (e) {
    await conn.rollback();
    sendJSON(res, { error: e.message }, 500);
  } finally {
    conn.release();
  }
}

async function handleDeleteSNFull(req, res, authUser, body) {
  if (authUser.role !== 'admin' && authUser.role !== 'superadmin') return sendJSON(res, { error: '仅管理员可执行此操作' }, 403);
  const { snCode } = body;
  if (!snCode) return sendJSON(res, { error: '缺少snCode' }, 400);
  const now = new Date().toISOString();
  const user = authUser.username;

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [existing] = await conn.execute('SELECT * FROM sn_registry WHERE snCode = ? FOR UPDATE', [snCode]);
    if (existing.length === 0) { await conn.rollback(); return sendJSON(res, { success: false, message: 'SN码不存在' }, 404); }

    if (existing[0].status === 'available') {
      const invType = _snToInvType(existing[0].equipmentType, existing[0].handType);
      const [rows] = await conn.execute('SELECT quantity FROM inventory WHERE inv_type = ? FOR UPDATE', [invType]);
      const cur = rows.length > 0 ? rows[0].quantity : 0;
      await conn.execute('REPLACE INTO inventory (inv_type, quantity, updatedAt, updatedBy) VALUES (?, ?, ?, ?)',
        [invType, Math.max(0, cur - 1), now, user]);
    }

    await conn.execute('DELETE FROM sn_registry WHERE snCode = ?', [snCode]);

    const txId = 'tx-del-' + Date.now().toString(36);
    await conn.execute('INSERT INTO transactions (id, data) VALUES (?, ?)', [txId, JSON.stringify({
      id: txId, equipmentType: existing[0].equipmentType || '', handType: existing[0].handType || '',
      direction: 'out', quantity: 1, snCode: snCode, updatedBy: user,
      note: 'SN码删除', timestamp: now,
    })]);

    await conn.commit();
    broadcastSSE('sn_registry_updated', {});
    broadcastSSE('inventory_updated', {});
    broadcastSSE('transactions_updated', {});
    sendJSON(res, { success: true });
  } catch (e) {
    await conn.rollback();
    sendJSON(res, { error: e.message }, 500);
  } finally {
    conn.release();
  }
}

async function handleDeleteSNRegistry(req, res, snCode) {
  const now = new Date().toISOString();
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [existing] = await conn.execute('SELECT * FROM sn_registry WHERE snCode = ? FOR UPDATE', [snCode]);
    if (existing.length > 0 && existing[0].status === 'available') {
      const invType = _snToInvType(existing[0].equipmentType, existing[0].handType);
      const [rows] = await conn.execute('SELECT quantity FROM inventory WHERE inv_type = ? FOR UPDATE', [invType]);
      const currentQty = rows.length > 0 ? rows[0].quantity : 0;
      const newQty = Math.max(0, currentQty - 1);
      await conn.execute('REPLACE INTO inventory (inv_type, quantity, updatedAt, updatedBy) VALUES (?, ?, ?, ?)',
        [invType, newQty, now, '系统']);
      broadcastSSE('inventory_updated', { type: invType, quantity: newQty, updatedBy: '系统' });
    }
    await conn.execute('DELETE FROM sn_registry WHERE snCode = ?', [snCode]);
    await conn.commit();
    broadcastSSE('sn_registry_updated', {});
    sendJSON(res, { success: true });
  } catch (e) {
    await conn.rollback();
    sendJSON(res, { error: e.message }, 500);
  } finally {
    conn.release();
  }
}

// -- File Upload / Delete --
function handleUpload(req, res, body) {
  const { filename, data } = body;
  if (!data || !filename) return sendJSON(res, { error: '缺少文件数据' }, 400);
  const matches = data.match(/^data:([^;]+);base64,(.+)$/);
  if (!matches) return sendJSON(res, { error: '无效的数据格式' }, 400);
  const mimeType = matches[1];
  const base64Data = matches[2];
  const ALLOWED_MIME_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml'];
  if (!ALLOWED_MIME_TYPES.includes(mimeType)) {
    return sendJSON(res, { error: '只支持上传图片文件 (jpg, png, gif, webp, svg)' }, 400);
  }
  const decodedBuf = Buffer.from(base64Data, 'base64');
  if (decodedBuf.length > 10 * 1024 * 1024) return sendJSON(res, { error: '文件大小超过限制(最大10MB)' }, 413);
  const safeFilename = filename.replace(/[\/\\]/g, '_').replace(/[^\w\.\-]/g, '');
  const ext = path.extname(safeFilename) || '.jpg';
  const randomName = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8) + ext;
  if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  const filePath = path.join(UPLOADS_DIR, randomName);
  fs.writeFileSync(filePath, decodedBuf);
  sendJSON(res, { path: '/uploads/' + randomName, filename: safeFilename });
}

function handleDeleteUpload(req, res, body) {
  const { filePath } = body;
  if (!filePath || !filePath.startsWith('/uploads/')) return sendJSON(res, { error: '无效的文件路径' }, 400);
  const fullPath = path.join(__dirname, filePath);
  if (!fullPath.startsWith(UPLOADS_DIR)) return sendJSON(res, { error: '路径越界' }, 403);
  try {
    if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
    sendJSON(res, { success: true });
  } catch (e) { sendJSON(res, { error: '删除失败' }, 500); }
}

// -- Sync endpoint (polling fallback) --
async function handleSync(req, res, authUser) {
  // Auth required for sync endpoint
  if (!authUser) return sendJSON(res, { error: '未登录' }, 401);
  const cachedData = await _cached('sync', async () => {
    // Parallel queries for speed
    const [inventory, snRegistry, tsRows, machines, transactions,
      settings, equipmentConfig, inventoryConfig,
      opsOrders, opsCustomers, opsProduction] = await Promise.all([
    pool.execute('SELECT * FROM inventory'),
    pool.execute('SELECT * FROM sn_registry ORDER BY updatedAt DESC LIMIT 2000'),
    pool.execute('SELECT data FROM tech_support ORDER BY id DESC LIMIT 100'),
    pool.execute('SELECT data FROM machines ORDER BY id DESC LIMIT 500'),
    pool.execute('SELECT data FROM transactions ORDER BY id DESC LIMIT 200'),
    pool.execute('SELECT skey, value FROM settings'),
    pool.execute('SELECT data FROM equipment_config ORDER BY id DESC'),
    pool.execute('SELECT data FROM inventory_config ORDER BY id DESC'),
    pool.execute('SELECT data FROM ops_orders ORDER BY id DESC'),
    pool.execute('SELECT data FROM ops_customers ORDER BY id DESC'),
    pool.execute('SELECT data FROM ops_production ORDER BY id DESC'),
  ]);

  return {
    inventory: inventory[0].map(r => ({ type: r.inv_type, quantity: r.quantity, updatedAt: r.updatedAt, updatedBy: r.updatedBy })),
    machines: machines[0].map(r => JSON.parse(r.data)),
    transactions: transactions[0].map(r => JSON.parse(r.data)).reverse(),
    snRegistry: snRegistry[0],
    settings: (() => { const obj = {}; settings[0].forEach(r => { try { obj[r.skey] = JSON.parse(r.value); } catch { obj[r.skey] = r.value; } }); return obj; })(),
    equipmentConfig: equipmentConfig[0].map(r => JSON.parse(r.data)),
    inventoryConfig: inventoryConfig[0].map(r => JSON.parse(r.data)),
    opsOrders: opsOrders[0].map(r => JSON.parse(r.data)),
    opsCustomers: opsCustomers[0].map(r => JSON.parse(r.data)),
    opsProduction: opsProduction[0].map(r => JSON.parse(r.data)),
    techSupport: tsRows[0].map(r => JSON.parse(r.data)),
  };
  });
  sendJSON(res, cachedData, 200, req);
}

// ==================== SERVER ====================
const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
      });
      return res.end();
    }

    // Favicon — return SVG icon to avoid 404 in browser console
    if (req.url === '/favicon.ico' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=86400' });
      return res.end('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y="80" font-size="80">🧤</text></svg>');
    }

    if (req.url === '/api/health' && req.method === 'GET') {
      const dbInfo = getPoolInfo();
      return sendJSON(res, {
        status: dbInfo.connected ? 'ok' : 'degraded',
        uptime: process.uptime(),
        timestamp: Date.now(),
        database: dbInfo,
        memory: {
          rss: process.memoryUsage().rss,
          heapUsed: process.memoryUsage().heapUsed,
          heapTotal: process.memoryUsage().heapTotal,
        },
      });
    }

    if (req.url === '/api/status' && req.method === 'GET') {
      // 异步获取在线用户数（从Redis或内存）
      getOnlineUserIds().then(onlineIds => {
        const count = onlineIds.size;
        // Load level: idle(0) / smooth(1-99) / busy(100-199) / full(200+)
        let level = 'idle', label = '空闲';
        if (count >= 200) { level = 'full'; label = '爆满'; }
        else if (count >= 100) { level = 'busy'; label = '拥挤'; }
        else if (count >= 1) { level = 'smooth'; label = '畅通'; }
        sendJSON(res, {
          status: 'ok',
          onlineUsers: count,
          loadLevel: level,
          loadLabel: label,
          version: '3.9.0',
          // ========== 分布式信息 ==========
          serverRole: SERVER_ROLE,
          serverId: SERVER_ID,
          dbConnected: !!pool,
          readPoolConnected: !!readPool,
        });
      }).catch(e => {
        // 降级：使用内存统计
        const onlineIds = new Set();
        Object.values(tokens).forEach(t => { if (t.expires > Date.now()) onlineIds.add(t.userId); });
        sendJSON(res, {
          status: 'ok',
          onlineUsers: onlineIds.size,
          loadLevel: 'idle',
          loadLabel: '空闲',
          version: '3.9.0',
          // ========== 分布式信息 ==========
          serverRole: SERVER_ROLE,
          serverId: SERVER_ID,
          dbConnected: !!pool,
          readPoolConnected: !!readPool,
        });
      });
      return;
    }

    // ========== SSH 执行接口（仅超级管理员） ==========
    if (req.url === '/api/ssh-exec' && req.method === 'POST') {
      const bodyData = await parseBody(req);
      const { ip, user, command, password, timeout } = bodyData;

      // 验证超级管理员权限
      const userData = await requireAuth(req, res);
      if (!userData) return;

      // 检查用户是否为管理员
      if (userData.role !== 'admin' && userData.role !== 'superadmin') {
        sendJSON(res, { error: 'Admin only' }, 403);
        return;
      }

      // 验证参数
      if (!ip || !command) {
        sendJSON(res, { error: 'Missing ip or command' }, 400);
        return;
      }

      // 自定义超时（默认60秒，最大300秒）
      const execTimeout = Math.min(parseInt(timeout) || 60000, 300000);

      // 如果是localhost，直接执行本地命令
      if (ip === 'localhost' || ip === '127.0.0.1' || ip === '::1') {
        try {
          const { exec } = require('child_process');
          const output = await new Promise((resolve, reject) => {
            exec(command, { timeout: execTimeout, maxBuffer: 5 * 1024 * 1024 }, (error, stdout, stderr) => {
              if (error && !stdout) reject(new Error(stderr || error.message));
              else resolve(stdout || stderr || '');
            });
          });
          sendJSON(res, { output, success: true });
        } catch (e) {
          sendJSON(res, { error: e.message, output: '', success: false }, 500);
        }
        return;
      }

      // 执行 SSH 命令（支持密码登录）
      try {
        const { exec } = require('child_process');
        const sshUser = user || 'root';
        let sshCmd;

        if (password) {
          // 确保sshpass已安装
          sshCmd = `which sshpass >/dev/null 2>&1 || (apt-get install -y sshpass >/dev/null 2>&1 || sudo apt-get install -y sshpass >/dev/null 2>&1); ` +
                   `sshpass -p '${password.replace(/'/g, "'\\''")}' ssh -o StrictHostKeyChecking=no -o ConnectTimeout=15 -o ServerAliveInterval=30 ${sshUser}@${ip} '${command.replace(/'/g, "'\\''")}'`;
        } else {
          sshCmd = `ssh -o StrictHostKeyChecking=no -o ConnectTimeout=15 -o ServerAliveInterval=30 ${sshUser}@${ip} '${command.replace(/'/g, "'\\''")}'`;
        }

        const output = await new Promise((resolve, reject) => {
          exec(sshCmd, { timeout: execTimeout, maxBuffer: 5 * 1024 * 1024 }, (error, stdout, stderr) => {
            if (error && !stdout) reject(new Error(stderr || error.message));
            else resolve(stdout || stderr || '');
          });
        });

        sendJSON(res, { output, success: true });
      } catch (e) {
        sendJSON(res, { error: e.message, output: '', success: false }, 500);
      }
      return;
    }

    // ========== 部署代码到远程服务器（打包传输） ==========
    if (req.url === '/api/deploy-code' && req.method === 'POST') {
      const bodyData = await parseBody(req);
      const { targetIP, sshUser, password } = bodyData;

      const userData = await requireAuth(req, res);
      if (!userData) return;
      if (userData.role !== 'admin' && userData.role !== 'superadmin') {
        sendJSON(res, { error: 'Admin only' }, 403);
        return;
      }
      if (!targetIP) { sendJSON(res, { error: 'Missing targetIP' }, 400); return; }

      const { exec } = require('child_process');
      const path = require('path');
      const fs = require('fs');

      // 获取当前项目根目录（server.js 所在目录）
      const projectRoot = __dirname;
      const tarFile = '/tmp/gms-deploy-' + Date.now() + '.tar.gz';
      const remoteUser = sshUser || 'we';

      try {
        // 步骤1: 打包代码（排除 node_modules / .git / 日志 / 上传文件）
        const excludeArgs = [
          '--exclude=node_modules',
          '--exclude=.git',
          '--exclude=*.log',
          '--exclude=uploads',
          '--exclude=.env',
          '--exclude=tmp',
          '--exclude=*.tar.gz'
        ].join(' ');

        const tarCmd = `tar czf ${tarFile} -C ${projectRoot} ${excludeArgs} . 2>&1`;
        const tarResult = await new Promise((resolve, reject) => {
          exec(tarCmd, { timeout: 30000 }, (error, stdout, stderr) => {
            if (error) reject(new Error(stderr || error.message));
            else resolve(stdout || stderr || 'OK');
          });
        });

        // 检查打包文件大小
        const stat = fs.statSync(tarFile);
        const sizeMB = (stat.size / 1024 / 1024).toFixed(2);

        // 步骤2: 确保 sshpass 已安装
        if (password) {
          await new Promise((resolve) => {
            exec('which sshpass >/dev/null 2>&1 || apt-get install -y sshpass >/dev/null 2>&1 || sudo apt-get install -y sshpass >/dev/null 2>&1', { timeout: 30000 }, () => resolve());
          });
        }

        // 步骤3: 在远程服务器创建目录
        const remoteDir = '~/glove-management';
        const sshBase = password
          ? `sshpass -p '${password.replace(/'/g, "'\\''")}'`
          : '';
        const sshOpts = `ssh -o StrictHostKeyChecking=no -o ConnectTimeout=15 -o ServerAliveInterval=30`;

        const mkdirCmd = `${sshBase} ${sshOpts} ${remoteUser}@${targetIP} 'mkdir -p ${remoteDir} && echo MKDIR_OK'`;
        const mkdirResult = await new Promise((resolve, reject) => {
          exec(mkdirCmd, { timeout: 20000 }, (error, stdout) => {
            if (error) reject(new Error(stderr || error.message));
            else resolve(stdout || '');
          });
        });

        // 步骤4: 用 scp 传输压缩包
        const scpCmd = `${sshBase} scp -o StrictHostKeyChecking=no -o ConnectTimeout=15 ${tarFile} ${remoteUser}@${targetIP}:/tmp/gms-deploy.tar.gz`;
        const scpResult = await new Promise((resolve, reject) => {
          exec(scpCmd, { timeout: 120000 }, (error, stdout, stderr) => {
            if (error) reject(new Error(stderr || error.message));
            else resolve(stdout || 'SCP OK');
          });
        });

        // 步骤5: 在远程服务器解压
        const extractCmd = `${sshBase} ${sshOpts} ${remoteUser}@${targetIP} 'cd ${remoteDir} && tar xzf /tmp/gms-deploy.tar.gz --overwrite && rm -f /tmp/gms-deploy.tar.gz && echo EXTRACT_OK'`;
        const extractResult = await new Promise((resolve, reject) => {
          exec(extractCmd, { timeout: 30000 }, (error, stdout, stderr) => {
            if (error) reject(new Error(stderr || error.message));
            else resolve(stdout || '');
          });
        });

        // 清理本地临时文件
        try { fs.unlinkSync(tarFile); } catch {}

        const extracted = (extractResult || '').includes('EXTRACT_OK');
        sendJSON(res, {
          success: true,
          output: `打包: ${sizeMB}MB\n传输: OK\n解压: ${extracted ? 'OK' : '可能失败'}`,
          packageSize: sizeMB + 'MB'
        });
      } catch (e) {
        // 清理临时文件
        try { fs.unlinkSync(tarFile); } catch {}
        sendJSON(res, { error: e.message, output: '', success: false }, 500);
      }
      return;
    }

    // ========== 检查远程服务器状态（代理） ==========
    if (req.url.startsWith('/api/proxy-status') && req.method === 'GET') {
      const urlParams = new URL(req.url, `http://${req.headers.host}`);
      const targetIP = urlParams.searchParams.get('ip');
      const targetPort = urlParams.searchParams.get('port') || 8765;

      if (!targetIP) {
        sendJSON(res, { error: 'Missing ip parameter' }, 400);
        return;
      }

      try {
        const statusRes = await fetch(`http://${targetIP}:${targetPort}/api/status`, { timeout: 5000 });
        if (statusRes.ok) {
          const data = await statusRes.json();
          sendJSON(res, data);
        } else {
          sendJSON(res, { online: false, error: `HTTP ${statusRes.status}` });
        }
      } catch (e) {
        sendJSON(res, { online: false, error: e.message });
      }
      return;
    }

    if (req.url === '/api/events' && req.method === 'GET') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      });
      res.write('event: connected\ndata: {"status":"ok"}\n\n');
      realtime.addSSEClient(res);
      req.on('close', () => realtime.removeSSEClient(res));
      return;
    }

    if (serveStatic(req, res)) return;

    const url = new URL(req.url, 'http://localhost');
    const body = (req.method === 'POST' || req.method === 'PUT') ? await parseBody(req) : {};

    // Public: login
    if (url.pathname === '/api/auth/login' && req.method === 'POST') return handleLogin(req, res, body);
    if (url.pathname === '/api/auth/verify' && req.method === 'POST') return handleTokenVerify(req, res, body);
    if (url.pathname === '/api/beacon-logout' && req.method === 'POST') return handleBeaconLogout(req, res, body);

    // Auth required for all other API routes
    const authUser = await requireAuth(req, res);
    if (!authUser) return;

    // Inventory
    if (url.pathname === '/api/inventory' && req.method === 'GET') return handleGetAllInventory(req, res, authUser);
    // Transfer routes BEFORE generic :type match
    if (url.pathname === '/api/inventory/transfer' && req.method === 'POST') return handleTransferInventory(req, res, authUser, body);
    if (url.pathname === '/api/inventory/transfer-stats' && req.method === 'GET') return handleGetTransferStats(req, res);
    const invMatch = url.pathname.match(/^\/api\/inventory\/(.+)$/);
    if (invMatch && req.method === 'GET') return handleGetInventory(req, res, authUser, invMatch[1]);
    if (invMatch && req.method === 'POST') return handleAdjustInventory(req, res, authUser, invMatch[1], body);

    // Machines
    if (url.pathname === '/api/machines' && req.method === 'GET') return handleGetMachines(req, res, authUser);
    if (url.pathname === '/api/machines' && req.method === 'POST') return handleAddMachine(req, res, authUser, body);
    const delM = url.pathname.match(/^\/api\/machines\/(.+)$/);
    if (delM && req.method === 'DELETE') return handleDeleteMachine(req, res, authUser, delM[1]);

    // Transactions
    if (url.pathname === '/api/transactions' && req.method === 'GET') return handleGetTransactions(req, res, authUser);
    if (url.pathname === '/api/transactions' && req.method === 'POST') return handleAddTransaction(req, res, authUser, body);
    const delTx = url.pathname.match(/^\/api\/transactions\/(.+)$/);
    if (delTx && req.method === 'DELETE') return handleDeleteTransaction(req, res, authUser, delTx[1]);

    // Audit Log
    if (url.pathname === '/api/audit-log' && req.method === 'GET') return handleGetAuditLog(req, res, authUser);

    // Settings
    if (url.pathname === '/api/settings' && req.method === 'GET') return handleGetSettings(req, res, authUser);
    if (url.pathname === '/api/settings' && req.method === 'POST') return handleSaveSettings(req, res, authUser, body);

    // Users
    if (url.pathname === '/api/users' && req.method === 'GET') return handleGetUsers(req, res, authUser);
    if (url.pathname === '/api/users' && req.method === 'POST') return handleAddUser(req, res, authUser, body);
    const updateUserMatch = url.pathname.match(/^\/api\/users\/([^/]+)$/);
    if (updateUserMatch && req.method === 'PUT') return handleUpdateUser(req, res, authUser, updateUserMatch[1], body);
    const delU = updateUserMatch;
    if (delU && req.method === 'DELETE') return handleDeleteUser(req, res, authUser, delU[1]);

    // Online users & logout
    if (url.pathname === '/api/online-users' && req.method === 'GET') return handleGetOnlineUsers(req, res, authUser);
    if (url.pathname === '/api/logout' && req.method === 'POST') return handleLogout(req, res, authUser);
    const forceLogoutMatch = url.pathname.match(/^\/api\/force-logout\/(.+)$/);
    if (forceLogoutMatch && req.method === 'POST') return handleForceLogout(req, res, authUser, forceLogoutMatch[1]);

    // Tech Support
    if (url.pathname === '/api/tech-support' && req.method === 'GET') return handleGetTechSupportList(req, res, authUser);
    if (url.pathname === '/api/tech-support' && req.method === 'POST') return handleSubmitTechSupport(req, res, authUser, body);
    if (url.pathname === '/api/tech-support/repair-results' && req.method === 'GET') return handleGetRepairResults(req, res);
    // 共享记忆 API
    const memGetMatch = url.pathname.match(/^\/api\/tech-support\/memory\/([^/]+)$/);
    if (memGetMatch && req.method === 'GET') return handleGetMemoryList(req, res, authUser, memGetMatch[1]);
    const memAddMatch = url.pathname.match(/^\/api\/tech-support\/memory\/([^/]+)$/);
    if (memAddMatch && req.method === 'POST') return handleAddMemory(req, res, authUser, memAddMatch[1], body);
    const tsDetailMatch = url.pathname.match(/^\/api\/tech-support\/([^/]+)$/);
    if (tsDetailMatch && req.method === 'GET') return handleGetTechSupportDetail(req, res, authUser, tsDetailMatch[1]);
    const tsRespondMatch = url.pathname.match(/^\/api\/tech-support\/([^/]+)\/respond$/);
    if (tsRespondMatch && req.method === 'POST') return handleRespondTechSupport(req, res, authUser, tsRespondMatch[1]);
    const tsCompleteMatch = url.pathname.match(/^\/api\/tech-support\/([^/]+)\/complete$/);
    if (tsCompleteMatch && req.method === 'POST') return handleCompleteTechSupport(req, res, authUser, tsCompleteMatch[1], body);
    const tsDeleteMatch = url.pathname.match(/^\/api\/tech-support\/([^/]+)$/);
    if (tsDeleteMatch && req.method === 'DELETE') return handleDeleteTechSupport(req, res, authUser, tsDeleteMatch[1]);

    // Popup Messages
    if (url.pathname === '/api/popup-messages' && req.method === 'GET') return handleGetPopupMessages(req, res, authUser);
    if (url.pathname === '/api/popup-messages/random' && req.method === 'GET') return handleGetRandomPopupMessage(req, res);
    if (url.pathname === '/api/popup-messages' && req.method === 'POST') return handleAddPopupMessage(req, res, authUser, body);
    const delPmMatch = url.pathname.match(/^\/api\/popup-messages\/([^/]+)$/);
    if (delPmMatch && req.method === 'DELETE') return handleDeletePopupMessage(req, res, authUser, delPmMatch[1]);

    // Group Transfers
    if (url.pathname === '/api/group/transfers' && req.method === 'GET') return handleGetGroupTransfers(req, res, authUser);
    if (url.pathname === '/api/group/members' && req.method === 'GET') return handleGetGroupMembers(req, res, authUser);
    if (url.pathname === '/api/group/transfer' && req.method === 'POST') return handleCreateGroupTransfer(req, res, authUser, body);
    const gtApproveMatch = url.pathname.match(/^\/api\/group\/transfer\/([^/]+)\/approve$/);
    if (gtApproveMatch && req.method === 'POST') return handleApproveGroupTransfer(req, res, authUser, gtApproveMatch[1]);
    const gtRejectMatch = url.pathname.match(/^\/api\/group\/transfer\/([^/]+)\/reject$/);
    if (gtRejectMatch && req.method === 'POST') return handleRejectGroupTransfer(req, res, authUser, gtRejectMatch[1]);
    const gtCancelMatch = url.pathname.match(/^\/api\/group\/transfer\/([^/]+)\/cancel$/);
    if (gtCancelMatch && req.method === 'POST') return handleCancelGroupTransfer(req, res, authUser, gtCancelMatch[1]);

    // Subordinates
    if (url.pathname === '/api/users/subordinates' && req.method === 'GET') return handleGetSubordinates(req, res, authUser);

    // User repair stats
    const userStatsMatch = url.pathname.match(/^\/api\/users\/([^/]+)\/repair-stats$/);
    if (userStatsMatch && req.method === 'GET') return handleGetUserRepairStats(req, res, authUser, userStatsMatch[1]);

    // Task Progress (运营系统 - 组长提交进度)
    if (url.pathname === '/api/task-progress' && req.method === 'POST') return handleSubmitTaskProgress(req, res, authUser, body);
    if (url.pathname === '/api/task-progress' && req.method === 'GET') return handleGetTaskProgress(req, res, authUser);

    // Promote/demote user
    const promoteMatch = url.pathname.match(/^\/api\/users\/([^/]+)\/promote$/);
    if (promoteMatch && req.method === 'POST') return handlePromoteUser(req, res, authUser, promoteMatch[1]);
    const toggleStatusMatch = url.pathname.match(/^\/api\/users\/([^/]+)\/toggle-status$/);
    if (toggleStatusMatch && req.method === 'POST') return handleToggleUserStatus(req, res, authUser, toggleStatusMatch[1]);

    // Reset user password (admin/superadmin action)
    const resetPwdMatch = url.pathname.match(/^\/api\/users\/([^/]+)\/reset-password$/);
    if (resetPwdMatch && req.method === 'POST') return handleResetPassword(req, res, authUser, resetPwdMatch[1], body);

    // View user password (admin/superadmin can view group members' passwords)
    const viewPwdMatch = url.pathname.match(/^\/api\/users\/([^/]+)\/password$/);
    if (viewPwdMatch && req.method === 'GET') return handleGetUserPassword(req, res, authUser, viewPwdMatch[1]);

    // Change own password
    if (url.pathname === '/api/change-password' && req.method === 'POST') return handleChangePassword(req, res, authUser, body);

    // Equipment Config
    if (url.pathname === '/api/equipment-config' && req.method === 'GET') return handleGetEquipmentConfig(req, res, authUser);
    if (url.pathname === '/api/equipment-config' && req.method === 'POST') return handleSaveEquipmentConfig(req, res, authUser, body);
    const delEq = url.pathname.match(/^\/api\/equipment-config\/(.+)$/);
    if (delEq && req.method === 'DELETE') return handleDeleteEquipmentConfig(req, res, authUser, delEq[1]);

    // Inventory Config
    if (url.pathname === '/api/inventory-config' && req.method === 'GET') return handleGetInventoryConfig(req, res, authUser);
    if (url.pathname === '/api/inventory-config' && req.method === 'POST') return handleSaveInventoryConfig(req, res, authUser, body);
    const delInv = url.pathname.match(/^\/api\/inventory-config\/(.+)$/);
    if (delInv && req.method === 'DELETE') return handleDeleteInventoryConfig(req, res, authUser, delInv[1]);

    // Data integrity
    if (url.pathname === '/api/data-integrity' && req.method === 'GET') return handleDataIntegrity(req, res);

    // Sync (polling fallback)
    if (url.pathname === '/api/sync' && req.method === 'GET') return handleSync(req, res, authUser);

    // SN Registry
    if (url.pathname === '/api/sn-registry' && req.method === 'GET') return handleGetSNRegistry(req, res, authUser);
    if (url.pathname === '/api/sn-registry' && req.method === 'POST') return handleUpsertSNRegistry(req, res, authUser, body);
    if (url.pathname === '/api/sn-registry/delete-full' && req.method === 'POST') return handleDeleteSNFull(req, res, authUser, body);
    if (url.pathname === '/api/sn-registry/ship' && req.method === 'POST') return handleShipSN(req, res, authUser, body);
    if (url.pathname === '/api/sn-registry/repair-complete' && req.method === 'POST') return handleRepairCompleteSN(req, res, authUser, body);
    const delSN = url.pathname.match(/^\/api\/sn-registry\/(.+)$/);
    if (delSN && req.method === 'DELETE') {
      if (authUser.role !== 'admin' && authUser.role !== 'superadmin') return sendJSON(res, { error: '仅管理员可执行此操作' }, 403);
      return handleDeleteSNRegistry(req, res, url.pathname.split('/').pop());
    }

    // Operations
    if (url.pathname === '/api/ops-orders' && req.method === 'GET') return handleGetOps(req, res, 'ops_orders');
    if (url.pathname === '/api/ops-orders' && req.method === 'POST') return handleSaveOps(req, res, 'ops_orders', body);
    if (url.pathname === '/api/ops-customers' && req.method === 'GET') return handleGetOps(req, res, 'ops_customers');
    if (url.pathname === '/api/ops-customers' && req.method === 'POST') return handleSaveOps(req, res, 'ops_customers', body);
    if (url.pathname === '/api/ops-production' && req.method === 'GET') return handleGetOps(req, res, 'ops_production');
    if (url.pathname === '/api/ops-production' && req.method === 'POST') return handleSaveOps(req, res, 'ops_production', body);

    // Last backup
    if (url.pathname === '/api/last-backup' && req.method === 'GET') return handleLastBackup(req, res);

    // Excel export
    if (url.pathname === '/api/export/xlsx' && req.method === 'GET') return handleExportXLSX(req, res, authUser);
    if (url.pathname === '/api/export/tech-support-xlsx' && req.method === 'GET') return handleExportTechSupportXLSX(req, res, authUser);

    // Full export (ZIP with images)
    if (url.pathname === '/api/export/full' && req.method === 'GET') return handleExportFull(req, res, authUser);

    // Full import (ZIP with images)
    if (url.pathname === '/api/import/full' && req.method === 'POST') return handleImportFull(req, res, authUser, body);

    // Clear all data (admin only)
    if (url.pathname === '/api/clear-all-data' && req.method === 'POST') return handleClearAllData(req, res, authUser);

    // File upload / delete
    if (url.pathname === '/api/upload' && req.method === 'POST') return handleUpload(req, res, body);
    if (url.pathname === '/api/delete-upload' && req.method === 'POST') return handleDeleteUpload(req, res, body);

    sendJSON(res, { error: 'Not found' }, 404);
  } catch (e) {
    console.error('[REQUEST ERROR]', req.url, e.message);
    try { sendJSON(res, { error: '服务器内部错误' }, 500); } catch {}
  }
});

// ==================== STARTUP ====================
async function startup() {
  try {
    // Init Redis first (non-fatal if unavailable)
    await initRedis();

    await initPool();
    await initDB();
    await migrateDB();
    await migrateFromJSON();
    await seedDefaults();
    console.log('[DB] Database initialized successfully');

    // Init realtime engine (WebSocket + SSE 双通道)
    realtime.init(server, { isConnected: () => redisClient && redisClient.isReady, subscribe: async (ch, fn) => { if (redisSub) await redisSub.subscribe(ch, fn); }, SSE_CHANNEL: 'sse:all' });

    // Feishu sync initialized lazily on first tech_support operation
  } catch (e) {
    console.error('[FATAL] Database initialization failed:', e.message);
    process.exit(1);
  }

  server.listen(PORT, '0.0.0.0', () => {
    const nets = os.networkInterfaces();
    const workerId = process.env.pm_id || 'standalone';
    console.log(`\n🧤 手套管理系统服务器已启动 [Worker ${workerId}] (MySQL+Redis/Cluster)`);
    console.log(`   本地访问: http://localhost:${PORT}`);
    for (const [, addrs] of Object.entries(nets)) {
      for (const addr of addrs) {
        if (addr.family === 'IPv4' && !addr.internal) console.log(`   局域网访问: http://${addr.address}:${PORT}`);
      }
    }
    console.log(`   数据库: MySQL ${DB_HOST}:${DB_PORT}/${DB_NAME}`);
    console.log('');
  });
}

// ==================== CRASH PREVENTION ====================
process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught exception:', err.message);
  try { fs.appendFileSync(path.join(DATA_DIR, 'crash.log'), `${new Date().toISOString()} ${err.message}\n${err.stack}\n\n`); } catch {}
  gracefulShutdown('uncaughtException');
});
process.on('unhandledRejection', (reason) => {
  console.error('[ERROR] Unhandled rejection (non-fatal):', reason?.message || reason);
  // Do NOT crash — unhandled rejections are often transient (e.g., pool connection reset)
  // Log it for debugging but keep the server running
});

let shuttingDown = false;
async function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[SHUTDOWN] Received ${signal}, shutting down gracefully...`);
  const allSSE = realtime.getSSEClients();
  allSSE.forEach(res => { try { res.end(); } catch {} });
  allSSE.clear();
  try { await pool.end(); console.log('[SHUTDOWN] MySQL pool closed.'); } catch {}
  try { if (redisClient) { await redisClient.quit(); console.log('[SHUTDOWN] Redis closed.'); } } catch {}
  process.exit(0);
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Server error handling
server.on('error', (err) => {
  console.error('[SERVER ERROR]', err.message);
  if (err.code === 'EADDRINUSE') { console.error('Port in use, retrying in 5s...'); setTimeout(() => process.exit(1), 5000); }
});

server.timeout = 5 * 60 * 1000;
server.keepAliveTimeout = 120 * 1000;
server.maxConnections = 500;

// ==================== PERIODIC MAINTENANCE ====================
// SSE cleanup every 15 min
setInterval(() => {
  let deadCount = 0;
  sseClients.forEach(res => { if (res.destroyed || res.writableEnded) { sseClients.delete(res); deadCount++; } });
  if (deadCount > 0) console.log(`[MAINT] Cleaned ${deadCount} dead SSE connections`);
}, 15 * 60 * 1000);

// Health log every 2 hours
setInterval(() => {
  const mem = process.memoryUsage();
  console.log(`[HEALTH] Memory: ${Math.round(mem.heapUsed / 1048576)}MB | SSE: ${sseClients.size} | Uptime: ${Math.round(process.uptime() / 3600)}h`);
}, 2 * 3600 * 1000);

// ==================== STATIC FILE CACHE ====================
const staticCache = new Map(); // path → { data, contentType, gzipped }

function getStaticFile(filePath, contentType, cacheKey) {
  const cached = staticCache.get(cacheKey);
  // Check file mtime to auto-invalidate cache when file is updated (e.g. git pull)
  try {
    const mtime = fs.statSync(filePath).mtimeMs;
    if (cached && cached.fileMtime === mtime && (Date.now() - cached.ts) < 3600000) return cached; // 1h cache, mtime-checked
  } catch { if (cached) staticCache.delete(cacheKey); return null; }
  try {
    const data = fs.readFileSync(filePath);
    const gzipped = zlib.gzipSync(data);
    const fileMtime = fs.statSync(filePath).mtimeMs;
    const entry = { data, gzipped, contentType, fileMtime, ts: Date.now() };
    staticCache.set(cacheKey, entry);
    return entry;
  } catch { return null; }
}

// Start the server (single process — SSE broadcasting requires shared memory)
startup();
