/**
 * src/handlers/replacement.js
 * 手套置换（置换库存）Domain Handlers
 *
 * 流程：
 *   1. 加入置换库存（add）    : sn_registry.status = 'replacement'（暂时无法使用）
 *   2. 退回库存（return）     : sn_registry.status = 'available'（恢复可用）
 *   3. 发货厂家（ship）       : sn_registry.status = 'retired'（该 SN 报废，不再使用）
 *
 * Factory / Dependency Injection pattern:
 *   module.exports = function createReplacementHandlers(deps) { ... return handlers }
 */
'use strict';

const crypto = require('crypto');
const { canWrite } = require('./_permissions');

module.exports = function createReplacementHandlers(deps) {
  const { pool, sendJSON, _syncInventoryFromSN, _insertTransaction, broadcastChange } = deps;

  function _canWrite(authUser) { return canWrite(authUser); }

  async function _recordHistory(snCode, oldStatus, newStatus, reason, authUser) {
    const id = 'h-' + Date.now() + '-' + crypto.randomBytes(4).toString('hex');
    await pool.execute(
      'INSERT INTO sn_status_history (id, snCode, oldStatus, newStatus, operator, reason, createdAt) VALUES (?,?,?,?,?,?,?)',
      [id, snCode, oldStatus, newStatus, authUser.displayName || authUser.username, reason || '', new Date().toISOString()]
    );
  }

  // 加入置换库存
  async function handleAddReplacement(req, res, authUser) {
    try {
      if (!_canWrite(authUser)) return sendJSON(res, { error: '无权限' }, 403);
      const body = req.body || {};
      const code = String(body.snCode || '').trim().toUpperCase();
      if (!code) return sendJSON(res, { error: 'SN 码不能为空' }, 400);

      const [rows] = await pool.execute('SELECT * FROM sn_registry WHERE snCode = ?', [code]);
      if (rows.length === 0) return sendJSON(res, { error: `未找到 SN ${code}` }, 404);
      const sn = rows[0];
      if (sn.status === 'replacement') return sendJSON(res, { error: `SN ${code} 已在置换库存中` }, 400);
      if (sn.status === 'retired') return sendJSON(res, { error: `SN ${code} 已发货厂家（报废），不可再操作` }, 400);

      const now = new Date().toISOString();
      const rid = 'r-' + Date.now() + '-' + crypto.randomBytes(4).toString('hex');

      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        await conn.execute('UPDATE sn_registry SET status = ?, updatedAt = ? WHERE snCode = ?', ['replacement', now, code]);
        await conn.execute(
          `INSERT INTO replacements (id, snCode, equipmentType, handType, status, operator, note, createdAt, updatedAt)
           VALUES (?, ?, ?, ?, 'in_replacement', ?, ?, ?, ?)`,
          [rid, code, sn.equipmentType, sn.handType, authUser.username, body.note || '', now, now]
        );
        await _recordHistory(code, sn.status, 'replacement', body.note || '加入置换库存', authUser);
        await conn.commit();
      } catch (e) {
        await conn.rollback();
        throw e;
      } finally {
        conn.release();
      }

      try { await _syncInventoryFromSN(pool); } catch (e) { console.error('[Replacement] sync inventory:', e.message); }
      broadcastChange('sn_registry', ['inventory', 'replacements']);
      sendJSON(res, { success: true, snCode: code, status: 'replacement' });
    } catch (e) {
      sendJSON(res, { error: e.message }, 500);
    }
  }

  // 退回库存
  async function handleReturnReplacement(req, res, authUser) {
    try {
      if (!_canWrite(authUser)) return sendJSON(res, { error: '无权限' }, 403);
      const body = req.body || {};
      const code = String(body.snCode || '').trim().toUpperCase();
      if (!code) return sendJSON(res, { error: 'SN 码不能为空' }, 400);

      const [rows] = await pool.execute('SELECT * FROM sn_registry WHERE snCode = ?', [code]);
      if (rows.length === 0) return sendJSON(res, { error: `未找到 SN ${code}` }, 404);
      const sn = rows[0];
      if (sn.status !== 'replacement') return sendJSON(res, { error: `SN ${code} 不在置换库存中` }, 400);

      const now = new Date().toISOString();
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        await conn.execute('UPDATE sn_registry SET status = ?, updatedAt = ? WHERE snCode = ?', ['available', now, code]);
        await conn.execute(
          "UPDATE replacements SET status = 'returned', note = IF(note IS NULL OR note = '', ?, CONCAT(note, ' | ', ?)), updatedAt = ? WHERE snCode = ? AND status = 'in_replacement'",
          [body.note || '退回库存', body.note || '退回库存', now, code]
        );
        await _recordHistory(code, 'replacement', 'available', body.note || '退回库存', authUser);
        await conn.commit();
      } catch (e) {
        await conn.rollback();
        throw e;
      } finally {
        conn.release();
      }

      try { await _syncInventoryFromSN(pool); } catch (e) { console.error('[Replacement] sync inventory:', e.message); }
      broadcastChange('sn_registry', ['inventory', 'replacements']);
      sendJSON(res, { success: true, snCode: code, status: 'available' });
    } catch (e) {
      sendJSON(res, { error: e.message }, 500);
    }
  }

  // 发货厂家（SN 报废）
  async function handleShipReplacement(req, res, authUser) {
    try {
      if (!_canWrite(authUser)) return sendJSON(res, { error: '无权限' }, 403);
      const body = req.body || {};
      const code = String(body.snCode || '').trim().toUpperCase();
      if (!code) return sendJSON(res, { error: 'SN 码不能为空' }, 400);

      const [rows] = await pool.execute('SELECT * FROM sn_registry WHERE snCode = ?', [code]);
      if (rows.length === 0) return sendJSON(res, { error: `未找到 SN ${code}` }, 404);
      const sn = rows[0];
      if (sn.status !== 'replacement') return sendJSON(res, { error: `SN ${code} 不在置换库存中，无法发货` }, 400);

      const now = new Date().toISOString();
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        await conn.execute('UPDATE sn_registry SET status = ?, trackingNumber = ?, shippedAt = ?, updatedAt = ? WHERE snCode = ?',
          ['retired', body.trackingNumber || null, now, now, code]);
        await conn.execute(
          "UPDATE replacements SET status = 'sent_to_manufacturer', note = IF(note IS NULL OR note = '', ?, CONCAT(note, ' | ', ?)), updatedAt = ? WHERE snCode = ? AND status = 'in_replacement'",
          [body.note || '发货厂家', body.note || '发货厂家', now, code]
        );
        await _recordHistory(code, 'replacement', 'retired', body.note || '发货厂家（SN 报废）', authUser);
        if (_insertTransaction) {
          await _insertTransaction(conn, {
            direction: 'out',
            type: 'replacement_ship',
            quantity: 1,
            operator: authUser.username,
            note: `置换发货厂家: ${code}${body.trackingNumber ? ' 运单号:' + body.trackingNumber : ''}`,
          });
        }
        await conn.commit();
      } catch (e) {
        await conn.rollback();
        throw e;
      } finally {
        conn.release();
      }

      try { await _syncInventoryFromSN(pool); } catch (e) { console.error('[Replacement] sync inventory:', e.message); }
      broadcastChange('sn_registry', ['inventory', 'transactions', 'replacements']);
      sendJSON(res, { success: true, snCode: code, status: 'retired' });
    } catch (e) {
      sendJSON(res, { error: e.message }, 500);
    }
  }

  // 置换列表
  async function handleListReplacements(req, res, authUser) {
    try {
      const [rows] = await pool.execute(
        `SELECT r.*, s.status AS snStatus, s.machineNumber, s.trackingNumber
         FROM replacements r
         LEFT JOIN sn_registry s ON s.snCode = r.snCode
         ORDER BY r.createdAt DESC`
      );
      sendJSON(res, rows);
    } catch (e) {
      sendJSON(res, { error: e.message }, 500);
    }
  }

  // 批量加入置换库存（按来源）：将所有指定 source 的手套加入置换库存
  async function handleBatchAddReplacementBySource(req, res, authUser) {
    try {
      if (!_canWrite(authUser)) return sendJSON(res, { error: '无权限' }, 403);
      const body = req.body || {};
      const source = (body.source || '采购').trim();
      if (!source) return sendJSON(res, { error: '来源不能为空' }, 400);

      // 查询所有指定 source 的 SN，排除已置换或已报废的
      const [rows] = await pool.execute(
        "SELECT snCode, equipmentType, handType, status FROM sn_registry WHERE source = ? AND status NOT IN ('replacement', 'retired')",
        [source]
      );
      if (rows.length === 0) {
        return sendJSON(res, { success: true, total: 0, processed: 0, message: `没有找到来源为"${source}"且未在置换库存中的手套` });
      }

      const now = new Date().toISOString();
      let processed = 0, errors = [];

      for (const sn of rows) {
        try {
          const rid = 'r-' + Date.now() + '-' + crypto.randomBytes(4).toString('hex');
          const conn = await pool.getConnection();
          try {
            await conn.beginTransaction();
            await conn.execute('UPDATE sn_registry SET status = ?, updatedAt = ? WHERE snCode = ?', ['replacement', now, sn.snCode]);
            await conn.execute(
              `INSERT INTO replacements (id, snCode, equipmentType, handType, status, operator, note, createdAt, updatedAt)
               VALUES (?, ?, ?, ?, 'in_replacement', ?, ?, ?, ?)`,
              [rid, sn.snCode, sn.equipmentType, sn.handType, authUser.username, `批量导入: 来源=${source}`, now, now]
            );
            await _recordHistory(sn.snCode, sn.status, 'replacement', `批量加入置换库存(来源=${source})`, authUser);
            await conn.commit();
            processed++;
          } catch (e) {
            await conn.rollback();
            errors.push({ snCode: sn.snCode, error: e.message });
          } finally {
            conn.release();
          }
        } catch (e) {
          errors.push({ snCode: sn.snCode, error: e.message });
        }
      }

      try { await _syncInventoryFromSN(pool); } catch (e) { console.error('[BatchReplacement] sync inventory:', e.message); }
      broadcastChange('sn_registry', ['inventory', 'replacements']);

      sendJSON(res, {
        success: true,
        source: source,
        total: rows.length,
        processed: processed,
        errors: errors.length > 0 ? errors : undefined,
        message: `来源"${source}"共 ${rows.length} 条，成功处理 ${processed} 条` + (errors.length > 0 ? `，${errors.length} 条失败` : ''),
      });
    } catch (e) {
      sendJSON(res, { error: e.message }, 500);
    }
  }

  return {
    handleAddReplacement,
    handleReturnReplacement,
    handleShipReplacement,
    handleListReplacements,
    handleBatchAddReplacementBySource,
  };
};