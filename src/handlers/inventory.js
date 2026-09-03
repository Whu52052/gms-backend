/**
 * src/handlers/inventory.js
 * Inventory-domain HTTP handlers — extracted from server.js (Phase 2.1 step4).
 *
 * This is the most dependency-heavy domain: it orchestrates SN-level inventory
 * mutations, calls _syncInventoryFromSN (recompute inventory totals from
 * sn_registry), writes transactions, and broadcasts multi-cache invalidations.
 * Same factory / dependency-injection pattern as auth/users/transactions.
 *
 * Handlers in this domain (URL → handler):
 *   GET    /api/inventory              → handleGetAllInventory
 *   GET    /api/inventory/:type        → handleGetInventory
 *   POST   /api/inventory/:type        → handleAdjustInventory  (+/- SN records)
 *   POST   /api/inventory/transfer     → handleTransferInventory (SN-level or legacy)
 *   GET    /api/inventory/transfer-stats → handleGetTransferStats
 *   POST   /api/sync-inventory          → handleSyncInventoryNow
 *
 * Deps: pool, _getInventoryBreakdowns (lib/db-helpers alias), _invTypeToSNFields
 * (lib/mappings), _syncInventoryFromSN (server.js, has broadcastSSE side effect),
 * _insertTransaction (lib/db-helpers alias), broadcastChange (Phase 1.2 helper),
 * broadcastSSE, ENABLE_SN_TRANSFER (const flag from env), sendJSON.
 */
'use strict';

const { requireAdmin } = require('./_permissions');
const { categoryTrackingMode } = require('../../lib/mappings');

module.exports = function createInventoryHandlers(deps) {
  const {
    pool,
    _getInventoryBreakdowns,
    _invTypeToSNFields,
    _syncInventoryFromSN,
    _insertTransaction,
    broadcastChange,
    broadcastSSE,
    ENABLE_SN_TRANSFER,
    sendJSON,
    batches, // Phase 2：批次台账 helper（recordInboundBatch / consumeBatchesFIFO）
  } = deps;

  // 读取库存品类配置（inventory_config 为小表，事务内直读保证一致）
  async function _readInventoryConfig(conn) {
    const [rows] = await conn.execute('SELECT id, data FROM inventory_config');
    return rows.map(r => { try { return JSON.parse(r.data); } catch { return { id: r.id }; } });
  }

  // ==================== INVENTORY HANDLERS ====================

  // Phase 1 多仓库：聚合查询辅助
  // 默认按品类聚合各仓库数量（向后兼容旧前端一品类一行的语义），
  // 附 warehouses 数组给出分仓明细；?groupBy=warehouse 返回分仓行。
  async function handleGetAllInventory(req, res, user) {
    const url = new URL(req.url, 'http://localhost');
    const groupByWarehouse = url.searchParams.get('groupBy') === 'warehouse';
    const [rows] = await pool.execute('SELECT * FROM inventory LIMIT 2000');
    const breakdowns = await _getInventoryBreakdowns();
    const configItems = await _readInventoryConfig(pool);
    if (groupByWarehouse) {
      return sendJSON(res, rows.map(r => {
        const b = breakdowns[r.inv_type] || { available: 0, inUse: 0, damaged: 0, inRepair: 0, transferred: 0 };
        return {
          type: r.inv_type, warehouseId: r.warehouse_id || 'main', quantity: r.quantity,
          available: b.available, inUse: b.inUse, damaged: b.damaged, inRepair: b.inRepair, transferred: b.transferred,
          trackingMode: categoryTrackingMode(r.inv_type, configItems),
          updatedAt: r.updatedAt, updatedBy: r.updatedBy,
        };
      }));
    }
    // 聚合视图：一品类一行，quantity = 各仓库之和
    const byType = new Map();
    for (const r of rows) {
      const t = r.inv_type;
      if (!byType.has(t)) byType.set(t, { type: t, quantity: 0, warehouses: [], updatedAt: null, updatedBy: '' });
      const agg = byType.get(t);
      agg.quantity += r.quantity;
      agg.warehouses.push({ warehouseId: r.warehouse_id || 'main', quantity: r.quantity });
      if (!agg.updatedAt || (r.updatedAt && r.updatedAt > agg.updatedAt)) {
        agg.updatedAt = r.updatedAt; agg.updatedBy = r.updatedBy;
      }
    }
    sendJSON(res, [...byType.values()].map(agg => {
      const b = breakdowns[agg.type] || { available: 0, inUse: 0, damaged: 0, inRepair: 0, transferred: 0 };
      return {
        ...agg,
        available: b.available, inUse: b.inUse, damaged: b.damaged, inRepair: b.inRepair, transferred: b.transferred,
        trackingMode: categoryTrackingMode(agg.type, configItems),
      };
    }));
  }

  async function handleGetInventory(req, res, user, type) {
    const [rows] = await pool.execute('SELECT * FROM inventory WHERE inv_type = ?', [type]);
    const breakdowns = await _getInventoryBreakdowns();
    const b = breakdowns[type] || { available: 0, inUse: 0, damaged: 0, inRepair: 0, transferred: 0 };
    const total = rows.reduce((s, r) => s + r.quantity, 0);
    const latest = rows.reduce((a, r) => (!a || (r.updatedAt && r.updatedAt > a.updatedAt) ? r : a), null);
    sendJSON(res, {
      type, quantity: total,
      warehouses: rows.map(r => ({ warehouseId: r.warehouse_id || 'main', quantity: r.quantity })),
      available: b.available, inUse: b.inUse, damaged: b.damaged, inRepair: b.inRepair, transferred: b.transferred,
      updatedAt: latest ? latest.updatedAt : null, updatedBy: latest ? latest.updatedBy : '',
    });
  }

  async function handleAdjustInventory(req, res, user, type, body) {
    const { delta, note, warehouseId, batchId, expiryDate } = body || {};
    if (typeof delta !== 'number' || !Number.isFinite(delta)) return sendJSON(res, { error: 'delta 必须为有效数字' }, 400);
    if (!requireAdmin(user, res, sendJSON, '无权限调整库存')) return;
    const qty = Math.abs(Math.round(delta));
    if (qty === 0) return sendJSON(res, { error: '调整数量必须大于0' }, 400);
    const whId = String(warehouseId || 'main').trim() || 'main';
    // 仓库存在性校验（停用仓库禁止出入库）
    const [whRows] = await pool.execute('SELECT id, status FROM warehouses WHERE id = ?', [whId]);
    if (whRows.length === 0) return sendJSON(res, { error: `仓库 ${whId} 不存在` }, 400);
    if (whRows[0].status !== 'active') return sendJSON(res, { error: `仓库 ${whId} 已停用` }, 400);
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const configItems = await _readInventoryConfig(conn);
      const mode = categoryTrackingMode(type, configItems);
      if (mode === 'sn' && whId !== 'main') {
        await conn.rollback();
        return sendJSON(res, { error: 'SN 精细跟踪品类由 SN 注册表统一核算，仅支持主仓库操作' }, 400);
      }

      if (mode === 'quantity') {
        // ===== 纯数量模式：直接增减指定仓库的 inventory.quantity，不产生任何 SN 记录 =====
        // 提供备注时服务端自动写流水（出入库原子化，前端一次调用即可）
        const [rows] = await conn.execute('SELECT quantity FROM inventory WHERE inv_type = ? AND warehouse_id = ? FOR UPDATE', [type, whId]);
        const currentQty = rows.length > 0 ? rows[0].quantity : 0;
        const newQty = currentQty + delta;
        if (newQty < 0) { await conn.rollback(); return sendJSON(res, { success: false, message: `库存不足，当前仅 ${currentQty} 件` }, 400); }
        const now = new Date().toISOString();
        await conn.execute(
          'REPLACE INTO inventory (inv_type, warehouse_id, quantity, updatedAt, updatedBy) VALUES (?, ?, ?, ?, ?)',
          [type, whId, newQty, now, user.username]
        );
        // Phase 2：批次台账同步维护（入库建批/追加；出库 FIFO 扣批）
        let batchInfo = null;
        if (delta > 0) {
          const bid = await batches.recordInboundBatch(conn, {
            invType: type, warehouseId: whId, qty,
            batchId: batchId || null,
            expiryDate: expiryDate || null,
            note: note ? String(note).trim() : '',
            user, now,
          });
          batchInfo = { batchId: bid, appended: !!batchId };
        } else {
          const consumed = await batches.consumeBatchesFIFO(conn, { invType: type, warehouseId: whId, qty });
          batchInfo = { consumed };
        }
        // 结构化库存审计（Phase 1/2：含批次明细）
        await conn.execute(
          'INSERT INTO inventory_audit (id, ts, operator_id, operator, action, warehouse_id, inv_type, note, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [`ia-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, now, user.userId || '', user.username || '', 'adjust', whId, type, `调整 ${delta > 0 ? '+' : ''}${delta}${note ? `（${String(note).trim()}）` : ''}`, JSON.stringify({ before: currentQty, after: newQty, delta, batch: batchInfo })]
        );
        if (note && String(note).trim()) {
          const [eqType, hType] = _invTypeToSNFields(type);
          const txId = `adj-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
          await _insertTransaction(conn, {
            id: txId, equipmentType: eqType, handType: hType, invType: type,
            direction: delta > 0 ? 'in' : 'out', quantity: qty,
            snCode: '', machineNumber: '', updatedBy: user.username, timestamp: now,
            note: String(note).trim(), refType: 'adjust', warehouseId: whId,
          });
        }
        await conn.commit();
        broadcastChange('inventory', note ? ['transactions'] : [], { type, warehouseId: whId, quantity: newQty, updatedBy: user.username });
        return sendJSON(res, { success: true, newQuantity: newQty, warehouseId: whId, mode: 'quantity', batch: batchInfo });
      }

      // ===== SN 模式（默认，保持原行为）：增删 ADJ- 占位 SN + 从注册表重算 =====
      // SN 品类由 sn_registry 全局核算，固定记在主仓库
      const [rows] = await conn.execute('SELECT quantity FROM inventory WHERE inv_type = ? AND warehouse_id = ? FOR UPDATE', [type, 'main']);
      const currentQty = rows.length > 0 ? rows[0].quantity : 0;
      const newQty = currentQty + (delta || 0);
      if (newQty < 0) { await conn.rollback(); return sendJSON(res, { success: false, message: '库存不足' }, 400); }

      const [eqType, hType] = _invTypeToSNFields(type);
      if (delta > 0) {
        // Positive adjustment: create new SN records
        const now = new Date().toISOString();
        for (let i = 0; i < qty; i++) {
          const snCode = `ADJ-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
          await conn.execute(
            'INSERT INTO sn_registry (snCode, equipmentType, handType, status, machineNumber, trackingNumber, damageReason, shippedAt, repairedAt, attachment, updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
            [snCode, eqType, hType, 'available', '', '', '', '', '', '', now]
          );
        }
      } else if (delta < 0) {
        // Negative adjustment: remove available SN records
        const [availableRows] = await conn.execute(
          `SELECT snCode FROM sn_registry WHERE equipmentType = ? AND handType = ? AND status = 'available' ORDER BY updatedAt DESC LIMIT ${qty} FOR UPDATE`,
          [eqType, hType]
        );
        if (availableRows.length < qty) {
          await conn.rollback();
          return sendJSON(res, { success: false, message: `可用SN码不足，当前仅有 ${availableRows.length} 只可删除` }, 400);
        }
        for (const row of availableRows) {
          await conn.execute('DELETE FROM sn_registry WHERE snCode = ?', [row.snCode]);
        }
      }
      await _syncInventoryFromSN(conn);
      // 结构化库存审计（Phase 1，SN 模式：记主仓库）
      await conn.execute(
        'INSERT INTO inventory_audit (id, ts, operator_id, operator, action, warehouse_id, inv_type, note, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [`ia-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, new Date().toISOString(), user.userId || '', user.username || '', 'adjust', 'main', type, `调整 ${delta > 0 ? '+' : ''}${delta}（SN 模式）`, JSON.stringify({ before: currentQty, after: newQty, delta })]
      );
      await conn.commit();
      broadcastChange('sn_registry', ['inventory'], { type, quantity: newQty, updatedBy: user.username });
      sendJSON(res, { success: true, newQuantity: newQty, mode: 'sn' });
    } catch (e) {
      await conn.rollback();
      sendJSON(res, { error: e.message }, 500);
    } finally {
      try { conn.release(); } catch {}
    }
  }

  async function handleTransferInventory(req, res, authUser, body) {
    if (!requireAdmin(authUser, res, sendJSON, '仅管理员可执行调拨')) return;
    const { invType, quantity, destination, note } = body;
    if (!invType || !quantity || !destination) return sendJSON(res, { error: '请填写库存类型、数量和调拨目的地' }, 400);
    const qty = parseInt(quantity);
    if (isNaN(qty) || qty <= 0) return sendJSON(res, { error: '数量必须为正整数' }, 400);
    const dest = (destination || '').trim();
    if (!dest) return sendJSON(res, { error: '调拨目的地不能为空' }, 400);
    const now = new Date().toISOString();
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      if (ENABLE_SN_TRANSFER) {
        // SN-level transfer: mark specific gloves as 'transferred' so _syncInventoryFromSN excludes them
        // from inventory.total (transferred is not in its WHERE clause), preventing the transfer being erased.
        const [eqType, hType] = _invTypeToSNFields(invType);
        const [snRows] = await conn.execute(
          'SELECT snCode FROM sn_registry WHERE equipmentType = ? AND handType = ? AND status = ? ORDER BY updatedAt ASC LIMIT ? FOR UPDATE',
          [eqType, hType, 'available', qty]
        );
        if (snRows.length < qty) {
          await conn.rollback();
          return sendJSON(res, { error: `可用 SN 不足，需要 ${qty} 个，当前仅有 ${snRows.length} 个 ${eqType}(${hType || '-'})` }, 400);
        }
        const transferredSNs = [];
        for (const r of snRows) {
          await conn.execute(
            'UPDATE sn_registry SET status = ?, trackingNumber = ?, updatedAt = ? WHERE snCode = ?',
            ['transferred', dest, now, r.snCode]
          );
          transferredSNs.push(r.snCode);
        }
        await _syncInventoryFromSN(conn); // recompute inventory (transferred now excluded)
        const txId = `tf-${  Date.now().toString(36)  }${Math.random().toString(36).slice(2, 6)}`;
        await _insertTransaction(conn, {
          id: txId, equipmentType: eqType, handType: hType, invType, direction: 'out', quantity: qty,
          snCode: transferredSNs.join(', '), updatedBy: authUser.username, timestamp: now,
          note: note || `调拨至${dest}`, transferDestination: dest, isTransfer: true, refType: 'transfer',
        });
        await conn.commit();
        broadcastChange('sn_registry', ['inventory', 'transactions'], { type: invType, updatedBy: authUser.username });
        sendJSON(res, { success: true, transferred: qty, destination: dest, snCodes: transferredSNs, mode: 'sn' });
      } else {
        // Legacy: number subtraction (kept for backward compat during rollout)
        const [rows] = await conn.execute('SELECT quantity FROM inventory WHERE inv_type = ? AND warehouse_id = ? FOR UPDATE', [invType, 'main']);
        const currentQty = rows.length > 0 ? rows[0].quantity : 0;
        if (currentQty < qty) {
          await conn.rollback();
          return sendJSON(res, { error: `库存不足，当前仅有 ${currentQty} 件` }, 400);
        }
        const newQty = currentQty - qty;
        await conn.execute('REPLACE INTO inventory (inv_type, warehouse_id, quantity, updatedAt, updatedBy) VALUES (?, ?, ?, ?, ?)',
          [invType, 'main', newQty, now, authUser.username]);
        const txId = `tf-${  Date.now().toString(36)  }${Math.random().toString(36).slice(2, 6)}`;
        await _insertTransaction(conn, {
          id: txId, equipmentType: invType, invType, direction: 'out', quantity: qty,
          updatedBy: authUser.username, timestamp: now, note: note || `调拨至${dest}`,
          transferDestination: dest, isTransfer: true, refType: 'transfer',
        });
        await conn.commit();
        broadcastChange('inventory', ['transactions'], { type: invType, quantity: newQty, updatedBy: authUser.username });
        sendJSON(res, { success: true, newQuantity: newQty, transferred: qty, destination: dest, mode: 'legacy' });
      }
    } catch (e) {
      await conn.rollback();
      sendJSON(res, { error: `调拨失败: ${  e.message}` }, 500);
    } finally {
      conn.release();
    }
  }

  // Get transfer stats for dashboard
  async function handleGetTransferStats(req, res, authUser) {
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

  async function handleSyncInventoryNow(req, res, user) {
    if (!requireAdmin(user, res, sendJSON, '无权限同步库存')) return;
    try {
      await _syncInventoryFromSN(pool);
      broadcastSSE('inventory_updated', {});
      sendJSON(res, { success: true, message: '库存已从SN注册表同步' });
    } catch (e) {
      sendJSON(res, { error: e.message }, 500);
    }
  }

  return {
    handleGetAllInventory,
    handleGetInventory,
    handleAdjustInventory,
    handleTransferInventory,
    handleGetTransferStats,
    handleSyncInventoryNow,
  };
};
