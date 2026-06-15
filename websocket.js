/**
 * ===================================================================
 *  Yunwei WebSocket Module — 实时双向通信 (500并发)
 *
 *  与 SSE 互补:
 *    - SSE:  服务端 → 客户端 (事件推送)
 *    - WS:    客户端 → 服务端 (实时操作反馈)
 *
 *  技术栈: 原生 ws (无额外依赖, 性能最优)
 *  协议:   WebSocket over HTTP Upgrade (与 HTTP 共用端口)
 *
 *  房间机制:
 *    - 每用户加入个人房间 (user:{id})
 *    - 每系统加入系统房间 (system:{maintenance|operations})
 *    - 广播频道 (admin 通知)
 * ===================================================================
 */

const { Server: WebSocketServer } = require('ws');
const crypto = require('crypto');

let wss = null;
const clients = new Map();        // ws → clientInfo
const rooms = new Map();          // roomName → Set<ws>
const userSockets = new Map();    // userId → Set<ws>

// ==================== INITIALIZATION ====================
/**
 * 初始化 WebSocket 服务 (绑定到 HTTP server)
 * @param {http.Server} httpServer
 * @param {object} redisModule Redis 模块引用 (用于 Pub/Sub)
 */
function init(httpServer, redisModule) {
  wss = new WebSocketServer({
    server: httpServer,
    path: '/ws',                   // 专用路径, 不干扰 HTTP
    maxPayload: 512 * 1024,        // 512KB 消息上限
    clientTracking: true,
    // 性能优化
    perMessageDeflate: {
      zlibDeflateOptions: { level: 6 },
      threshold: 1024,
    },
  });

  wss.on('connection', (ws, req) => {
    const clientId = crypto.randomBytes(8).toString('hex');
    const ip = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown';

    const clientInfo = {
      id: clientId,
      ip,
      connectedAt: Date.now(),
      userId: null,
      username: null,
      system: null,
      authenticated: false,
      rooms: new Set(),
    };

    clients.set(ws, clientInfo);
    ws.isAlive = true;
    ws.clientId = clientId;

    // 心跳检测
    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('message', (raw) => handleMessage(ws, clientInfo, raw));
    ws.on('close', () => handleDisconnect(ws, clientInfo));
    ws.on('error', (err) => {
      console.error(`[WS] Client ${clientId} error:`, err.message);
    });

    // 发送欢迎消息
    send(ws, { type: 'connected', clientId, ts: Date.now() });

    // 限流: 每IP最多20个连接
    const ipCount = [...clients.values()].filter(c => c.ip === ip).length;
    if (ipCount > 20) {
      send(ws, { type: 'error', code: 'TOO_MANY_CONNECTIONS', msg: 'IP连接数超限' });
      ws.close(4001);
      return;
    }
  });

  // 心跳检测定时器 (30秒)
  const heartbeat = setInterval(() => {
    wss.clients.forEach((ws) => {
      if (ws.isAlive === false) {
        ws.terminate();
        return;
      }
      ws.isAlive = false;
      ws.ping();
    });
  }, 30000);

  wss.on('close', () => {
    clearInterval(heartbeat);
  });

  // 订阅 Redis Pub/Sub (接收跨 Worker 广播)
  if (redisModule && redisModule.isConnected()) {
    redisModule.subscribe(redisModule.WS_CHANNEL, (msg) => {
      broadcastToAll(msg, null); // 仅在本地 Worker 广播
    }).catch(() => {});
  }

  const workerId = process.env.pm_id || '0';
  console.log(`[Worker ${workerId}] WebSocket server ready (path: /ws)`);
  return wss;
}

// ==================== MESSAGE HANDLER ====================
async function handleMessage(ws, clientInfo, raw) {
  let msg;
  try {
    msg = JSON.parse(raw.toString());
  } catch {
    send(ws, { type: 'error', code: 'INVALID_JSON', msg: '无效的JSON格式' });
    return;
  }

  const { type, token, ...data } = msg;

  switch (type) {
    case 'auth':
      await handleAuth(ws, clientInfo, token, data);
      break;

    case 'join':
      handleJoinRoom(ws, clientInfo, data.room);
      break;

    case 'leave':
      handleLeaveRoom(ws, clientInfo, data.room);
      break;

    case 'ping':
      send(ws, { type: 'pong', ts: Date.now() });
      break;

    case 'subscribe':
      // 订阅特定事件类型
      if (data.events && Array.isArray(data.events)) {
        clientInfo.subscriptions = new Set(data.events);
      }
      break;

    default:
      send(ws, { type: 'error', code: 'UNKNOWN_TYPE', msg: `未知消息类型: ${type}` });
  }
}

// ==================== AUTH ====================
async function handleAuth(ws, clientInfo, token, data) {
  if (!token) {
    send(ws, { type: 'error', code: 'AUTH_REQUIRED', msg: '需要认证token' });
    return;
  }

  // 通过 HTTP API 验证 token (内部调用)
  try {
    const res = await new Promise((resolve, reject) => {
      const http = require('http');
      const req = http.request({
        hostname: '127.0.0.1',
        port: process.env.PORT || 8765,
        path: '/api/auth/verify',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        timeout: 5000,
      }, (res) => {
        let body = '';
        res.on('data', c => body += c);
        res.on('end', () => resolve(JSON.parse(body)));
      });
      req.on('error', reject);
      req.write(JSON.stringify({ token }));
      req.end();
    });

    if (res.valid) {
      clientInfo.authenticated = true;
      clientInfo.userId = res.user.userId;
      clientInfo.username = res.user.username;
      clientInfo.system = res.user.system;

      // 加入个人房间
      handleJoinRoom(ws, clientInfo, `user:${res.user.userId}`);
      // 加入系统房间
      handleJoinRoom(ws, clientInfo, `system:${res.user.system || 'maintenance'}`);

      // 维护用户索引
      if (!userSockets.has(res.user.userId)) {
        userSockets.set(res.user.userId, new Set());
      }
      userSockets.get(res.user.userId).add(ws);

      send(ws, { type: 'auth_ok', user: { username: res.user.username, system: res.user.system } });
    } else {
      send(ws, { type: 'error', code: 'AUTH_FAILED', msg: 'Token验证失败' });
    }
  } catch {
    send(ws, { type: 'error', code: 'AUTH_ERROR', msg: '认证服务不可用' });
  }
}

// ==================== ROOM MANAGEMENT ====================
function handleJoinRoom(ws, clientInfo, roomName) {
  if (!roomName) return;
  if (!rooms.has(roomName)) {
    rooms.set(roomName, new Set());
  }
  rooms.get(roomName).add(ws);
  clientInfo.rooms.add(roomName);

  send(ws, { type: 'room_joined', room: roomName, memberCount: rooms.get(roomName).size });
}

function handleLeaveRoom(ws, clientInfo, roomName) {
  if (!roomName) return;
  const room = rooms.get(roomName);
  if (room) {
    room.delete(ws);
    if (room.size === 0) rooms.delete(roomName);
  }
  clientInfo.rooms.delete(roomName);
  send(ws, { type: 'room_left', room: roomName });
}

// ==================== DISCONNECT ====================
function handleDisconnect(ws, clientInfo) {
  // 离开所有房间
  clientInfo.rooms.forEach(roomName => {
    const room = rooms.get(roomName);
    if (room) {
      room.delete(ws);
      if (room.size === 0) rooms.delete(roomName);
    }
  });

  // 清理用户索引
  if (clientInfo.userId && userSockets.has(clientInfo.userId)) {
    userSockets.get(clientInfo.userId).delete(ws);
    if (userSockets.get(clientInfo.userId).size === 0) {
      userSockets.delete(clientInfo.userId);
    }
  }

  clients.delete(ws);
}

// ==================== BROADCAST ====================
/** 发送消息给单个客户端 */
function send(ws, data) {
  if (ws.readyState === 1) { // OPEN
    try { ws.send(JSON.stringify(data)); } catch {}
  }
}

/** 广播给所有客户端 */
function broadcastToAll(data, excludeWs = null) {
  wss?.clients.forEach((ws) => {
    if (ws !== excludeWs && ws.readyState === 1) {
      try { ws.send(JSON.stringify(data)); } catch {}
    }
  });
}

/** 广播给指定房间 */
function broadcastToRoom(roomName, data) {
  const room = rooms.get(roomName);
  if (!room) return;
  room.forEach((ws) => {
    if (ws.readyState === 1) {
      try { ws.send(JSON.stringify(data)); } catch {}
    }
  });
}

/** 发送给指定用户 (所有设备) */
function sendToUser(userId, data) {
  const sockets = userSockets.get(userId);
  if (!sockets) return;
  sockets.forEach((ws) => {
    if (ws.readyState === 1) {
      try { ws.send(JSON.stringify(data)); } catch {}
    }
  });
}

/** 广播给指定系统的所有用户 */
function broadcastToSystem(system, data) {
  broadcastToRoom(`system:${system}`, data);
}

// ==================== METRICS ====================
function getMetrics() {
  return {
    totalClients: clients.size,
    totalRooms: rooms.size,
    authenticatedClients: [...clients.values()].filter(c => c.authenticated).length,
    rooms: [...rooms.entries()].map(([name, members]) => ({ name, members: members.size })),
  };
}

// ==================== EXPORTS ====================
module.exports = {
  init,
  send,
  sendToUser,
  broadcastToAll,
  broadcastToRoom,
  broadcastToSystem,
  getMetrics,
  getWSS: () => wss,
};
