/**
 * src/handlers/storage-locations.js
 * 库位管理 HTTP handlers
 *
 * 管理仓储库位（storage locations）以及 SN 码与库位的关联。
 *
 * API:
 *   GET    /api/storage-locations              → handleGetAll
 *   POST   /api/storage-locations              → handleCreate
 *   PUT    /api/storage-locations/:code        → handleUpdate
 *   DELETE /api/storage-locations/:code        → handleDelete
 *   GET    /api/storage-locations/:code/sns    → handleGetLocationSNs
 *
 * Deps: pool, sendJSON, broadcastChange
 */
'use strict';

const { requireAdmin } = require('./_permissions');

module.exports = function createStorageLocationsHandlers(deps) {
  const { pool, sendJSON, broadcastChange } = deps;

  // ==================== GET ALL ====================
  async function handleGetAll(req, res, authUser) {
    try {
      const [rows] = await pool.execute(
        'SELECT * FROM storage_locations ORDER BY area, code'
      );
      // 为每个库位统计关联的 SN 数量
      const codes = rows.map(r => r.code);
      let counts = {};
      if (codes.length > 0) {
        const placeholders = codes.map(() => '?').join(',');
        const [snRows] = await pool.execute(
          `SELECT location_code, COUNT(*) AS cnt FROM sn_registry WHERE location_code IN (${placeholders}) GROUP BY location_code`,
          codes
        );
        snRows.forEach(r => { counts[r.location_code] = r.cnt; });
      }
      const result = rows.map(r => ({
        ...r,
        snCount: counts[r.code] || 0,
      }));
      sendJSON(res, result);
    } catch (e) {
      sendJSON(res, { error: e.message }, 500);
    }
  }

  // ==================== CREATE ====================
  async function handleCreate(req, res, authUser, body) {
    if (!requireAdmin(authUser, res, sendJSON, '仅管理员可创建库位')) return;
    const { code, name, area, description } = body;
    if (!code || !code.trim()) {
      return sendJSON(res, { error: '库位编码不能为空' }, 400);
    }
    const now = new Date().toISOString();
    try {
      await pool.execute(
        'INSERT INTO storage_locations (code, name, area, description, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)',
        [code.trim(), (name || '').trim(), (area || '').trim(), (description || '').trim(), now, now]
      );
      broadcastChange('storage_locations');
      sendJSON(res, { success: true });
    } catch (e) {
      if (e.code === 'ER_DUP_ENTRY') {
        return sendJSON(res, { error: '库位编码已存在' }, 409);
      }
      sendJSON(res, { error: e.message }, 500);
    }
  }

  // ==================== UPDATE ====================
  async function handleUpdate(req, res, authUser, body, code) {
    if (!requireAdmin(authUser, res, sendJSON, '仅管理员可更新库位')) return;
    const { name, area, description } = body;
    const now = new Date().toISOString();
    try {
      const [existing] = await pool.execute('SELECT * FROM storage_locations WHERE code = ?', [code]);
      if (existing.length === 0) {
        return sendJSON(res, { error: '库位不存在' }, 404);
      }
      await pool.execute(
        'UPDATE storage_locations SET name = ?, area = ?, description = ?, updatedAt = ? WHERE code = ?',
        [(name !== undefined ? name : existing[0].name), (area !== undefined ? area : existing[0].area), (description !== undefined ? description : existing[0].description), now, code]
      );
      broadcastChange('storage_locations');
      sendJSON(res, { success: true });
    } catch (e) {
      sendJSON(res, { error: e.message }, 500);
    }
  }

  // ==================== DELETE ====================
  async function handleDelete(req, res, authUser, code) {
    if (!requireAdmin(authUser, res, sendJSON, '仅管理员可删除库位')) return;
    try {
      // 先解除该库位下所有 SN 的关联
      await pool.execute('UPDATE sn_registry SET location_code = NULL WHERE location_code = ?', [code]);
      await pool.execute('DELETE FROM storage_locations WHERE code = ?', [code]);
      broadcastChange('storage_locations', ['sn_registry']);
      sendJSON(res, { success: true });
    } catch (e) {
      sendJSON(res, { error: e.message }, 500);
    }
  }

  // ==================== GET SNs AT LOCATION ====================
  async function handleGetLocationSNs(req, res, authUser, code) {
    try {
      const [rows] = await pool.execute(
        'SELECT snCode, equipmentType, handType, status, machineNumber, source, updatedAt FROM sn_registry WHERE location_code = ? ORDER BY snCode',
        [code]
      );
      sendJSON(res, rows);
    } catch (e) {
      sendJSON(res, { error: e.message }, 500);
    }
  }

  // ==================== PUBLIC LOCATION STATUS (分享链接,免登录) ====================
  // 供 location-status.html 分享页使用：返回库位信息 + 该库位设备列表
  async function handleGetPublicLocationStatus(req, res, code) {
    try {
      const [locRows] = await pool.execute(
        'SELECT code, name, area, description, createdAt, updatedAt FROM storage_locations WHERE code = ?',
        [code]
      );
      if (locRows.length === 0) {
        return sendJSON(res, { error: '未找到该库位' }, 404);
      }
      const loc = locRows[0];
      const [snRows] = await pool.execute(
        'SELECT snCode, equipmentType, handType, status, machineNumber, source, updatedAt FROM sn_registry WHERE location_code = ? ORDER BY snCode',
        [code]
      );
      sendJSON(res, {
        success: true,
        location: {
          code: loc.code,
          name: loc.name,
          area: loc.area,
          description: loc.description,
          snCount: snRows.length,
          updatedAt: loc.updatedAt,
        },
        devices: snRows,
      });
    } catch (e) {
      sendJSON(res, { error: e.message }, 500);
    }
  }

  return {
    handleGetAll,
    handleCreate,
    handleUpdate,
    handleDelete,
    handleGetLocationSNs,
    handleGetPublicLocationStatus,
  };
};