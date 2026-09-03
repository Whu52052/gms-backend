/**
 * src/handlers/warehouse-transfers.js
 * 跨仓库调拨域（Phase 2）—— 发起 / 审批 / 拒绝，事务内移库 + 批次同步 + 流水 + 审计
 *
 * Handlers in this domain (URL → handler):
 *   GET  /api/warehouse-transfers                → handleList       （登录可看）
 *   POST /api/warehouse-transfers                → handleCreate     （inventory:transfer）
 *   POST /api/warehouse-transfers/:id/approve    → handleApprove    （inventory:transfer，审批人≠发起人，超管除外）
 *   POST /api/warehouse-transfers/:id/reject     → handleReject     （inventory:transfer）
 *
 * 流程：发起(pending) → 审批通过(事务内：源仓-qty、目标仓+qty、批次FIFO转移、流水、审计)
 *       或拒绝(rejected)。审批通过时执行移库，发起时不锁定库存（审批时二次校验充足）。
 *
 * Deps: pool, sendJSON, rbac, _invTypeToSNFields, _insertTransaction, broadcastChange,
 *       batches (src/handlers/batches.js 的 moveBatchesFIFO)
 */
'use strict';

module.exports = function createWarehouseTransferHandlers(deps) {
  const {
    pool, sendJSON, rbac,
    _invTypeToSNFields, _insertTransaction, broadcastChange,
    batches,
  } = deps;

  async function _writeAudit(conn, user, action, warehouseId, invType, note, detail) {
    try {
      const id = `ia-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
      await conn.execute(
        'INSERT INTO inventory_audit (id, ts, operator_id, operator, action, warehouse_id, inv_type, note, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [id, new Date().toISOString(), user.userId || '', user.username || '', action, warehouseId || 'main', invType || '', note || '', detail ? JSON.stringify(detail) : null]
      );
    } catch (e) { console.error('[TransferAudit] write failed:', e.message); }
  }

  // GET /api/warehouse-transfers?status=&limit=
  async function handleList(req, res, user) {
    const url = new URL(req.url, 'http://localhost');
    const status = url.searchParams.get('status');
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '200', 10) || 200, 1000);
    const where = [];
    const params = [];
    if (status) { where.push('status = ?'); params.push(status); }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const [rows] = await pool.execute(
      `SELECT * FROM warehouse_transfers ${whereSql} ORDER BY requested_at DESC LIMIT ${limit}`, params
    );
    sendJSON(res, rows.map(r => ({
      id: r.id,
      invType: r.inv_type,
      fromWarehouse: r.from_warehouse,
      toWarehouse: r.to_warehouse,
      quantity: r.quantity,
      status: r.status,
      note: r.note || '',
      requestedBy: r.requested_by || '',
      requestedAt: r.requested_at,
      reviewedBy: r.reviewed_by || '',
      reviewedAt: r.reviewed_at || null,
      reviewNote: r.review_note || '',
    })));
  }

  // POST /api/warehouse-transfers {invType, fromWarehouse, toWarehouse, quantity, note}
  async function handleCreate(req, res, user, body) {
    if (!await rbac.can(user, 'inventory', 'transfer')) return sendJSON(res, { error: '无权限发起调拨' }, 403);
    const { invType, fromWarehouse, toWarehouse, quantity, note } = body || {};
    const qty = Math.round(Number(quantity));
    if (!invType || !fromWarehouse || !toWarehouse) return sendJSON(res, { error: '请填写品类、源仓库和目标仓库' }, 400);
    if (!Number.isInteger(qty) || qty <= 0) return sendJSON(res, { error: '数量必须为正整数' }, 400);
    if (fromWarehouse === toWarehouse) return sendJSON(res, { error: '源仓库和目标仓库不能相同' }, 400);

    // 仓库有效性与状态校验
    const [whRows] = await pool.execute('SELECT id, status FROM warehouses WHERE id IN (?, ?)', [fromWarehouse, toWarehouse]);
    const whMap = Object.fromEntries(whRows.map(w => [w.id, w]));
    if (!whMap[fromWarehouse]) return sendJSON(res, { error: `源仓库 ${fromWarehouse} 不存在` }, 400);
    if (!whMap[toWarehouse]) return sendJSON(res, { error: `目标仓库 ${toWarehouse} 不存在` }, 400);
    if (whMap[fromWarehouse].status !== 'active' || whMap[toWarehouse].status !== 'active') {
      return sendJSON(res, { error: '调拨仓库必须为启用状态' }, 400);
    }
    // 源仓库存充足性预检（最终以审批事务内 FOR UPDATE 为准）
    const [invRows] = await pool.execute(
      'SELECT quantity FROM inventory WHERE inv_type = ? AND warehouse_id = ?', [invType, fromWarehouse]
    );
    const available = invRows.length > 0 ? invRows[0].quantity : 0;
    if (available < qty) return sendJSON(res, { error: `源仓库库存不足，当前仅 ${available} 件` }, 400);

    const now = new Date().toISOString();
    const id = `wt-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    await pool.execute(
      'INSERT INTO warehouse_transfers (id, inv_type, from_warehouse, to_warehouse, quantity, status, note, requested_by, requested_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [id, invType, fromWarehouse, toWarehouse, qty, 'pending', note || '', user.username, now]
    );
    broadcastChange('warehouse_transfers', [], { id, action: 'created' });
    sendJSON(res, { success: true, id });
  }

  // POST /api/warehouse-transfers/:id/approve
  async function handleApprove(req, res, user, id) {
    if (!await rbac.can(user, 'inventory', 'transfer')) return sendJSON(res, { error: '无权限审批调拨' }, 403);
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [rows] = await conn.execute('SELECT * FROM warehouse_transfers WHERE id = ? FOR UPDATE', [id]);
      if (rows.length === 0) { await conn.rollback(); return sendJSON(res, { error: '调拨单不存在' }, 404); }
      const t = rows[0];
      if (t.status !== 'pending') { await conn.rollback(); return sendJSON(res, { error: `调拨单已处理（当前状态：${t.status}）` }, 400); }
      // 审批人≠发起人（超管可自审）
      if (t.requested_by === user.username && user.role !== 'superadmin') {
        await conn.rollback();
        return sendJSON(res, { error: '不能审批自己发起的调拨单（超级管理员除外）' }, 400);
      }

      // 二次校验源仓库存（行锁防并发超拨）
      const [invRows] = await conn.execute(
        'SELECT quantity FROM inventory WHERE inv_type = ? AND warehouse_id = ? FOR UPDATE', [t.inv_type, t.from_warehouse]
      );
      const available = invRows.length > 0 ? invRows[0].quantity : 0;
      if (available < t.quantity) {
        await conn.rollback();
        return sendJSON(res, { error: `源仓库库存不足（当前 ${available} 件，需 ${t.quantity} 件）` }, 400);
      }
      // 目标仓当前量
      const [toRows] = await conn.execute(
        'SELECT quantity FROM inventory WHERE inv_type = ? AND warehouse_id = ?', [t.inv_type, t.to_warehouse]
      );
      const toQty = toRows.length > 0 ? toRows[0].quantity : 0;

      const now = new Date().toISOString();
      // 移库：源 -qty，目标 +qty
      await conn.execute(
        'REPLACE INTO inventory (inv_type, warehouse_id, quantity, updatedAt, updatedBy) VALUES (?, ?, ?, ?, ?)',
        [t.inv_type, t.from_warehouse, available - t.quantity, now, `调拨出(${user.username})`]
      );
      await conn.execute(
        'REPLACE INTO inventory (inv_type, warehouse_id, quantity, updatedAt, updatedBy) VALUES (?, ?, ?, ?, ?)',
        [t.inv_type, t.to_warehouse, toQty + t.quantity, now, `调拨入(${user.username})`]
      );

      // 批次同步（FIFO 源仓扣批 → 目标仓建批，保留入库时间/效期）
      const batchDetail = await batches.moveBatchesFIFO(conn, {
        invType: t.inv_type, fromWh: t.from_warehouse, toWh: t.to_warehouse, qty: t.quantity, now,
      });

      // 流水（一次出库方向记录，note 标注调拨路径）
      const [eqType, hType] = _invTypeToSNFields(t.inv_type);
      const txId = `wt-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
      await _insertTransaction(conn, {
        id: txId, equipmentType: eqType, handType: hType, invType: t.inv_type,
        direction: 'out', quantity: t.quantity,
        snCode: '', machineNumber: '', updatedBy: user.username, timestamp: now,
        note: `仓库调拨：${t.from_warehouse} → ${t.to_warehouse}${t.note ? `（${t.note}）` : ''}`,
        refType: 'warehouse_transfer', refId: t.id, warehouseId: t.from_warehouse,
      });

      // 双仓审计
      await _writeAudit(conn, user, 'warehouse_transfer', t.from_warehouse, t.inv_type,
        `调拨出库 → ${t.to_warehouse} ×${t.quantity}`, { to: t.to_warehouse, qty: t.quantity, transferId: t.id, batches: batchDetail });
      await _writeAudit(conn, user, 'warehouse_transfer', t.to_warehouse, t.inv_type,
        `调拨入库 ← ${t.from_warehouse} ×${t.quantity}`, { from: t.from_warehouse, qty: t.quantity, transferId: t.id, batches: batchDetail });

      // 更新调拨单状态
      await conn.execute(
        "UPDATE warehouse_transfers SET status = 'approved', reviewed_by = ?, reviewed_at = ? WHERE id = ?",
        [user.username, now, id]
      );

      await conn.commit();
      broadcastChange('warehouse_transfers', ['inventory', 'transactions'], { id, action: 'approved' });
      sendJSON(res, { success: true, batchDetail });
    } catch (e) {
      try { await conn.rollback(); } catch {}
      sendJSON(res, { error: `审批失败: ${e.message}` }, 500);
    } finally {
      try { conn.release(); } catch {}
    }
  }

  // POST /api/warehouse-transfers/:id/reject {note?}
  async function handleReject(req, res, user, id, body) {
    if (!await rbac.can(user, 'inventory', 'transfer')) return sendJSON(res, { error: '无权限审批调拨' }, 403);
    const [rows] = await pool.execute('SELECT * FROM warehouse_transfers WHERE id = ?', [id]);
    if (rows.length === 0) return sendJSON(res, { error: '调拨单不存在' }, 404);
    const t = rows[0];
    if (t.status !== 'pending') return sendJSON(res, { error: `调拨单已处理（当前状态：${t.status}）` }, 400);
    if (t.requested_by === user.username && user.role !== 'superadmin') {
      return sendJSON(res, { error: '不能审批自己发起的调拨单（超级管理员除外）' }, 400);
    }
    const now = new Date().toISOString();
    await pool.execute(
      "UPDATE warehouse_transfers SET status = 'rejected', reviewed_by = ?, reviewed_at = ?, review_note = ? WHERE id = ?",
      [user.username, now, (body && body.note) || '', id]
    );
    broadcastChange('warehouse_transfers', [], { id, action: 'rejected' });
    sendJSON(res, { success: true });
  }

  return { handleList, handleCreate, handleApprove, handleReject };
};
