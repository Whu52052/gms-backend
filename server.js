/**
 * Glove Management System - Backend Server (Cluster + Redis Edition)
 * Storage: MySQL (mysql2) + Redis (session/cache/pubsub) + SSE for real-time sync
 * Performance: Node.js cluster (multi-core) + Redis Pub/Sub + gzip + memory cache
 * Target: 500 concurrent users
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const cluster = require('cluster');
const os = require('os');

// ==================== FEISHU SYNC ====================
const feishu = require('./feishu');

// ==================== REDIS CLIENT ====================
const redis = require('redis');
const REDIS_URL = process.env.REDIS_URL || `redis://${process.env.REDIS_HOST || 'localhost'}:${process.env.REDIS_PORT || '6379'}`;
let redisClient, redisSub, redisPub;

async function initRedis() {
  try {
    redisClient = redis.createClient({ url: REDIS_URL });
    redisSub = redisClient.duplicate();
    redisPub = redisClient.duplicate();
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
const DB_HOST = process.env.DB_HOST || process.env.MYSQL_HOST || 'sh-cynosdbmysql-grp-pbo2ohcm.sql.tencentcdb.com';
const DB_PORT = parseInt(process.env.DB_PORT || process.env.MYSQL_PORT || '22387');
const DB_USER = process.env.DB_USER || process.env.MYSQL_USER || 'Wuzhenyu';
const DB_PASSWORD = process.env.DB_PASSWORD || process.env.MYSQL_PASSWORD || 'Wh111852';
const DB_NAME = process.env.DB_NAME || process.env.MYSQL_DATABASE || 'gms';
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const DATA_DIR = path.join(__dirname, 'data');
const TOKEN_EXPIRY = 2 * 60 * 60 * 1000; // 2 hours sliding window

// ==================== DATABASE ====================
const mysql = require('mysql2/promise');

if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

let pool;

async function initPool() {
  // Connect without database first to ensure it exists
  const initConn = await mysql.createConnection({
    host: DB_HOST, port: DB_PORT, user: DB_USER, password: DB_PASSWORD,
    charset: 'utf8mb4',
  });
  await initConn.execute(`CREATE DATABASE IF NOT EXISTS \`${DB_NAME}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  await initConn.end();

  pool = mysql.createPool({
    host: DB_HOST, port: DB_PORT, user: DB_USER, password: DB_PASSWORD,
    database: DB_NAME,
    charset: 'utf8mb4',
    waitForConnections: true,
    connectionLimit: 80,      // per worker; with 4+ workers, total ~320+ connections
    queueLimit: 200,           // queue pending requests instead of erroring
    enableKeepAlive: true,
    keepAliveInitialDelay: 10000,
    connectTimeout: 10000,
    idleTimeout: 60000,
  });

  // Handle pool errors — don't let them crash the server
  pool.on('error', (err) => {
    console.error('[DB] Pool error (non-fatal):', err.message);
  });

  // Test connection
  const conn = await pool.getConnection();
  await conn.ping();
  conn.release();
  console.log('[DB] MySQL connected:', DB_HOST + ':' + DB_PORT + '/' + DB_NAME);
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
  if (s < 60) return '<1分钟';
  const m = Math.round(s / 60);
  if (m < 60) return m + '分钟';
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm > 0 ? h + '时' + rm + '分' : h + '小时';
}

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
        await redisClient.del(members.map(k => `tk:${k.replace('tk:', '')}`));
        await redisClient.del(`u:tk:${userId}`);
      }
    } catch {}
  }
  Object.keys(tokens).forEach(k => { if (tokens[k].userId === userId) delete tokens[k]; });
  saveTokens();
}

// ==================== SSE CLIENTS ====================
const sseClients = new Set();
let sseHeartbeatInterval = null;

function broadcastSSE(event, data) {
  const payload = JSON.stringify({ event, data });
  if (redisPub) {
    // Cross-worker: publish to Redis, all workers forward to their own clients
    redisPub.publish('sse:all', payload).catch(() => {});
  }
  // Local broadcast (always working even without Redis)
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  sseClients.forEach(res => { try { res.write(msg); } catch { sseClients.delete(res); } });
  // Invalidate cache on data mutations
  _invalidateCache(event);
}

// Subscribe to Redis Pub/Sub for SSE (receive broadcasts from other workers)
async function _initSSEPubSub() {
  if (!redisSub) return;
  await redisSub.subscribe('sse:all', (raw) => {
    try {
      const { event, data } = JSON.parse(raw);
      const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
      sseClients.forEach(res => { try { res.write(msg); } catch { sseClients.delete(res); } });
    } catch {}
  });
  // Heartbeat: keep SSE connections alive (prevent proxy/nginx timeouts)
  sseHeartbeatInterval = setInterval(() => {
    if (sseClients.size === 0) return;
    const hb = ': heartbeat\n\n';
    sseClients.forEach(res => { try { res.write(hb); } catch { sseClients.delete(res); } });
  }, 30000);
  console.log(`[Worker ${process.env.pm_id || '?'}] SSE Pub/Sub + heartbeat ready`);
}

// ==================== IN-MEMORY CACHE + REQUEST COALESCING ====================
const _cache = new Map();
const _inflight = new Map();  // key -> Promise (prevents thundering herd)
const CACHE_TTL = {
  equipment_config: 120000,  // 2min
  inventory_config: 120000,  // 2min
  sn_registry: 15000,        // 15s
  machines: 15000,           // 15s
  sync: 30000,               // 30s
};

function _invalidateCache(event) {
  const map = {
    'equipment_config_updated': 'equipment_config',
    'inventory_config_updated': 'inventory_config',
    'sn_registry_updated': 'sn_registry',
    'machines_updated': 'machines',
  };
  for (const [evt, key] of Object.entries(map)) {
    if (event === evt) _cache.delete(key);
  }
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

function sendJSON(res, data, status = 200, req) {
  const body = Buffer.from(JSON.stringify(data), 'utf-8');
  const accept = (req && req.headers && req.headers['accept-encoding']) || '';
  const useGzip = accept.includes('gzip') && body.length > 1024;
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
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

async function requireAuth(req, res) {
  const auth = req.headers['authorization'];
  if (!auth || !auth.startsWith('Bearer ')) { sendJSON(res, { error: '未登录' }, 401); return null; }
  const user = await validateToken(auth.slice(7));
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
  if (!username || !password) return sendJSON(res, { error: '请输入用户名和密码' }, 400);
  const [rows] = await pool.execute('SELECT * FROM users WHERE username = ?', [username]);
  if (rows.length === 0 || rows[0].passwordHash !== hashPassword(password)) {
    return sendJSON(res, { error: '用户名或密码错误' }, 401);
  }
  const user = rows[0];
  // Clean expired/stale tokens and invalidate user's existing tokens
  await invalidateUserTokens(user.id);
  const STALE_THRESHOLD = 3 * 60 * 1000;
  Object.keys(tokens).forEach(k => {
    const t = tokens[k];
    if (t.expires < Date.now() || (Date.now() - (t.lastActive || 0)) > STALE_THRESHOLD) delete tokens[k];
  });
  saveTokens();
  const token = await createToken(user);
  sendJSON(res, { token, user: { id: user.id, username: user.username, displayName: user.displayName || user.username, role: user.role, system: user.system || 'maintenance' } });
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
  const onlineIds = new Set();
  Object.values(tokens).forEach(t => { if (t.expires > Date.now()) onlineIds.add(t.userId); });
  sendJSON(res, users.map(u => ({ id: u.id, username: u.username, displayName: u.displayName || u.username, role: u.role, system: u.system || 'maintenance', parentId: u.parentId || null, createdAt: u.createdAt, online: onlineIds.has(u.id) })));
}

async function handleAddUser(req, res, user, body) {
  if (user.role !== 'admin' && user.role !== 'superadmin') return sendJSON(res, { error: '无权限添加用户' }, 403);
  const { username, password, role, system, displayName } = body;
  if (!username || !password) return sendJSON(res, { error: '请输入用户名和密码' }, 400);
  if (user.role === 'admin' && role === 'admin') return sendJSON(res, { error: '管理员只能创建普通用户' }, 403);
  if (role === 'superadmin') return sendJSON(res, { error: '无法创建超级管理员账户' }, 403);
  const [existing] = await pool.execute('SELECT id FROM users WHERE username = ?', [username]);
  if (existing.length > 0) return sendJSON(res, { error: '用户名已存在' }, 400);
  const id = 'u-' + Date.now().toString(36);
  const userSystem = system || user.system || 'maintenance';
  // When admin creates a user, set parentId to establish hierarchy
  const parentId = (user.role === 'admin' || user.role === 'superadmin') ? user.userId : null;
  await pool.execute(
    'INSERT INTO users (id, username, passwordHash, role, `system`, displayName, createdBy, parentId, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [id, username, hashPassword(password), role || 'user', userSystem, displayName || username, user.userId, parentId, new Date().toISOString()]
  );
  broadcastSSE('users_updated', {});
  sendJSON(res, { success: true, user: { id, username, displayName: displayName || username, role: role || 'user', system: userSystem, parentId } });
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
    await pool.execute('UPDATE users SET username = ?, passwordHash = ? WHERE id = ?', [username.trim(), hashPassword(password.trim()), userId]);
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

function handleGetOnlineUsers(req, res, user) {
  if (user.role !== 'admin' && user.role !== 'superadmin') return sendJSON(res, { error: '无权限' }, 403);
  const online = [], seen = new Set();
  Object.values(tokens).forEach(t => {
    if (t.expires > Date.now() && !seen.has(t.userId)) { seen.add(t.userId); online.push({ userId: t.userId, username: t.username, role: t.role }); }
  });
  sendJSON(res, online);
}

async function handleGetSubordinates(req, res, user) {
  if (user.role !== 'admin' && user.role !== 'superadmin') return sendJSON(res, { error: '无权限' }, 403);
  const [allUsers] = await pool.execute('SELECT * FROM users WHERE parentId = ? OR createdBy = ?', [user.userId, user.userId]);
  const onlineIds = new Set();
  Object.values(tokens).forEach(t => { if (t.expires > Date.now()) onlineIds.add(t.userId); });
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

async function handleGetTechSupportList(req, res, authUser) {
  const [rows] = await pool.execute('SELECT data FROM tech_support ORDER BY id DESC');
  let items = rows.map(r => JSON.parse(r.data));
  if (authUser.system === 'operations' && authUser.role !== 'superadmin') {
    if (authUser.role === 'admin') {
      // Admin/leader sees own requests + all subordinates' requests
      const [subs] = await pool.execute('SELECT id FROM users WHERE parentId = ?', [authUser.userId]);
      const subIds = new Set(subs.map(s => s.id));
      subIds.add(authUser.userId); // also own
      items = items.filter(item => subIds.has(item.submitterId));
    } else {
      // Regular user sees only own requests
      items = items.filter(item => item.submitterId === authUser.userId);
    }
  }
  items.sort((a, b) => new Date(b.submittedAt || 0) - new Date(a.submittedAt || 0));
  sendJSON(res, items);
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

async function handleSubmitTechSupport(req, res, authUser, body) {
  // Only operations users (or superadmin) can submit
  if (authUser.system !== 'operations' && authUser.role !== 'superadmin') {
    return sendJSON(res, { error: '仅运营用户可提交技术支持请求' }, 403);
  }
  const { equipmentType, equipmentTypeName, machineId, machineNumber, faultType, faultDescription } = body;
  if (!equipmentType || !machineId || !faultType) {
    return sendJSON(res, { error: '请填写所有必填字段' }, 400);
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
  // Real-time Feishu sync (non-blocking)
  setImmediate(() => feishu.syncToFeishu(item).catch(e => console.error('[Feishu] Sync err:', e.message)));
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
  // Sync to Feishu (background, zero impact on response time)
  setImmediate(() => feishu.syncToFeishu(item).catch(e => console.error("[Feishu] Sync err:", e.message)));
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
  const now = new Date().toISOString();
  item.status = 'completed';
  item.completedAt = now;
  item.result = (body && body.result) || '';
  item.repairSeconds = Math.round((new Date(now) - new Date(item.respondedAt)) / 1000);
  item.totalSeconds = Math.round((new Date(now) - new Date(item.submittedAt)) / 1000);
  await pool.execute('REPLACE INTO tech_support (id, data) VALUES (?, ?)', [id, JSON.stringify(item)]);
  // Restore machine status to online
  await _updateMachineStatusByNumber(item.machineNumber, 'online');
  broadcastSSE('tech_support_updated', { action: 'completed', id });
  broadcastSSE('machines_updated', {});
  sendJSON(res, { success: true, item });
  // Sync to Feishu (background, zero impact on response time)
  setImmediate(() => feishu.syncToFeishu(item).catch(e => console.error("[Feishu] Sync err:", e.message)));
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
  const [rows] = await pool.execute('SELECT data FROM group_transfers WHERE id = ?', [transferId]);
  if (rows.length === 0) return sendJSON(res, { error: '调配请求不存在' }, 404);
  const item = JSON.parse(rows[0].data);
  if (item.status !== 'pending') return sendJSON(res, { error: '该请求已处理' }, 400);
  if (item.toAdminId !== authUser.userId && item.fromAdminId !== authUser.userId) {
    return sendJSON(res, { error: '您不是该调配的相关组长，无权审批' }, 403);
  }
  // Either admin can approve → user's parentId changes to the other admin
  const isSender = (item.fromAdminId === authUser.userId);
  const newParentId = isSender ? item.toAdminId : item.fromAdminId;
  await pool.execute('UPDATE users SET parentId = ? WHERE id = ?', [newParentId, item.userId]);
  item.status = 'completed';
  item.completedAt = new Date().toISOString();
  broadcastSSE('users_updated', {});
  item.updatedAt = new Date().toISOString();
  await pool.execute('REPLACE INTO group_transfers (id, data) VALUES (?, ?)', [transferId, JSON.stringify(item)]);
  broadcastSSE('group_transfer_updated', { action: 'approved', id: transferId });
  sendJSON(res, { success: true, item });
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
  if (authUser.role !== 'admin' && authUser.role !== 'superadmin') {
    return sendJSON(res, { error: '仅组长可查看组员' }, 403);
  }
  // System isolation: admins only see same-system users; superadmin sees all
  const systemFilter = authUser.role === 'superadmin' ? '' : `AND \`system\` = '${authUser.system}'`;
  const [users] = await pool.execute(
    `SELECT id, username, displayName, role, \`system\`, parentId, createdBy, createdAt
     FROM users WHERE role = 'user' ${systemFilter} ORDER BY username`
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
    const adminSystemFilter = authUser.role === 'superadmin' ? '' : `AND \`system\` = '${authUser.system}'`;
    const [admins] = await pool.execute(
      `SELECT id, username, displayName FROM users WHERE id IN (${adminIds.map(() => '?').join(',')}) ${adminSystemFilter}`,
      adminIds
    );
    admins.forEach(a => {
      if (groups[a.id]) groups[a.id].adminName = a.displayName || a.username;
    });
    // Remove groups whose admin wasn't found (different system)
    for (const gid of Object.keys(groups)) {
      if (!groups[gid].adminName) delete groups[gid];
    }
  }
  sendJSON(res, Object.values(groups));
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
  sendJSON(res, { success: true });
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
  if (newPassword.length < 4) return sendJSON(res, { error: '新密码至少4个字符' }, 400);
  const [rows] = await pool.execute('SELECT * FROM users WHERE id = ?', [user.userId]);
  if (rows.length === 0) return sendJSON(res, { error: '用户不存在' }, 404);
  if (rows[0].passwordHash !== hashPassword(oldPassword)) return sendJSON(res, { error: '旧密码错误' }, 403);
  await pool.execute('UPDATE users SET passwordHash = ? WHERE id = ?', [hashPassword(newPassword), user.userId]);
  sendJSON(res, { success: true });
}

// Reset another user's password (superadmin → admin, admin → group members)
async function handleResetPassword(req, res, user, userId, body) {
  const { newPassword } = body;
  if (!newPassword || newPassword.length < 4) return sendJSON(res, { error: '新密码至少4个字符' }, 400);

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

  await pool.execute('UPDATE users SET passwordHash = ? WHERE id = ?', [hashPassword(newPassword.trim()), userId]);

  // Invalidate target user's tokens (force re-login)
  await invalidateUserTokens(userId);
  saveTokens();

  broadcastSSE('users_updated', {});
  sendJSON(res, { success: true, message: '密码已重置' });
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
  const limit = url.searchParams.get('limit') || 10000;
  sendJSON(res, await readJSONArray('transactions', limit));
}
async function handleAddTransaction(req, res, user, body) {
  const id = body.id || ('tx-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6));
  await saveJSON('transactions', id, { ...body, id, timestamp: body.timestamp || new Date().toISOString() });
  broadcastSSE('transactions_updated', {});
  sendJSON(res, { success: true, transaction: { ...body, id } });
}
async function handleDeleteTransaction(req, res, user, txId) {
  if (user.role !== 'admin' && user.role !== 'superadmin') return sendJSON(res, { error: '无删除权限' }, 403);
  await deleteJSON('transactions', txId);
  broadcastSSE('transactions_updated', {});
  sendJSON(res, { success: true });
}

// -- Audit Log --
async function handleGetAuditLog(req, res, user) {
  const url = new URL(req.url, 'http://localhost');
  const limit = parseInt(url.searchParams.get('limit')) || 500;
  sendJSON(res, await readJSONArray('audit_log', Math.min(limit, 5000)));
}

// -- Settings --
async function handleGetSettings(req, res, user) {
  sendJSON(res, await readJSONObject('settings'));
}
async function handleSaveSettings(req, res, user, body) {
  for (const [k, v] of Object.entries(body)) {
    await pool.execute('REPLACE INTO settings (skey, value) VALUES (?, ?)', [k, JSON.stringify(v)]);
  }
  broadcastSSE('settings_updated', {});
  sendJSON(res, { success: true });
}

// -- Equipment Config --
async function handleGetEquipmentConfig(req, res) {
  const result = await _cached('equipment_config', () => readJSONArray('equipment_config'));
  sendJSON(res, result);
}
async function handleSaveEquipmentConfig(req, res, body) {
  await pool.execute('DELETE FROM equipment_config');
  if (Array.isArray(body)) {
    for (const item of body) {
      await pool.execute('INSERT INTO equipment_config (id, data) VALUES (?, ?)', [item.id, JSON.stringify(item)]);
    }
  }
  broadcastSSE('equipment_config_updated', {});
  sendJSON(res, { success: true });
}
async function handleDeleteEquipmentConfig(req, res, id) {
  await deleteJSON('equipment_config', id);
  broadcastSSE('equipment_config_updated', {});
  sendJSON(res, { success: true });
}

// -- Inventory Config --
async function handleGetInventoryConfig(req, res) {
  const result = await _cached('inventory_config', () => readJSONArray('inventory_config'));
  sendJSON(res, result);
}
async function handleSaveInventoryConfig(req, res, body) {
  await pool.execute('DELETE FROM inventory_config');
  if (Array.isArray(body)) {
    for (const item of body) {
      await pool.execute('INSERT INTO inventory_config (id, data) VALUES (?, ?)', [item.id, JSON.stringify(item)]);
    }
  }
  broadcastSSE('inventory_config_updated', {});
  sendJSON(res, { success: true });
}
async function handleDeleteInventoryConfig(req, res, id) {
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
  await pool.execute(`DELETE FROM ${table}`);
  if (Array.isArray(body)) {
    for (const item of body) {
      await pool.execute(`INSERT INTO ${table} (id, data) VALUES (?, ?)`, [item.id || ('_' + Date.now().toString(36)), JSON.stringify(item)]);
    }
  }
  broadcastSSE(`${table}_updated`, {});
  sendJSON(res, { success: true });
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
          // If endTime < startTime, it spans midnight (e.g. 7:00 to 02:00 next day)
          if (endTime) {
            const [eh, em] = endTime.split(':').map(Number);
            const endMin = eh * 60 + em;
            if (endMin < startMin) {
              // Spanning midnight: allow >= startMin OR <= endMin
              if (hourMin < startMin && hourMin > endMin) return false;
            } else {
              // Normal range: startMin <= hourMin <= endMin
              if (hourMin < startMin || hourMin > endMin) return false;
            }
          } else {
            if (hourMin < startMin) return false;
          }
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
      'ops_orders', 'ops_customers', 'ops_production', 'sn_registry', 'tech_support'];
    for (const t of tables) await conn.execute('DELETE FROM ' + t);
    await conn.commit();
  } catch (e) {
    await conn.rollback();
  } finally {
    conn.release();
  }
  // Clean uploaded photo files
  try {
    if (fs.existsSync(UPLOADS_DIR)) {
      fs.readdirSync(UPLOADS_DIR).forEach(f => { try { fs.unlinkSync(path.join(UPLOADS_DIR, f)); } catch {} });
    }
  } catch {}
  const events = ['inventory', 'machines', 'transactions', 'audit_log', 'ops_orders', 'ops_customers', 'ops_production', 'sn_registry', 'tech_support'];
  events.forEach(e => broadcastSSE(e + '_updated', {}));
  sendJSON(res, { success: true });
}

// -- Full Export (ZIP) --
async function handleExportFull(req, res, user) {
  if (user.role !== 'admin' && user.role !== 'superadmin') return sendJSON(res, { error: '仅管理员可执行此操作' }, 403);
  const AdmZip = require('adm-zip');
  const zip = new AdmZip();

  const [inv] = await pool.execute('SELECT * FROM inventory');
  const machines = await readJSONArray('machines');
  const transactions = await readJSONArray('transactions');
  const auditLog = await readJSONArray('audit_log');
  const settings = await readJSONObject('settings');
  const [snReg] = await pool.execute('SELECT * FROM sn_registry');
  const equipmentConfig = await readJSONArray('equipment_config');
  const inventoryConfig = await readJSONArray('inventory_config');
  const opsOrders = await readJSONArray('ops_orders');
  const opsCustomers = await readJSONArray('ops_customers');
  const opsProduction = await readJSONArray('ops_production');
  const [tsRows] = await pool.execute('SELECT data FROM tech_support');
  const techSupport = tsRows.map(r => JSON.parse(r.data));

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

  try {
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
      const tables = ['inventory', 'machines', 'transactions', 'audit_log', 'sn_registry',
        'ops_orders', 'ops_customers', 'ops_production', 'tech_support'];
      for (const t of tables) await conn.execute('DELETE FROM ' + t);
      await conn.execute('DELETE FROM settings');
      await conn.execute('DELETE FROM equipment_config');
      await conn.execute('DELETE FROM inventory_config');
      await conn.commit();
    } catch (e) {
      await conn.rollback();
      throw e;
    } finally {
      conn.release();
    }

    // Clean uploads dir
    try {
      if (fs.existsSync(UPLOADS_DIR)) {
        fs.readdirSync(UPLOADS_DIR).forEach(f => { try { fs.unlinkSync(path.join(UPLOADS_DIR, f)); } catch {} });
      }
    } catch {}

    // Restore inventory
    if (Array.isArray(backup.inventory)) {
      for (const r of backup.inventory) {
        await pool.execute('REPLACE INTO inventory (inv_type, quantity, updatedAt, updatedBy) VALUES (?, ?, ?, ?)',
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
          await pool.execute(`REPLACE INTO ${table} (id, data) VALUES (?, ?)`, [id, JSON.stringify(item)]);
        }
      }
    }

    // Restore settings
    if (backup.settings && typeof backup.settings === 'object') {
      for (const [k, v] of Object.entries(backup.settings)) {
        await pool.execute('REPLACE INTO settings (skey, value) VALUES (?, ?)', [k, JSON.stringify(v)]);
      }
    }

    // Restore SN registry
    if (Array.isArray(backup.snRegistry)) {
      for (const r of backup.snRegistry) {
        await pool.execute(
          'REPLACE INTO sn_registry (snCode, equipmentType, handType, status, machineNumber, damageReason, trackingNumber, attachment, updatedAt, shippedAt, repairedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [r.snCode, r.equipmentType || null, r.handType || null, r.status || 'available',
            r.machineNumber || null, r.damageReason || null, r.trackingNumber || null,
            r.attachment || null, r.updatedAt || new Date().toISOString(),
            r.shippedAt || null, r.repairedAt || null]
        );
      }
    }

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
  } catch (e) {
    console.error('[IMPORT] Failed:', e.message);
    sendJSON(res, { error: '恢复失败: ' + e.message }, 500);
  }
}

// Helper: Map SN equipmentType + handType to inventory type key
function _snToInvType(equipmentType, handType) {
  if (equipmentType === 'glove') return handType === 'left' ? 'left_glove' : 'right_glove';
  if (equipmentType === 'dexterous_hand') return handType === 'left' ? 'left_dexterous_hand' : 'right_dexterous_hand';
  if (handType) return equipmentType + '_' + handType;
  return equipmentType || 'left_glove';
}

// ==================== SN REGISTRY ====================
async function handleGetSNRegistry(req, res) {
  const rows = await _cached('sn_registry', async () => {
    const [r] = await pool.execute('SELECT * FROM sn_registry ORDER BY updatedAt DESC LIMIT 5000');
    return r;
  });
  sendJSON(res, rows);
}

async function handleUpsertSNRegistry(req, res, authUser, body) {
  const { snCode, equipmentType, handType, status, machineNumber, damageReason, trackingNumber, attachment, shippedAt, repairedAt } = body;
  if (!snCode) return sendJSON(res, { error: 'SN码不能为空' }, 400);
  const now = new Date().toISOString();
  const [existing] = await pool.execute('SELECT * FROM sn_registry WHERE snCode = ?', [snCode]);
  if (existing.length > 0) {
    const fields = ['equipmentType', 'handType', 'status', 'machineNumber', 'trackingNumber', 'damageReason', 'shippedAt', 'repairedAt', 'attachment'];
    const vals = {};
    fields.forEach(f => { vals[f] = body[f] !== undefined ? body[f] : existing[0][f]; });
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
  const [existing] = await pool.execute('SELECT * FROM sn_registry WHERE snCode = ?', [snCode]);
  if (existing.length > 0 && (existing[0].status === 'damaged' || existing[0].status === 'in_repair')) {
    const invType = _snToInvType(existing[0].equipmentType, existing[0].handType);
    const [rows] = await pool.execute('SELECT quantity FROM inventory WHERE inv_type = ?', [invType]);
    const currentQty = rows.length > 0 ? rows[0].quantity : 0;
    await pool.execute(
      'REPLACE INTO inventory (inv_type, quantity, updatedAt, updatedBy) VALUES (?, ?, ?, ?)',
      [invType, currentQty + 1, now, '系统']
    );
    broadcastSSE('inventory_updated', { type: invType, quantity: currentQty + 1, updatedBy: '系统' });
  }
  await pool.execute(
    'UPDATE sn_registry SET status=?, repairedAt=?, updatedAt=?, trackingNumber=NULL, machineNumber=NULL, damageReason=NULL WHERE snCode=?',
    ['available', now, now, snCode]
  );
  broadcastSSE('sn_registry_updated', {});
  sendJSON(res, { success: true });
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
    const [existing] = await conn.execute('SELECT * FROM sn_registry WHERE snCode = ?', [snCode]);
    if (existing.length === 0) { await conn.rollback(); return sendJSON(res, { success: false, message: 'SN码不存在' }, 404); }

    if (existing[0].status === 'available') {
      const invType = _snToInvType(existing[0].equipmentType, existing[0].handType);
      const [rows] = await conn.execute('SELECT quantity FROM inventory WHERE inv_type = ?', [invType]);
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
  const [existing] = await pool.execute('SELECT * FROM sn_registry WHERE snCode = ?', [snCode]);
  if (existing.length > 0 && existing[0].status === 'available') {
    const invType = _snToInvType(existing[0].equipmentType, existing[0].handType);
    const [rows] = await pool.execute('SELECT quantity FROM inventory WHERE inv_type = ?', [invType]);
    const currentQty = rows.length > 0 ? rows[0].quantity : 0;
    const newQty = Math.max(0, currentQty - 1);
    await pool.execute('REPLACE INTO inventory (inv_type, quantity, updatedAt, updatedBy) VALUES (?, ?, ?, ?)',
      [invType, newQty, new Date().toISOString(), '系统']);
    broadcastSSE('inventory_updated', { type: invType, quantity: newQty, updatedBy: '系统' });
  }
  await pool.execute('DELETE FROM sn_registry WHERE snCode = ?', [snCode]);
  broadcastSSE('sn_registry_updated', {});
  sendJSON(res, { success: true });
}

// -- File Upload / Delete --
function handleUpload(req, res, body) {
  // Store attachments as base64 in DB (not filesystem — prevents data loss on server rebuild)
  const { filename, data } = body;
  if (!data || !filename) return sendJSON(res, { error: '缺少文件数据' }, 400);
  const matches = data.match(/^data:([^;]+);base64,(.+)$/);
  if (!matches) return sendJSON(res, { error: '无效的数据格式' }, 400);
  const base64Data = matches[2];
  const decodedBuf = Buffer.from(base64Data, 'base64');
  if (decodedBuf.length > 10 * 1024 * 1024) return sendJSON(res, { error: '文件大小超过限制(最大10MB)' }, 413);
  // Return the base64 data URL directly — frontend stores it in the attachment field
  sendJSON(res, { path: data });
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
async function handleSync(req, res) {
  const cachedData = await _cached('sync', async () => {
    // Parallel queries for speed
    const [inventory, snRegistry, tsRows, machines, transactions,
      settings, equipmentConfig, inventoryConfig,
      opsOrders, opsCustomers, opsProduction] = await Promise.all([
    pool.execute('SELECT * FROM inventory'),
    pool.execute('SELECT * FROM sn_registry ORDER BY updatedAt DESC LIMIT 5000'),
    pool.execute('SELECT data FROM tech_support ORDER BY id DESC LIMIT 1000'),
    pool.execute('SELECT data FROM machines ORDER BY id DESC LIMIT 5000'),
    pool.execute('SELECT data FROM transactions ORDER BY id DESC LIMIT 500'),
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

    if (req.url === '/api/health' && req.method === 'GET') {
      return sendJSON(res, { status: 'ok', uptime: process.uptime() });
    }

    if (req.url === '/api/status' && req.method === 'GET') {
      const onlineIds = new Set();
      Object.values(tokens).forEach(t => { if (t.expires > Date.now()) onlineIds.add(t.userId); });
      const count = onlineIds.size;
      // Load level: idle(0) / smooth(1-99) / busy(100-199) / full(200+)
      let level = 'idle', label = '空闲';
      if (count >= 200) { level = 'full'; label = '爆满'; }
      else if (count >= 100) { level = 'busy'; label = '拥挤'; }
      else if (count >= 1) { level = 'smooth'; label = '畅通'; }
      return sendJSON(res, {
        status: 'ok',
        onlineUsers: count,
        loadLevel: level,
        loadLabel: label,
        version: '3.9.0',
      });
    }

    if (req.url === '/api/events' && req.method === 'GET') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      });
      res.write('event: connected\ndata: {}\n\n');
      sseClients.add(res);

      // Keepalive: send heartbeat every 25s to prevent gateway timeout
      const keepalive = setInterval(() => {
        try { res.write(':heartbeat\n\n'); } catch { clearInterval(keepalive); sseClients.delete(res); }
      }, 25000);

      req.on('close', () => { clearInterval(keepalive); sseClients.delete(res); });
      return;
    }

    if (serveStatic(req, res)) return;

    const url = new URL(req.url, 'http://localhost');
    const body = (req.method === 'POST' || req.method === 'PUT') ? await parseBody(req) : {};

    // Public: login
    if (url.pathname === '/api/auth/login' && req.method === 'POST') return handleLogin(req, res, body);
    if (url.pathname === '/api/beacon-logout' && req.method === 'POST') return handleBeaconLogout(req, res, body);

    // Auth required for all other API routes
    const authUser = await requireAuth(req, res);
    if (!authUser) return;

    // Inventory
    if (url.pathname === '/api/inventory' && req.method === 'GET') return handleGetAllInventory(req, res, authUser);
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

    // Promote/demote user
    const promoteMatch = url.pathname.match(/^\/api\/users\/([^/]+)\/promote$/);
    if (promoteMatch && req.method === 'POST') return handlePromoteUser(req, res, authUser, promoteMatch[1]);

    // Reset user password (admin/superadmin action)
    const resetPwdMatch = url.pathname.match(/^\/api\/users\/([^/]+)\/reset-password$/);
    if (resetPwdMatch && req.method === 'POST') return handleResetPassword(req, res, authUser, resetPwdMatch[1], body);

    // Change own password
    if (url.pathname === '/api/change-password' && req.method === 'POST') return handleChangePassword(req, res, authUser, body);

    // Equipment Config
    if (url.pathname === '/api/equipment-config' && req.method === 'GET') return handleGetEquipmentConfig(req, res);
    if (url.pathname === '/api/equipment-config' && req.method === 'POST') return handleSaveEquipmentConfig(req, res, body);
    const delEq = url.pathname.match(/^\/api\/equipment-config\/(.+)$/);
    if (delEq && req.method === 'DELETE') return handleDeleteEquipmentConfig(req, res, delEq[1]);

    // Inventory Config
    if (url.pathname === '/api/inventory-config' && req.method === 'GET') return handleGetInventoryConfig(req, res);
    if (url.pathname === '/api/inventory-config' && req.method === 'POST') return handleSaveInventoryConfig(req, res, body);
    const delInv = url.pathname.match(/^\/api\/inventory-config\/(.+)$/);
    if (delInv && req.method === 'DELETE') return handleDeleteInventoryConfig(req, res, delInv[1]);

    // Data integrity
    if (url.pathname === '/api/data-integrity' && req.method === 'GET') return handleDataIntegrity(req, res);

    // Sync (polling fallback)
    if (url.pathname === '/api/sync' && req.method === 'GET') return handleSync(req, res);

    // SN Registry
    if (url.pathname === '/api/sn-registry' && req.method === 'GET') return handleGetSNRegistry(req, res);
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

    // Init SSE Pub/Sub cross-worker broadcast
    await _initSSEPubSub();

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
  if (sseHeartbeatInterval) clearInterval(sseHeartbeatInterval);
  sseClients.forEach(res => { try { res.end(); } catch {} });
  sseClients.clear();
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
