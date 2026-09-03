#!/usr/bin/env node
/**
 * 机器状态查询 API
 *
 * 功能：
 * 1. 查询单台机器的最新心跳数据（设备状态、摄像头、手套等）
 * 2. 触发远程设备检测（通过 WebSocket 或 HTTP 回调）
 * 3. 机器健康度评分
 * 4. 历史状态查询
 */

const express = require('express');
const mysql = require('mysql2/promise');

class MachineStatusAPI {
  constructor(options = {}) {
    this.dbConfig = options.dbConfig || {
      host: 'localhost',
      port: 3306,
      user: 'gms',
      password: 'gms123',
      database: 'gms',
    };

    this.pool = null;
  }

  // ==================== 初始化数据库连接池 ====================
  async initialize() {
    this.pool = mysql.createPool({
      ...this.dbConfig,
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0,
    });

    console.log('[Machine Status API] 数据库连接池已创建');

    // 确保表结构存在
    await this.ensureTables();
  }

  // ==================== 确保表结构存在 ====================
  async ensureTables() {
    const connection = await this.pool.getConnection();

    try {
      // 心跳数据表（存储完整的心跳 JSON）
      await connection.query(`
        CREATE TABLE IF NOT EXISTS machine_heartbeats (
          id INT PRIMARY KEY AUTO_INCREMENT,
          machineNumber VARCHAR(50) NOT NULL,
          heartbeatData JSON NOT NULL,
          receivedAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          INDEX idx_machine (machineNumber),
          INDEX idx_time (receivedAt)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
      `);

      // 机器状态摘要表（最新状态快照，用于快速查询）
      await connection.query(`
        CREATE TABLE IF NOT EXISTS machine_status_summary (
          machineNumber VARCHAR(50) PRIMARY KEY,
          machineType VARCHAR(50),
          status VARCHAR(50) DEFAULT 'online',
          healthScore INT DEFAULT 100,
          lastHeartbeat TIMESTAMP,
          devices JSON,
          cameras JSON,
          gloves JSON,
          updatedAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
      `);

      console.log('[Machine Status API] 数据库表结构检查完成');
    } finally {
      connection.release();
    }
  }

  // ==================== 接收心跳并更新状态 ====================
  async receiveHeartbeat(heartbeatData) {
    const connection = await this.pool.getConnection();

    try {
      const { machineNumber } = heartbeatData;

      // 1. 存储完整心跳数据
      await connection.query(
        'INSERT INTO machine_heartbeats (machineNumber, heartbeatData) VALUES (?, ?)',
        [machineNumber, JSON.stringify(heartbeatData)]
      );

      // 2. 计算健康度评分
      const healthScore = this.calculateHealthScore(heartbeatData);

      // 3. 更新状态摘要
      await connection.query(`
        INSERT INTO machine_status_summary
        (machineNumber, machineType, status, healthScore, lastHeartbeat, devices, cameras, gloves)
        VALUES (?, ?, 'online', ?, NOW(), ?, ?, ?)
        ON DUPLICATE KEY UPDATE
          machineType = VALUES(machineType),
          status = 'online',
          healthScore = VALUES(healthScore),
          lastHeartbeat = NOW(),
          devices = VALUES(devices),
          cameras = VALUES(cameras),
          gloves = VALUES(gloves)
      `, [
        machineNumber,
        heartbeatData.devices?.machineType || 'unknown',
        healthScore,
        JSON.stringify(heartbeatData.devices || {}),
        JSON.stringify(heartbeatData.cameras || []),
        JSON.stringify(heartbeatData.gloves || {}),
      ]);

      console.log(`[Machine Status API] 心跳已更新: ${machineNumber}, 健康度: ${healthScore}%`);

      return { success: true, healthScore };
    } finally {
      connection.release();
    }
  }

  // ==================== 计算健康度评分 ====================
  calculateHealthScore(heartbeatData) {
    let score = 0;
    let maxScore = 0;

    const { devices, cameras, gloves } = heartbeatData;

    // 手套（必需，每个20分）
    maxScore += 40;
    if (gloves?.left?.connected) score += 20;
    if (gloves?.right?.connected) score += 20;

    // 手套 SN 验证（每个5分）
    maxScore += 10;
    if (gloves?.left?.validation?.valid) score += 5;
    if (gloves?.right?.validation?.valid) score += 5;

    // Quest（必需，20分）
    maxScore += 20;
    if (devices?.quest?.connected) {
      score += 20;
      // Quest 电量低扣分
      if (devices.quest.battery && devices.quest.battery < 20) {
        score -= 5;
      }
    }

    // 摄像头（10分）
    maxScore += 10;
    if (cameras && cameras.length > 0) {
      const workingCameras = cameras.filter(c => c.status === 'ok');
      score += Math.floor((workingCameras.length / cameras.length) * 10);
    }

    // 灵巧手机器的额外设备
    if (devices?.machineType === 'dexterous') {
      // 灵巧手（每个10分）
      maxScore += 20;
      if (devices.dexterousHands?.left) score += 10;
      if (devices.dexterousHands?.right) score += 10;

      // 机械臂（10分）
      maxScore += 10;
      if (devices.roboticArm?.connected) score += 10;
    }

    return maxScore > 0 ? Math.round((score / maxScore) * 100) : 0;
  }

  // ==================== 查询单台机器的最新状态 ====================
  async getMachineStatus(machineNumber) {
    const connection = await this.pool.getConnection();

    try {
      // 查询状态摘要
      const [rows] = await connection.query(
        'SELECT * FROM machine_status_summary WHERE machineNumber = ?',
        [machineNumber]
      );

      if (rows.length === 0) {
        return null;
      }

      const summary = rows[0];

      // 判断是否离线（超过2分钟没有心跳）
      const now = new Date();
      const lastHeartbeat = new Date(summary.lastHeartbeat);
      const offlineThreshold = 2 * 60 * 1000; // 2分钟

      if (now - lastHeartbeat > offlineThreshold) {
        summary.status = 'offline';
      }

      return {
        machineNumber: summary.machineNumber,
        machineType: summary.machineType,
        status: summary.status,
        healthScore: summary.healthScore,
        lastHeartbeat: summary.lastHeartbeat,
        devices: summary.devices,
        cameras: summary.cameras,
        gloves: summary.gloves,
        updatedAt: summary.updatedAt,
      };
    } finally {
      connection.release();
    }
  }

  // ==================== 查询所有机器状态列表 ====================
  async listMachines(filters = {}) {
    const connection = await this.pool.getConnection();

    try {
      let sql = 'SELECT * FROM machine_status_summary WHERE 1=1';
      const params = [];

      if (filters.status) {
        sql += ' AND status = ?';
        params.push(filters.status);
      }

      if (filters.machineType) {
        sql += ' AND machineType = ?';
        params.push(filters.machineType);
      }

      sql += ' ORDER BY lastHeartbeat DESC';

      if (filters.limit) {
        sql += ' LIMIT ?';
        params.push(parseInt(filters.limit, 10));
      }

      const [rows] = await connection.query(sql, params);

      // 更新离线状态
      const now = new Date();
      const offlineThreshold = 2 * 60 * 1000;

      return rows.map(row => {
        const lastHeartbeat = new Date(row.lastHeartbeat);
        if (now - lastHeartbeat > offlineThreshold) {
          row.status = 'offline';
        }

        return {
          machineNumber: row.machineNumber,
          machineType: row.machineType,
          status: row.status,
          healthScore: row.healthScore,
          lastHeartbeat: row.lastHeartbeat,
          updatedAt: row.updatedAt,
        };
      });
    } finally {
      connection.release();
    }
  }

  // ==================== 查询机器历史心跳 ====================
  async getMachineHistory(machineNumber, options = {}) {
    const connection = await this.pool.getConnection();

    try {
      const limit = options.limit || 100;
      const offset = options.offset || 0;

      const [rows] = await connection.query(
        `SELECT heartbeatData, receivedAt
         FROM machine_heartbeats
         WHERE machineNumber = ?
         ORDER BY receivedAt DESC
         LIMIT ? OFFSET ?`,
        [machineNumber, limit, offset]
      );

      return rows.map(row => ({
        data: row.heartbeatData,
        receivedAt: row.receivedAt,
      }));
    } finally {
      connection.release();
    }
  }

  // ==================== 触发远程设备检测 ====================
  async triggerDeviceCheck(machineNumber) {
    // 这里有两种实现方式：
    // 1. WebSocket：如果心跳客户端维护 WebSocket 连接
    // 2. HTTP 回调：客户端定期轮询检测请求

    // 方案1: 存储检测请求到数据库，客户端轮询
    const connection = await this.pool.getConnection();

    try {
      // 创建检测请求表（如果不存在）
      await connection.query(`
        CREATE TABLE IF NOT EXISTS device_check_requests (
          id INT PRIMARY KEY AUTO_INCREMENT,
          machineNumber VARCHAR(50) NOT NULL,
          status VARCHAR(50) DEFAULT 'pending',
          createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          completedAt TIMESTAMP NULL,
          result JSON NULL,
          INDEX idx_machine_status (machineNumber, status)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
      `);

      // 插入检测请求
      const [result] = await connection.query(
        'INSERT INTO device_check_requests (machineNumber) VALUES (?)',
        [machineNumber]
      );

      console.log(`[Machine Status API] 已创建设备检测请求: ${machineNumber}, ID: ${result.insertId}`);

      return {
        success: true,
        requestId: result.insertId,
        message: '设备检测请求已创建，等待客户端执行',
      };
    } finally {
      connection.release();
    }
  }

  // ==================== 客户端轮询检测请求 ====================
  async pollCheckRequests(machineNumber) {
    const connection = await this.pool.getConnection();

    try {
      const [rows] = await connection.query(
        `SELECT id FROM device_check_requests
         WHERE machineNumber = ? AND status = 'pending'
         ORDER BY createdAt ASC LIMIT 1`,
        [machineNumber]
      );

      if (rows.length === 0) {
        return null;
      }

      const requestId = rows[0].id;

      // 标记为处理中
      await connection.query(
        'UPDATE device_check_requests SET status = ? WHERE id = ?',
        ['processing', requestId]
      );

      return { requestId };
    } finally {
      connection.release();
    }
  }

  // ==================== 客户端提交检测结果 ====================
  async submitCheckResult(requestId, result) {
    const connection = await this.pool.getConnection();

    try {
      await connection.query(
        `UPDATE device_check_requests
         SET status = 'completed', completedAt = NOW(), result = ?
         WHERE id = ?`,
        [JSON.stringify(result), requestId]
      );

      console.log(`[Machine Status API] 设备检测完成: 请求ID ${requestId}`);

      return { success: true };
    } finally {
      connection.release();
    }
  }

  // ==================== 查询检测结果 ====================
  async getCheckResult(requestId) {
    const connection = await this.pool.getConnection();

    try {
      const [rows] = await connection.query(
        'SELECT * FROM device_check_requests WHERE id = ?',
        [requestId]
      );

      if (rows.length === 0) {
        return null;
      }

      return rows[0];
    } finally {
      connection.release();
    }
  }

  // ==================== 创建 Express 路由 ====================
  createRouter() {
    const router = express.Router();

    // 1. 接收心跳
    router.post('/heartbeat', async (req, res) => {
      try {
        const result = await this.receiveHeartbeat(req.body);
        res.json(result);
      } catch (error) {
        console.error('[Machine Status API] 接收心跳失败:', error);
        res.status(500).json({ error: error.message });
      }
    });

    // 2. 查询单台机器状态
    router.get('/machines/:machineNumber', async (req, res) => {
      try {
        const status = await this.getMachineStatus(req.params.machineNumber);
        if (!status) {
          return res.status(404).json({ error: '机器不存在或未上线' });
        }
        res.json(status);
      } catch (error) {
        console.error('[Machine Status API] 查询失败:', error);
        res.status(500).json({ error: error.message });
      }
    });

    // 3. 查询所有机器列表
    router.get('/machines', async (req, res) => {
      try {
        const machines = await this.listMachines(req.query);
        res.json(machines);
      } catch (error) {
        console.error('[Machine Status API] 查询失败:', error);
        res.status(500).json({ error: error.message });
      }
    });

    // 4. 查询机器历史心跳
    router.get('/machines/:machineNumber/history', async (req, res) => {
      try {
        const history = await this.getMachineHistory(
          req.params.machineNumber,
          { limit: req.query.limit, offset: req.query.offset }
        );
        res.json(history);
      } catch (error) {
        console.error('[Machine Status API] 查询历史失败:', error);
        res.status(500).json({ error: error.message });
      }
    });

    // 5. 触发设备检测
    router.post('/machines/:machineNumber/check', async (req, res) => {
      try {
        const result = await this.triggerDeviceCheck(req.params.machineNumber);
        res.json(result);
      } catch (error) {
        console.error('[Machine Status API] 触发检测失败:', error);
        res.status(500).json({ error: error.message });
      }
    });

    // 6. 查询检测结果
    router.get('/check-requests/:requestId', async (req, res) => {
      try {
        const result = await this.getCheckResult(req.params.requestId);
        if (!result) {
          return res.status(404).json({ error: '检测请求不存在' });
        }
        res.json(result);
      } catch (error) {
        console.error('[Machine Status API] 查询检测结果失败:', error);
        res.status(500).json({ error: error.message });
      }
    });

    // 7. 客户端轮询检测请求
    router.get('/poll-check/:machineNumber', async (req, res) => {
      try {
        const request = await this.pollCheckRequests(req.params.machineNumber);
        res.json(request || { requestId: null });
      } catch (error) {
        console.error('[Machine Status API] 轮询失败:', error);
        res.status(500).json({ error: error.message });
      }
    });

    // 8. 客户端提交检测结果
    router.post('/check-requests/:requestId/result', async (req, res) => {
      try {
        const result = await this.submitCheckResult(req.params.requestId, req.body);
        res.json(result);
      } catch (error) {
        console.error('[Machine Status API] 提交结果失败:', error);
        res.status(500).json({ error: error.message });
      }
    });

    return router;
  }
}

module.exports = MachineStatusAPI;

// ==================== 独立运行测试服务器 ====================
if (require.main === module) {
  const app = express();
  app.use(express.json());

  const api = new MachineStatusAPI();

  (async () => {
    await api.initialize();

    app.use('/api', api.createRouter());

    const PORT = process.env.PORT || 8765;
    app.listen(PORT, () => {
      console.log(`[Machine Status API] 服务器运行在 http://localhost:${PORT}`);
      console.log('');
      console.log('API 端点:');
      console.log(`  POST   /api/heartbeat                          - 接收心跳`);
      console.log(`  GET    /api/machines                           - 查询所有机器`);
      console.log(`  GET    /api/machines/:machineNumber            - 查询单台机器状态`);
      console.log(`  GET    /api/machines/:machineNumber/history    - 查询历史心跳`);
      console.log(`  POST   /api/machines/:machineNumber/check      - 触发设备检测`);
      console.log(`  GET    /api/check-requests/:requestId          - 查询检测结果`);
      console.log(`  GET    /api/poll-check/:machineNumber          - 客户端轮询检测请求`);
      console.log(`  POST   /api/check-requests/:requestId/result   - 客户端提交检测结果`);
    });
  })();
}
