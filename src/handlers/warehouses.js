/**
 * src/handlers/warehouses.js
 * 仓库管理域（Phase 1 企业级基座）
 *
 * Handlers in this domain (URL → handler):
 *   GET    /api/warehouses            → handleGetAll        （登录即可看，供筛选下拉）
 *   POST   /api/warehouses            → handleCreate        （warehouses:manage）
 *   PUT    /api/warehouses/:id        → handleUpdate        （warehouses:manage）
 *   DELETE /api/warehouses/:id        → handleDelete        （warehouses:manage）
 *   GET    /api/inventory-audit       → handleGetAuditLog   （登录可看自己，管理员看全部）
 *
 * 数据表：warehouses (id, name, status, location, data JSON)
 *  - 'main' 为主仓库（seedDefaults 自动创建），不可删除
 *  - 库存独立核算：inventory 表以 (inv_type, warehouse_id) 复合主键分仓记账
 *
 * Deps: pool, sendJSON, rbac (lib/rbac.js engine), broadcastChange
 */
'use strict';

module.exports = function createWarehouseHandlers(deps) {
  const { pool, sendJSON, rbac, broadcastChange } = deps;

  function _rowToWarehouse(r) {
    let d = {};
    try { d = r.data ? JSON.parse(r.data) : {}; } catch {}
    return {
      id: r.id,
      name: r.name || d.name || r.id,
      status: r.status || 'active',
      location: r.location || d.location || '',
      isDefault: r.id === 'main',
      createdAt: r.createdAt || d.createdAt || null,
      updatedAt: r.updatedAt || d.updatedAt || null,
      remark: d.remark || '',
    };
  }

  // 列表 + 每仓库 SKU 数/库存总量汇总（GROUP BY 聚合，避免 N+1）
  async function handleGetAll(req, res, user) {
    const [rows] = await pool.execute('SELECT id, name, status, location, createdAt, updatedAt, data FROM warehouses ORDER BY id = \'main\' DESC, id ASC');
    const [agg] = await pool.execute(
      'SELECT warehouse_id, COUNT(*) as skuCount, COALESCE(SUM(quantity),0) as totalQty FROM inventory GROUP BY warehouse_id'
    );
    const aggMap = Object.fromEntries(agg.map(a => [a.warehouse_id, a]));
    sendJSON(res, rows.map(r => {
      const w = _rowToWarehouse(r);
      const a = aggMap[r.id] || {};
      w.skuCount = a.skuCount || 0;
      w.totalQty = a.totalQty || 0;
      return w;
    }));
  }

  async function handleCreate(req, res, user, body) {
    if (!await rbac.can(user, 'warehouses', 'manage')) return sendJSON(res, { error: '无权限管理仓库' }, 403);
    const { id, name, location, remark } = body || {};
    const whId = String(id || '').trim();
    if (!whId || !name) return sendJSON(res, { error: '请填写仓库编码和名称' }, 400);
    if (!/^[a-zA-Z0-9_-]{1,32}$/.test(whId)) return sendJSON(res, { error: '仓库编码只能包含字母、数字、下划线和短横线（最长32字符）' }, 400);
    const [dup] = await pool.execute('SELECT id FROM warehouses WHERE id = ?', [whId]);
    if (dup.length > 0) return sendJSON(res, { error: `仓库编码 ${whId} 已存在` }, 400);
    const now = new Date().toISOString();
    const data = { id: whId, name, location: location || '', remark: remark || '', createdAt: now, createdBy: user.username };
    await pool.execute(
      'INSERT INTO warehouses (id, name, status, location, createdAt, updatedAt, data) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [whId, name, 'active', location || '', now, now, JSON.stringify(data)]
    );
    await _audit(user, 'warehouse_create', whId, null, null, `创建仓库「${name}」`);
    broadcastChange('warehouses', [], { id: whId });
    sendJSON(res, { success: true, warehouse: { ...data, status: 'active', isDefault: false } });
  }

  async function handleUpdate(req, res, user, whId, body) {
    if (!await rbac.can(user, 'warehouses', 'manage')) return sendJSON(res, { error: '无权限管理仓库' }, 403);
    const [rows] = await pool.execute('SELECT * FROM warehouses WHERE id = ?', [whId]);
    if (rows.length === 0) return sendJSON(res, { error: '仓库不存在' }, 404);
    const old = _rowToWarehouse(rows[0]);
    const { name, location, status, remark } = body || {};
    if (old.isDefault && status === 'disabled') return sendJSON(res, { error: '主仓库不可停用' }, 400);
    const now = new Date().toISOString();
    let d;
    try { d = rows[0].data ? JSON.parse(rows[0].data) : {}; } catch { d = {}; }
    d.remark = remark !== undefined ? remark : (d.remark || '');
    await pool.execute(
      'UPDATE warehouses SET name = ?, status = ?, location = ?, updatedAt = ?, data = ? WHERE id = ?',
      [name || old.name, status || old.status, location !== undefined ? location : old.location, now, JSON.stringify(d), whId]
    );
    await _audit(user, 'warehouse_update', whId, null, null,
      `更新仓库「${name || old.name}」${status && status !== old.status ? `，状态 ${old.status}→${status}` : ''}`);
    broadcastChange('warehouses', [], { id: whId });
    sendJSON(res, { success: true });
  }

  async function handleDelete(req, res, user, whId) {
    if (!await rbac.can(user, 'warehouses', 'manage')) return sendJSON(res, { error: '无权限管理仓库' }, 403);
    if (whId === 'main') return sendJSON(res, { error: '主仓库不可删除' }, 400);
    const [rows] = await pool.execute('SELECT * FROM warehouses WHERE id = ?', [whId]);
    if (rows.length === 0) return sendJSON(res, { error: '仓库不存在' }, 404);
    // 保护：仓库内还有任何库存记录（含 0 量行）都拒绝删除，避免孤儿数据
    const [inv] = await pool.execute('SELECT COUNT(*) as c FROM inventory WHERE warehouse_id = ?', [whId]);
    if (inv[0].c > 0) return sendJSON(res, { error: `仓库内仍有 ${inv[0].c} 条库存记录，请先清空/调拨后再删除` }, 400);
    await pool.execute('DELETE FROM warehouses WHERE id = ?', [whId]);
    await _audit(user, 'warehouse_delete', whId, null, null, `删除仓库「${rows[0].name || whId}」`);
    broadcastChange('warehouses', [], { id: whId });
    sendJSON(res, { success: true });
  }

  // ==================== 库存审计日志 ====================
  // 结构化写 inventory_audit 表，与旧 audit_log（JSON 通用审计）并存
  async function _audit(user, action, warehouseId, invType, detail, note) {
    try {
      const id = `ia-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
      await pool.execute(
        'INSERT INTO inventory_audit (id, ts, operator_id, operator, action, warehouse_id, inv_type, note, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [id, new Date().toISOString(), user.userId || '', user.username || '', action,
         warehouseId || 'main', invType || '', note || '', detail ? JSON.stringify(detail) : null]
      );
    } catch (e) { console.error('[InventoryAudit] write failed:', e.message); }
  }

  // GET /api/inventory-audit?limit=&action=&warehouseId=&invType=&operator=
  async function handleGetAuditLog(req, res, user) {
    const url = new URL(req.url, 'http://localhost');
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '200', 10) || 200, 1000);
    const where = [];
    const params = [];
    // 普通用户只看自己的操作记录；管理员看全部
    if (user.role !== 'admin' && user.role !== 'superadmin' && !user.customRole) {
      where.push('operator_id = ?'); params.push(user.userId || '');
    }
    for (const [key, col] of [['action', 'action'], ['warehouseId', 'warehouse_id'], ['invType', 'inv_type'], ['operator', 'operator']]) {
      const v = url.searchParams.get(key);
      if (v) { where.push(`${col} = ?`); params.push(v); }
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const [rows] = await pool.execute(
      `SELECT * FROM inventory_audit ${whereSql} ORDER BY id DESC LIMIT ${limit}`, params
    );
    sendJSON(res, rows.map(r => {
      let detail = null;
      try { detail = r.detail ? JSON.parse(r.detail) : null; } catch {}
      return {
        id: r.id, ts: r.ts, operator: r.operator, operatorId: r.operator_id,
        action: r.action, warehouseId: r.warehouse_id, invType: r.inv_type,
        note: r.note, detail,
      };
    }));
  }

  return { handleGetAll, handleCreate, handleUpdate, handleDelete, handleGetAuditLog, _audit };
};
