/**
 * src/handlers/machine-heartbeat.js
 * Machine Heartbeat Handler - 机器心跳监控
 *
 * 功能:
 * 1. 接收各主机心跳代理发送的心跳
 * 2. 更新机器在线状态和最后心跳时间
 * 3. 定期检测超时机器并标记离线
 * 4. 广播状态变更通知
 *
 * 接口:
 *   POST /api/machines/heartbeat        接收心跳
 *   POST /api/machines/:number/offline  手动标记离线
 *   GET  /api/machines/heartbeat-status 心跳监控状态
 */
'use strict';

module.exports = function createMachineHeartbeatHandlers(deps) {
  const {
    pool,
    sendJSON,
    broadcastSSE,
    saveMachine,
  } = deps;

  // 心跳超时时间（秒）- 60秒无心跳则标记离线
  const HEARTBEAT_TIMEOUT = 60;

  // 内存中的心跳记录 machineNumber → { lastHeartbeat, ipAddress, hostname }
  const heartbeatCache = new Map();

  // ==================== 接收心跳 ====================
  async function handleReceiveHeartbeat(req, res, body) {
    try {
      const {
        machineNumber,
        hostname,
        ipAddress,
        deviceType,
        timestamp,
        uptime,
        platform,
        arch,
        cpus,
        totalMemory,
        freeMemory,
      } = body || {};

      // 验证必填字段
      if (!machineNumber) {
        return sendJSON(res, { error: 'machineNumber 不能为空' }, 400);
      }

      const now = new Date().toISOString();

      // 更新内存缓存
      heartbeatCache.set(machineNumber, {
        lastHeartbeat: Date.now(),
        ipAddress: ipAddress || 'unknown',
        hostname: hostname || machineNumber,
        timestamp: now,
      });

      // 查询当前机器最新状态
      const [rows] = await pool.execute(
        'SELECT data FROM machines WHERE machineNumber = ? ORDER BY updatedAt DESC, id DESC LIMIT 1',
        [machineNumber]
      );

      let currentMachine = null;
      if (rows.length > 0) {
        try {
          currentMachine = JSON.parse(rows[0].data);
        } catch (e) {
          console.error(`[Heartbeat] 解析机器数据失败: ${machineNumber}`, e);
        }
      }

      // 提取摄像头信息
      const cameras = body.cameras || [];

      // 检测摄像头掉帧
      const droppingCameras = cameras.filter(c => c.isDropping);
      const cameraStatus = cameras.length > 0 ?
        (droppingCameras.length > 0 ? 'dropping' : 'normal') :
        'no_camera';

      // 构建新的机器记录
      const machineData = {
        id: currentMachine ? currentMachine.id : `machine-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        machineNumber,
        deviceType: deviceType || (currentMachine ? currentMachine.deviceType : 'workstation'),
        status: 'online', // 收到心跳即为在线
        userId: currentMachine ? currentMachine.userId : null,
        location: currentMachine ? currentMachine.location : '未设置',
        lastHeartbeat: now,
        hostname: hostname || (currentMachine ? currentMachine.hostname : machineNumber),
        ipAddress: ipAddress || (currentMachine ? currentMachine.ipAddress : 'unknown'),
        systemInfo: {
          platform,
          arch,
          cpus,
          totalMemory,
          freeMemory,
          uptime,
        },
        cameras: {
          status: cameraStatus,
          count: cameras.length,
          dropping: droppingCameras.length,
          details: cameras,
          lastCheck: now,
        },
        updatedAt: now,
        updatedBy: 'heartbeat-agent',
      };

      // 保存到数据库
      await saveMachine(machineData);

      // 如果状态从离线变为在线，广播通知
      if (currentMachine && currentMachine.status === 'offline') {
        console.log(`[Heartbeat] 机器上线: ${machineNumber}`);
        broadcastSSE('machine:online', { machineNumber, timestamp: now });
      }

      // 如果检测到摄像头掉帧，发送告警
      if (droppingCameras.length > 0) {
        console.warn(`[Camera Alert] ${machineNumber} 摄像头掉帧: ${droppingCameras.map(c => c.camera).join(', ')}`);
        broadcastSSE('camera:dropping', {
          machineNumber,
          cameras: droppingCameras,
          timestamp: now,
        });
      }

      sendJSON(res, {
        success: true,
        machineNumber,
        status: 'online',
        cameraStatus: cameraStatus,
        message: '心跳已接收'
      });
    } catch (error) {
      console.error('[Heartbeat] 处理心跳失败:', error);
      sendJSON(res, { error: '服务器内部错误' }, 500);
    }
  }

  // ==================== 手动标记离线 ====================
  async function handleMarkOffline(req, res, machineNumber) {
    try {
      if (!machineNumber) {
        return sendJSON(res, { error: 'machineNumber 不能为空' }, 400);
      }

      // 从缓存中删除
      heartbeatCache.delete(machineNumber);

      // 更新数据库
      const [rows] = await pool.execute(
        'SELECT data FROM machines WHERE machineNumber = ? ORDER BY updatedAt DESC, id DESC LIMIT 1',
        [machineNumber]
      );

      if (rows.length === 0) {
        return sendJSON(res, { error: '机器不存在' }, 404);
      }

      const currentMachine = JSON.parse(rows[0].data);
      currentMachine.status = 'offline';
      currentMachine.updatedAt = new Date().toISOString();
      currentMachine.updatedBy = 'system';

      await saveMachine(currentMachine);

      console.log(`[Heartbeat] 机器离线: ${machineNumber}`);
      broadcastSSE('machine:offline', {
        machineNumber,
        timestamp: currentMachine.updatedAt
      });

      sendJSON(res, {
        success: true,
        machineNumber,
        status: 'offline',
        message: '已标记为离线'
      });
    } catch (error) {
      console.error('[Heartbeat] 标记离线失败:', error);
      sendJSON(res, { error: '服务器内部错误' }, 500);
    }
  }

  // ==================== 查询心跳监控状态 ====================
  async function handleGetHeartbeatStatus(req, res) {
    try {
      const now = Date.now();
      const status = [];

      for (const [machineNumber, info] of heartbeatCache.entries()) {
        const elapsed = Math.floor((now - info.lastHeartbeat) / 1000);
        status.push({
          machineNumber,
          hostname: info.hostname,
          ipAddress: info.ipAddress,
          lastHeartbeat: info.timestamp,
          elapsedSeconds: elapsed,
          isOnline: elapsed < HEARTBEAT_TIMEOUT,
        });
      }

      // 按最后心跳时间排序
      status.sort((a, b) => b.lastHeartbeat.localeCompare(a.lastHeartbeat));

      sendJSON(res, {
        success: true,
        heartbeatTimeout: HEARTBEAT_TIMEOUT,
        totalMachines: status.length,
        onlineMachines: status.filter(m => m.isOnline).length,
        machines: status,
      });
    } catch (error) {
      console.error('[Heartbeat] 查询状态失败:', error);
      sendJSON(res, { error: '服务器内部错误' }, 500);
    }
  }

  // ==================== 定期检查超时机器 ====================
  async function checkTimeoutMachines() {
    const now = Date.now();
    const timeoutMachines = [];

    for (const [machineNumber, info] of heartbeatCache.entries()) {
      const elapsed = (now - info.lastHeartbeat) / 1000;

      if (elapsed > HEARTBEAT_TIMEOUT) {
        timeoutMachines.push(machineNumber);
      }
    }

    if (timeoutMachines.length > 0) {
      console.log(`[Heartbeat] 检测到 ${timeoutMachines.length} 台超时机器:`, timeoutMachines);

      for (const machineNumber of timeoutMachines) {
        try {
          // 从缓存删除
          heartbeatCache.delete(machineNumber);

          // 更新数据库状态为离线
          const [rows] = await pool.execute(
            'SELECT data FROM machines WHERE machineNumber = ? ORDER BY updatedAt DESC, id DESC LIMIT 1',
            [machineNumber]
          );

          if (rows.length > 0) {
            const machine = JSON.parse(rows[0].data);

            // 只有当前是在线状态才标记离线（避免重复广播）
            if (machine.status === 'online') {
              machine.status = 'offline';
              machine.updatedAt = new Date().toISOString();
              machine.updatedBy = 'timeout-checker';

              await saveMachine(machine);

              console.log(`[Heartbeat] 机器超时离线: ${machineNumber}`);
              broadcastSSE('machine:offline', {
                machineNumber,
                reason: 'heartbeat_timeout',
                timestamp: machine.updatedAt
              });
            }
          }
        } catch (error) {
          console.error(`[Heartbeat] 处理超时机器失败 ${machineNumber}:`, error);
        }
      }
    }
  }

  // 启动定期检查（每30秒检查一次）
  const timeoutCheckInterval = setInterval(checkTimeoutMachines, 30000);

  // 清理函数（用于优雅关闭）
  function cleanup() {
    clearInterval(timeoutCheckInterval);
    console.log('[Heartbeat] 心跳监控已停止');
  }

  return {
    handleReceiveHeartbeat,
    handleMarkOffline,
    handleGetHeartbeatStatus,
    cleanup,
  };
};
