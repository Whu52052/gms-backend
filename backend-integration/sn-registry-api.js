/**
 * SN 注册表 API
 *
 * 提供手套 SN 码的查询、更新、绑定等功能
 * 需要集成到主 server.js 中
 */

const mysql = require('mysql2/promise');

class SNRegistryAPI {
  constructor(dbPool) {
    this.db = dbPool;
  }

  // ==================== 初始化数据表 ====================
  async initDatabase() {
    const createTableSQL = `
      CREATE TABLE IF NOT EXISTS sn_registry (
        id INT AUTO_INCREMENT PRIMARY KEY,
        snCode VARCHAR(50) UNIQUE NOT NULL COMMENT 'SN码，如WGJ001234',
        status VARCHAR(50) DEFAULT 'available' COMMENT '状态：available/in_use/damaged',
        machineNumber VARCHAR(50) DEFAULT NULL COMMENT '绑定的机器编号',
        handType VARCHAR(10) DEFAULT NULL COMMENT '左右手：left/right',
        createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updatedAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_snCode (snCode),
        INDEX idx_machineNumber (machineNumber),
        INDEX idx_status (status)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='手套SN注册表';
    `;

    try {
      await this.db.query(createTableSQL);
      console.log('[SN Registry] 数据表初始化完成');
    } catch (error) {
      console.error('[SN Registry] 数据表初始化失败:', error.message);
      throw error;
    }
  }

  // ==================== 查询单个 SN ====================
  async getSN(snCode) {
    try {
      const [rows] = await this.db.query(
        'SELECT * FROM sn_registry WHERE snCode = ?',
        [snCode]
      );

      if (rows.length === 0) {
        return null;
      }

      return rows[0];
    } catch (error) {
      console.error(`[SN Registry] 查询 ${snCode} 失败:`, error.message);
      throw error;
    }
  }

  // ==================== 查询机器绑定的所有 SN ====================
  async getSNByMachine(machineNumber) {
    try {
      const [rows] = await this.db.query(
        'SELECT * FROM sn_registry WHERE machineNumber = ? AND status = "in_use"',
        [machineNumber]
      );

      return rows;
    } catch (error) {
      console.error(`[SN Registry] 查询机器 ${machineNumber} 的 SN 失败:`, error.message);
      throw error;
    }
  }

  // ==================== 查询所有 SN ====================
  async listSN(filters = {}) {
    try {
      let sql = 'SELECT * FROM sn_registry WHERE 1=1';
      const params = [];

      if (filters.status) {
        sql += ' AND status = ?';
        params.push(filters.status);
      }

      if (filters.machineNumber) {
        sql += ' AND machineNumber = ?';
        params.push(filters.machineNumber);
      }

      sql += ' ORDER BY updatedAt DESC';

      if (filters.limit) {
        sql += ' LIMIT ?';
        params.push(parseInt(filters.limit, 10));
      }

      const [rows] = await this.db.query(sql, params);
      return rows;
    } catch (error) {
      console.error('[SN Registry] 查询列表失败:', error.message);
      throw error;
    }
  }

  // ==================== 注册新 SN ====================
  async registerSN(snData) {
    try {
      const {
        snCode,
        status = 'available',
        machineNumber = null,
        handType = null,
      } = snData;

      // 验证 SN 格式
      if (!snCode || !/^(WGJ|WGK)\d{6}$/.test(snCode)) {
        throw new Error(`无效的 SN 码格式: ${snCode}`);
      }

      // 检查是否已存在
      const existing = await this.getSN(snCode);
      if (existing) {
        throw new Error(`SN 码 ${snCode} 已存在`);
      }

      await this.db.query(
        `INSERT INTO sn_registry (snCode, status, machineNumber, handType)
         VALUES (?, ?, ?, ?)`,
        [snCode, status, machineNumber, handType]
      );

      console.log(`[SN Registry] 注册成功: ${snCode}`);
      return await this.getSN(snCode);
    } catch (error) {
      console.error('[SN Registry] 注册失败:', error.message);
      throw error;
    }
  }

  // ==================== 更新 SN 信息 ====================
  async updateSN(snCode, updates) {
    try {
      const existing = await this.getSN(snCode);
      if (!existing) {
        throw new Error(`SN 码 ${snCode} 不存在`);
      }

      const allowedFields = ['status', 'machineNumber', 'handType'];

      const fields = [];
      const values = [];

      for (const [key, value] of Object.entries(updates)) {
        if (allowedFields.includes(key)) {
          fields.push(`${key} = ?`);
          values.push(value);
        }
      }

      if (fields.length === 0) {
        throw new Error('没有可更新的字段');
      }

      values.push(snCode);

      await this.db.query(
        `UPDATE sn_registry SET ${fields.join(', ')} WHERE snCode = ?`,
        values
      );

      console.log(`[SN Registry] 更新成功: ${snCode}`);
      return await this.getSN(snCode);
    } catch (error) {
      console.error('[SN Registry] 更新失败:', error.message);
      throw error;
    }
  }

  // ==================== 绑定 SN 到机器 ====================
  async bindSNToMachine(snCode, machineNumber, handType) {
    try {
      const sn = await this.getSN(snCode);
      if (!sn) {
        throw new Error(`SN 码 ${snCode} 不存在`);
      }

      // 检查是否已绑定到其他机器
      if (sn.status === 'in_use' && sn.machineNumber !== machineNumber) {
        throw new Error(`SN 码 ${snCode} 已绑定到机器 ${sn.machineNumber}`);
      }

      // 检查状态
      if (sn.status === 'damaged') {
        throw new Error(`SN 码 ${snCode} 已损坏，无法绑定`);
      }

      if (sn.status === 'in_repair') {
        throw new Error(`SN 码 ${snCode} 维修中，无法绑定`);
      }

      // 执行绑定
      await this.updateSN(snCode, {
        status: 'in_use',
        machineNumber,
        handType,
      });

      console.log(`[SN Registry] 绑定成功: ${snCode} -> ${machineNumber} (${handType})`);
      return await this.getSN(snCode);
    } catch (error) {
      console.error('[SN Registry] 绑定失败:', error.message);
      throw error;
    }
  }

  // ==================== 解绑 SN ====================
  async unbindSN(snCode) {
    try {
      const sn = await this.getSN(snCode);
      if (!sn) {
        throw new Error(`SN 码 ${snCode} 不存在`);
      }

      await this.updateSN(snCode, {
        status: 'available',
        machineNumber: null,
        handType: null,
      });

      console.log(`[SN Registry] 解绑成功: ${snCode}`);
      return await this.getSN(snCode);
    } catch (error) {
      console.error('[SN Registry] 解绑失败:', error.message);
      throw error;
    }
  }

  // ==================== 标记为损坏 ====================
  async markAsDamaged(snCode, damageReason) {
    try {
      await this.updateSN(snCode, {
        status: 'damaged',
        damageReason,
        machineNumber: null,
        handType: null,
      });

      console.log(`[SN Registry] 标记为损坏: ${snCode}`);
      return await this.getSN(snCode);
    } catch (error) {
      console.error('[SN Registry] 标记失败:', error.message);
      throw error;
    }
  }

  // ==================== 删除 SN ====================
  async deleteSN(snCode) {
    try {
      const result = await this.db.query(
        'DELETE FROM sn_registry WHERE snCode = ?',
        [snCode]
      );

      if (result[0].affectedRows === 0) {
        throw new Error(`SN 码 ${snCode} 不存在`);
      }

      console.log(`[SN Registry] 删除成功: ${snCode}`);
      return true;
    } catch (error) {
      console.error('[SN Registry] 删除失败:', error.message);
      throw error;
    }
  }

  // ==================== Express 路由处理 ====================
  setupRoutes(app) {
    // GET /api/sn-registry/:snCode - 查询单个 SN
    app.get('/api/sn-registry/:snCode', async (req, res) => {
      try {
        const sn = await this.getSN(req.params.snCode);
        if (!sn) {
          return res.status(404).json({ error: 'SN 码不存在' });
        }
        res.json(sn);
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // GET /api/sn-registry - 查询 SN 列表
    app.get('/api/sn-registry', async (req, res) => {
      try {
        const filters = {
          status: req.query.status,
          machineNumber: req.query.machineNumber,
          equipmentType: req.query.equipmentType,
          limit: req.query.limit,
        };
        const list = await this.listSN(filters);
        res.json({ total: list.length, items: list });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // POST /api/sn-registry - 注册新 SN
    app.post('/api/sn-registry', async (req, res) => {
      try {
        const sn = await this.registerSN(req.body);
        res.status(201).json(sn);
      } catch (error) {
        res.status(400).json({ error: error.message });
      }
    });

    // PUT /api/sn-registry/:snCode - 更新 SN 信息
    app.put('/api/sn-registry/:snCode', async (req, res) => {
      try {
        const sn = await this.updateSN(req.params.snCode, req.body);
        res.json(sn);
      } catch (error) {
        res.status(400).json({ error: error.message });
      }
    });

    // POST /api/sn-registry/:snCode/bind - 绑定到机器
    app.post('/api/sn-registry/:snCode/bind', async (req, res) => {
      try {
        const { machineNumber, handType } = req.body;
        if (!machineNumber || !handType) {
          return res.status(400).json({ error: '缺少必要参数' });
        }
        const sn = await this.bindSNToMachine(req.params.snCode, machineNumber, handType);
        res.json(sn);
      } catch (error) {
        res.status(400).json({ error: error.message });
      }
    });

    // POST /api/sn-registry/:snCode/unbind - 解绑
    app.post('/api/sn-registry/:snCode/unbind', async (req, res) => {
      try {
        const sn = await this.unbindSN(req.params.snCode);
        res.json(sn);
      } catch (error) {
        res.status(400).json({ error: error.message });
      }
    });

    // POST /api/sn-registry/:snCode/damage - 标记为损坏
    app.post('/api/sn-registry/:snCode/damage', async (req, res) => {
      try {
        const { damageReason } = req.body;
        const sn = await this.markAsDamaged(req.params.snCode, damageReason);
        res.json(sn);
      } catch (error) {
        res.status(400).json({ error: error.message });
      }
    });

    // DELETE /api/sn-registry/:snCode - 删除 SN
    app.delete('/api/sn-registry/:snCode', async (req, res) => {
      try {
        await this.deleteSN(req.params.snCode);
        res.json({ message: '删除成功' });
      } catch (error) {
        res.status(400).json({ error: error.message });
      }
    });

    console.log('[SN Registry API] 路由注册完成');
  }
}

module.exports = SNRegistryAPI;
