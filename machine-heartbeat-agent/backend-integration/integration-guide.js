/**
 * 后端集成说明 - 将心跳功能添加到 GMS Backend
 *
 * 需要修改的文件：
 * 1. server.js - 添加路由和初始化心跳处理器
 * 2. src/handlers/machine-heartbeat.js - 新增（本目录已提供）
 */

// ==================== 修改 1: server.js - 导入心跳处理器 ====================
// 在 server.js 顶部，handlers 导入区域添加：

const createMachineHeartbeatHandlers = require('./src/handlers/machine-heartbeat');

// 在 startup() 函数中，handlers 初始化区域添加：
let machineHeartbeat; // 声明变量

// 在 pool 和 redis 初始化完成后：
machineHeartbeat = createMachineHeartbeatHandlers({
  pool,
  sendJSON,
  broadcastSSE,
  saveMachine,
});

// ==================== 修改 2: server.js - 添加路由 ====================
// 在 publicRouter 或 authRouter 中添加以下路由：

// 公开路由（无需认证）- 让心跳代理可以直接发送
publicRouter.post('/api/machines/heartbeat', async (req, res) => {
  await machineHeartbeat.handleReceiveHeartbeat(req, res, req.body);
});

publicRouter.post('/api/machines/:machineNumber/offline', async (req, res) => {
  const machineNumber = req.url.split('/')[3].split('?')[0];
  await machineHeartbeat.handleMarkOffline(req, res, machineNumber);
});

// 需要认证的路由
authRouter.get('/api/machines/heartbeat-status', async (req, res, user) => {
  await machineHeartbeat.handleGetHeartbeatStatus(req, res);
});

// ==================== 修改 3: server.js - 优雅关闭 ====================
// 在 gracefulShutdown 函数中添加清理逻辑：

async function gracefulShutdown(signal) {
  console.log(`[Shutdown] 收到信号 ${signal}...`);

  // 添加这行：
  if (machineHeartbeat) {
    machineHeartbeat.cleanup();
  }

  // ... 其他清理逻辑
}

// ==================== 完整的路由配置示例 ====================
/*
在 server.js 的路由分发部分（handleRequest 函数）添加：

// 公开路由（无需认证）
if (req.method === 'POST' && pathname === '/api/machines/heartbeat') {
  return await machineHeartbeat.handleReceiveHeartbeat(req, res, await parseBody(req));
}

if (req.method === 'POST' && pathname.startsWith('/api/machines/') && pathname.endsWith('/offline')) {
  const machineNumber = pathname.split('/')[3];
  return await machineHeartbeat.handleMarkOffline(req, res, machineNumber);
}

// 需要认证的路由
if (req.method === 'GET' && pathname === '/api/machines/heartbeat-status') {
  const user = await authenticateRequest(req);
  if (!user) return send401(res);
  return await machineHeartbeat.handleGetHeartbeatStatus(req, res);
}
*/
