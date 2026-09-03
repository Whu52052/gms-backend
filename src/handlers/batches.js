/**
 * src/handlers/batches.js
 * 批次跟踪域（Phase 2）
 *
 * Handlers in this domain (URL → handler):
 *   GET    /api/batches                 → handleGetBatches   （列表，含效期状态计算）
 *
 * 同时导出批次台账内部 helper（供 inventory.js 调拨/调整与 warehouse-transfers.js 复用）：
 *   recordInboundBatch(conn, {invType, warehouseId, qty, batchId?, expiryDate?, note, user, now})
 *     → 入库建批/追加；返回批次 id
 *   consumeBatchesFIFO(conn, {invType, warehouseId, qty})
 *     → FIFO 出库扣批；返回 [{batchId, taken}]（无批次记录时返回 []，库存数量以 inventory 表为准）
 *   moveBatchesFIFO(conn, {invType, fromWh, toWh, qty, user, now})
 *     → 跨仓移库：源仓 FIFO 扣批 + 目标仓按原批次 received_at/expiry 建批
 *
 * 批次仅适用于纯数量跟踪品类（SN 品类由 sn_registry 逐件溯源）。
 * 批次是并行台账：inventory.quantity 始终为权威库存，批次按同事务维护。
 * 存量数据（建批前的库存）无批次记录，FIFO 扣完批次即直接扣 quantity。
 *
 * Deps: pool, sendJSON
 */
'use strict';

// 批次编码：B-YYYYMMDD-xxxx（随机后缀，同日多批不冲突）
function genBatchId() {
  const d = new Date();
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  return `B-${ymd}-${Math.random().toString(36).slice(2, 6)}`;
}

// 效期状态计算（服务端统一口径，前端直接渲染）
// expired: 已过期；expiring: 30 天内到期；depleted: 余量为 0；normal: 正常
function expiryStatusOf(batch, todayStr, horizonStr) {
  if ((batch.quantity || 0) <= 0) return 'depleted';
  if (!batch.expiry_date) return 'normal';
  if (batch.expiry_date < todayStr) return 'expired';
  if (batch.expiry_date <= horizonStr) return 'expiring';
  return 'normal';
}

function _todayStr(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

module.exports = function createBatchHandlers(deps) {
  const { pool, sendJSON } = deps;

  // GET /api/batches?invType=&warehouseId=&status=&limit=
  async function handleGetBatches(req, res, user) {
    const url = new URL(req.url, 'http://localhost');
    const where = [];
    const params = [];
    const invType = url.searchParams.get('invType');
    const warehouseId = url.searchParams.get('warehouseId');
    const status = url.searchParams.get('status');
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '500', 10) || 500, 2000);
    if (invType) { where.push('inv_type = ?'); params.push(invType); }
    if (warehouseId) { where.push('warehouse_id = ?'); params.push(warehouseId); }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const [rows] = await pool.execute(
      `SELECT * FROM batches ${whereSql} ORDER BY received_at DESC, id DESC LIMIT ${limit}`, params
    );
    const today = _todayStr();
    const horizon = _todayStr(30);
    let list = rows.map(r => ({
      id: r.id,
      invType: r.inv_type,
      warehouseId: r.warehouse_id || 'main',
      quantity: r.quantity || 0,
      initialQty: r.initial_qty || 0,
      receivedAt: r.received_at,
      expiryDate: r.expiry_date || '',
      note: r.note || '',
      createdBy: r.created_by || '',
      createdAt: r.created_at,
      status: expiryStatusOf(r, today, horizon),
    }));
    if (status) list = list.filter(b => b.status === status);
    sendJSON(res, list);
  }

  // ==================== 批次台账内部 helpers（同事务维护） ====================

  /**
   * 入库建批/追加。
   * batchId 提供且匹配同品类+仓库 → 追加数量（并更新效期/备注若提供）；
   * 否则生成新批次。
   */
  async function recordInboundBatch(conn, { invType, warehouseId, qty, batchId, expiryDate, note, user, now }) {
    if (batchId) {
      const [rows] = await conn.execute(
        'SELECT * FROM batches WHERE id = ? AND inv_type = ? AND warehouse_id = ? FOR UPDATE',
        [batchId, invType, warehouseId]
      );
      if (rows.length > 0) {
        const updates = ['quantity = quantity + ?', 'initial_qty = initial_qty + ?'];
        const params = [qty, qty];
        if (expiryDate) { updates.push('expiry_date = ?'); params.push(expiryDate); }
        if (note) { updates.push('note = ?'); params.push(note); }
        params.push(batchId);
        await conn.execute(`UPDATE batches SET ${updates.join(', ')} WHERE id = ?`, params);
        return batchId;
      }
      // batchId 不匹配 → 落到新建（忽略传入 id）
    }
    const id = genBatchId();
    await conn.execute(
      'INSERT INTO batches (id, inv_type, warehouse_id, quantity, initial_qty, received_at, expiry_date, note, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [id, invType, warehouseId || 'main', qty, qty, now, expiryDate || null, note || '', user.username || '', now]
    );
    return id;
  }

  /**
   * FIFO 出库扣批（received_at 最早优先，同日按 id）。
   * 返回扣减明细 [{batchId, taken}]；批次余量不足的部分（存量无批次）直接跳过。
   */
  async function consumeBatchesFIFO(conn, { invType, warehouseId, qty }) {
    const [rows] = await conn.execute(
      `SELECT id, quantity FROM batches
       WHERE inv_type = ? AND warehouse_id = ? AND quantity > 0
       ORDER BY received_at ASC, id ASC FOR UPDATE`,
      [invType, warehouseId || 'main']
    );
    let remain = qty;
    const detail = [];
    for (const r of rows) {
      if (remain <= 0) break;
      const take = Math.min(remain, r.quantity);
      await conn.execute('UPDATE batches SET quantity = quantity - ? WHERE id = ?', [take, r.id]);
      detail.push({ batchId: r.id, taken: take });
      remain -= take;
    }
    return detail;
  }

  /**
   * 跨仓移库的批次同步：源仓 FIFO 扣批，目标仓按源批次的入库时间/效期建批
   * （目标仓新批次 id 重新生成，保留源批次溯源信息于 note）。
   */
  async function moveBatchesFIFO(conn, { invType, fromWh, toWh, qty, now }) {
    const [rows] = await conn.execute(
      `SELECT id, quantity, received_at, expiry_date FROM batches
       WHERE inv_type = ? AND warehouse_id = ? AND quantity > 0
       ORDER BY received_at ASC, id ASC FOR UPDATE`,
      [invType, fromWh]
    );
    let remain = qty;
    const detail = [];
    for (const r of rows) {
      if (remain <= 0) break;
      const take = Math.min(remain, r.quantity);
      await conn.execute('UPDATE batches SET quantity = quantity - ? WHERE id = ?', [take, r.id]);
      const newId = genBatchId();
      await conn.execute(
        'INSERT INTO batches (id, inv_type, warehouse_id, quantity, initial_qty, received_at, expiry_date, note, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [newId, invType, toWh, take, take, r.received_at || now, r.expiry_date || null, `调拨自 ${r.id}`, '', now]
      );
      detail.push({ fromBatch: r.id, toBatch: newId, taken: take });
      remain -= take;
    }
    return detail;
  }

  return { handleGetBatches, recordInboundBatch, consumeBatchesFIFO, moveBatchesFIFO, genBatchId };
};
