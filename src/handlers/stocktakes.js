/**
 * src/handlers/stocktakes.js
 * 盘点（Stocktake）域 handler。
 *
 * 流程：
 *   1. 管理员发起盘点（POST /api/stocktakes）—— 事务内快照当前账面数据：
 *      - 纯数量品类：快照 inventory.quantity
 *      - SN 品类：快照在手（available）SN 清单
 *   2. 录入实盘（PUT /api/stocktakes/:id）—— 数量模式填实盘数；SN 模式取消勾选缺失项、追加盘盈 SN（草稿可反复保存）
 *   3. 完成盘点（POST /api/stocktakes/:id/complete）—— 事务内执行差异调整：
 *      - 数量模式：SET quantity = 实盘数，写盘盈/盘亏流水
 *      - SN 模式：缺失 SN → scrapped（保守：保留记录、移出库存计数）；盘盈 SN → 入库 available
 *        然后调 _syncInventoryFromSN 重算；差异写流水
 *   4. 历史可查（GET /api/stocktakes[/:id]），含差异汇总报告
 *
 * Deps: pool, sendJSON, _invTypeToSNFields, _syncInventoryFromSN,
 *       _insertTransaction, broadcastChange。
 */
'use strict';

module.exports = function createStocktakeHandlers(deps) {
  const {
    pool, sendJSON,
    _invTypeToSNFields,
    _syncInventoryFromSN,
    _insertTransaction,
    broadcastChange,
  } = deps;

  const isAdmin = user => user && ['admin', 'superadmin'].includes(user.role);

  // ========== helpers ==========

  async function _getStocktake(conn, id) {
    const [rows] = await conn.execute('SELECT id, data, status FROM stocktakes WHERE id = ?', [id]);
    if (rows.length === 0) return null;
    let data;
    try { data = JSON.parse(rows[0].data); } catch { data = {}; }
    return { id: rows[0].id, status: rows[0].status, ...data };
  }

  async function _saveStocktake(conn, st) {
    const { id, status } = st;
    const data = { ...st };
    delete data.id; delete data.status; // 冗余列单独存
    await conn.execute(
      'REPLACE INTO stocktakes (id, data, status, created_at) VALUES (?, ?, ?, ?)',
      [id, JSON.stringify(data), status, data.createdAt || '']
    );
  }

  // 读取库存品类配置（trackingMode）
  async function _readConfig(conn) {
    const [rows] = await conn.execute('SELECT id, data FROM inventory_config');
    return rows.map(r => { try { return JSON.parse(r.data); } catch { return { id: r.id }; } });
  }

  function _modeOf(invType, configItems) {
    const direct = (configItems || []).find(c => c && c.id === invType);
    if (direct) return direct.trackingMode === 'quantity' ? 'quantity' : 'sn';
    const m = String(invType).match(/^(.+)_(left|right)$/);
    if (m) {
      const base = (configItems || []).find(c => c && c.id === m[1]);
      if (base) return base.trackingMode === 'quantity' ? 'quantity' : 'sn';
    }
    return 'sn'; // 未配置的旧类型默认 SN 模式（兼容）
  }

  // ========== 1. 发起盘点（快照） ==========
  async function handleCreateStocktake(req, res, user, body) {
    if (!isAdmin(user)) return sendJSON(res, { error: '仅管理员可发起盘点' }, 403);
    const scope = Array.isArray(body && body.scope) && body.scope.length > 0 ? body.scope : 'all';

    const id = `stk-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      const configItems = await _readConfig(conn);
      // 快照全部库存类型（Phase 1 多仓库：按品类聚合各仓库存量）
      const [invRows] = await conn.execute('SELECT inv_type, SUM(quantity) as quantity FROM inventory GROUP BY inv_type');
      const invMap = {};
      for (const r of invRows) invMap[r.inv_type] = r.quantity || 0;

      // 快照在手 SN（available），按 equipmentType+handType 归组
      const [snRows] = await conn.execute(
        "SELECT snCode, equipmentType, handType, updatedAt FROM sn_registry WHERE status = 'available' ORDER BY snCode"
      );
      const snByInv = {};
      for (const s of snRows) {
        const [eq, hand] = [s.equipmentType, s.handType];
        // snToInvType 逻辑内联（避免再注入一个依赖）：glove/dexterous_hand 特判 + 通用规则
        let invType = null;
        if (eq === 'glove') invType = hand === 'left' ? 'left_glove' : hand === 'right' ? 'right_glove' : null;
        else if (eq === 'dexterous_hand') invType = hand === 'left' ? 'left_dexterous_hand' : hand === 'right' ? 'right_dexterous_hand' : null;
        else if (hand === 'left' || hand === 'right') invType = `${eq}_${hand}`;
        else if (eq) invType = eq;
        if (!invType) continue;
        if (!snByInv[invType]) snByInv[invType] = [];
        snByInv[invType].push({ snCode: s.snCode, present: true });
      }

      // 组装 items
      const wanted = scope === 'all' ? Object.keys(invMap) : scope;
      const items = [];
      for (const invType of wanted) {
        const mode = _modeOf(invType, configItems);
        if (scope !== 'all' && !(invType in invMap) && !snByInv[invType]) continue; // 指定范围内不存在的类型跳过
        const item = {
          invType, mode,
          bookQty: mode === 'quantity' ? (invMap[invType] || 0) : (snByInv[invType] || []).length,
          actualQty: null,       // quantity 模式录入
          extraSns: [],          // SN 模式盘盈录入
        };
        if (mode === 'sn') item.snList = snByInv[invType] || [];
        items.push(item);
      }

      const st = {
        id, status: 'draft',
        scope, items,
        createdAt: new Date().toISOString(),
        createdBy: user.username,
      };
      await _saveStocktake(conn, st);
      await conn.commit();
      sendJSON(res, { success: true, stocktake: st });
    } catch (e) {
      await conn.rollback();
      sendJSON(res, { error: `创建盘点单失败: ${e.message}` }, 500);
    } finally {
      try { conn.release(); } catch {}
    }
  }

  // ========== 2. 盘点单列表 ==========
  async function handleListStocktakes(req, res, user) {
    const [rows] = await pool.execute('SELECT id, data, status FROM stocktakes ORDER BY id DESC LIMIT 100');
    sendJSON(res, rows.map(r => {
      let d = {};
      try { d = JSON.parse(r.data); } catch {}
      // 列表只回汇总，不带 SN 明细（控制响应体积）
      const items = Array.isArray(d.items) ? d.items : [];
      const summary = items.map(it => ({
        invType: it.invType, mode: it.mode, bookQty: it.bookQty,
        actualQty: it.mode === 'quantity' ? it.actualQty
          : (it.snList ? it.snList.filter(s => s.present !== false).length + (it.extraSns || []).length : null),
      }));
      return {
        id: r.id, status: r.status, scope: d.scope, createdAt: d.createdAt, createdBy: d.createdBy,
        completedAt: d.completedAt, completedBy: d.completedBy, result: d.result || null,
        itemCount: items.length, summary,
      };
    }));
  }

  // ========== 3. 盘点单详情 ==========
  async function handleGetStocktake(req, res, user, id) {
    const st = await _getStocktake(pool, id);
    if (!st) return sendJSON(res, { error: '盘点单不存在' }, 404);
    sendJSON(res, st);
  }

  // ========== 4. 保存实盘录入（草稿） ==========
  async function handleSaveStocktake(req, res, user, id, body) {
    if (!isAdmin(user)) return sendJSON(res, { error: '仅管理员可录入盘点' }, 403);
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const st = await _getStocktake(conn, id);
      if (!st) { await conn.rollback(); return sendJSON(res, { error: '盘点单不存在' }, 404); }
      if (st.status !== 'draft') { await conn.rollback(); return sendJSON(res, { error: '盘点单已完成，不可修改' }, 400); }

      const updates = Array.isArray(body && body.items) ? body.items : [];
      for (const u of updates) {
        const item = (st.items || []).find(it => it.invType === u.invType);
        if (!item) continue;
        if (item.mode === 'quantity') {
          if (u.actualQty != null && Number.isFinite(Number(u.actualQty)) && Number(u.actualQty) >= 0) {
            item.actualQty = Math.round(Number(u.actualQty));
          }
        } else {
          // SN 模式：present 布尔 + 盘盈列表
          if (Array.isArray(u.missingSns)) {
            const missing = new Set(u.missingSns.map(String));
            (item.snList || []).forEach(s => { if (missing.has(s.snCode)) s.present = false; });
          }
          if (Array.isArray(u.presentSns)) {
            const present = new Set(u.presentSns.map(String));
            (item.snList || []).forEach(s => { if (present.has(s.snCode)) s.present = true; });
          }
          if (Array.isArray(u.extraSns)) {
            item.extraSns = [...new Set(u.extraSns.map(s => String(s).trim()).filter(Boolean))];
          }
        }
      }
      await _saveStocktake(conn, st);
      await conn.commit();
      sendJSON(res, { success: true, stocktake: st });
    } catch (e) {
      await conn.rollback();
      sendJSON(res, { error: `保存失败: ${e.message}` }, 500);
    } finally {
      try { conn.release(); } catch {}
    }
  }

  // ========== 5. 完成盘点（执行差异调整） ==========
  async function handleCompleteStocktake(req, res, user, id) {
    if (!isAdmin(user)) return sendJSON(res, { error: '仅管理员可完成盘点' }, 403);
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const st = await _getStocktake(conn, id);
      if (!st) { await conn.rollback(); return sendJSON(res, { error: '盘点单不存在' }, 404); }
      if (st.status !== 'draft') { await conn.rollback(); return sendJSON(res, { error: '盘点单已完成' }, 400); }

      const now = new Date().toISOString();
      const adjustments = [];
      let touchedSN = false;

      for (const item of st.items || []) {
        if (item.mode === 'quantity') {
          if (item.actualQty == null) continue; // 未录入则跳过（不调整）
          // Phase 1 多仓库：盘点以主仓库为记账口径（快照/实盘均为各仓聚合值，差异调整落到 main）
          const [rows] = await conn.execute('SELECT quantity FROM inventory WHERE inv_type = ? AND warehouse_id = ? FOR UPDATE', [item.invType, 'main']);
          const currentQty = rows.length > 0 ? rows[0].quantity : 0;
          const diff = item.actualQty - currentQty;
          if (diff === 0) continue;
          await conn.execute(
            'REPLACE INTO inventory (inv_type, warehouse_id, quantity, updatedAt, updatedBy) VALUES (?, ?, ?, ?, ?)',
            [item.invType, 'main', item.actualQty, now, user.username]
          );
          // 结构化库存审计（Phase 1）
          try {
            await conn.execute(
              'INSERT INTO inventory_audit (id, ts, operator_id, operator, action, warehouse_id, inv_type, note, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
              [`ia-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, now, user.userId || '', user.username || '', 'stocktake_adjust', 'main', item.invType, `盘点差异调整 ${diff > 0 ? '+' : ''}${diff}`, JSON.stringify({ bookQty: item.bookQty, actualQty: item.actualQty, diff })]
            );
          } catch {}
          const [eqType, hType] = _invTypeToSNFields(item.invType);
          await _insertTransaction(conn, {
            id: `stk-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
            equipmentType: eqType, handType: hType, invType: item.invType,
            direction: diff > 0 ? 'in' : 'out', quantity: Math.abs(diff),
            snCode: '', machineNumber: '', updatedBy: user.username, timestamp: now,
            note: `盘点调整（账面${currentQty}→实盘${item.actualQty}）`, refType: 'stocktake', refId: st.id,
          });
          adjustments.push({ invType: item.invType, mode: 'quantity', bookQty: item.bookQty, actualQty: item.actualQty, diff });
        } else {
          // SN 模式
          const missing = (item.snList || []).filter(s => s.present === false);
          const extra = (item.extraSns || []).slice();
          if (missing.length === 0 && extra.length === 0) continue;
          // 缺失 SN → scrapped（保守处理：保留记录可追溯，不参与库存计数）
          for (const s of missing) {
            await conn.execute(
              "UPDATE sn_registry SET status = 'scrapped', damageReason = ?, updatedAt = ? WHERE snCode = ?",
              [`盘点缺失（${st.id}）`, now, s.snCode]
            );
          }
          // 盘盈 SN → 入库 available
          for (const sn of extra) {
            const [eqType, hType] = _invTypeToSNFields(item.invType);
            await conn.execute(
              'INSERT INTO sn_registry (snCode, equipmentType, handType, status, machineNumber, trackingNumber, damageReason, shippedAt, repairedAt, attachment, updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?) ' +
              'ON DUPLICATE KEY UPDATE status = VALUES(status), updatedAt = VALUES(updatedAt)',
              [sn, eqType, hType, 'available', '', '', '', '', '', '', now]
            );
          }
          const [eqType, hType] = _invTypeToSNFields(item.invType);
          if (missing.length > 0) {
            await _insertTransaction(conn, {
              id: `stk-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
              equipmentType: eqType, handType: hType, invType: item.invType,
              direction: 'out', quantity: missing.length,
              snCode: missing.map(s => s.snCode).join(', '), machineNumber: '',
              updatedBy: user.username, timestamp: now,
              note: `盘点缺失 ${missing.length} 件`, refType: 'stocktake', refId: st.id,
            });
          }
          if (extra.length > 0) {
            await _insertTransaction(conn, {
              id: `stk-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
              equipmentType: eqType, handType: hType, invType: item.invType,
              direction: 'in', quantity: extra.length,
              snCode: extra.join(', '), machineNumber: '',
              updatedBy: user.username, timestamp: now,
              note: `盘盈入库 ${extra.length} 件`, refType: 'stocktake', refId: st.id,
            });
          }
          adjustments.push({
            invType: item.invType, mode: 'sn', bookQty: item.bookQty,
            missingSns: missing.map(s => s.snCode), extraSns: extra,
            diff: extra.length - missing.length,
          });
          touchedSN = true;
        }
      }

      // SN 侧有变动则重算库存
      if (touchedSN) await _syncInventoryFromSN(conn);

      st.status = 'completed';
      st.completedAt = now;
      st.completedBy = user.username;
      st.result = {
        adjustments,
        adjustedCount: adjustments.length,
        totalDiff: adjustments.reduce((s, a) => s + (a.diff || 0), 0),
      };
      await _saveStocktake(conn, st);
      await conn.commit();
      broadcastChange('sn_registry', ['inventory', 'transactions'], { action: 'stocktake', id: st.id });
      sendJSON(res, { success: true, stocktake: st });
    } catch (e) {
      await conn.rollback();
      sendJSON(res, { error: `完成盘点失败: ${e.message}` }, 500);
    } finally {
      try { conn.release(); } catch {}
    }
  }

  // ========== 6. 取消盘点单 ==========
  async function handleCancelStocktake(req, res, user, id) {
    if (!isAdmin(user)) return sendJSON(res, { error: '仅管理员可取消盘点' }, 403);
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const st = await _getStocktake(conn, id);
      if (!st) { await conn.rollback(); return sendJSON(res, { error: '盘点单不存在' }, 404); }
      if (st.status === 'completed') { await conn.rollback(); return sendJSON(res, { error: '已完成的盘点单不可取消' }, 400); }
      await conn.execute('DELETE FROM stocktakes WHERE id = ?', [id]);
      await conn.commit();
      sendJSON(res, { success: true });
    } catch (e) {
      await conn.rollback();
      sendJSON(res, { error: `取消失败: ${e.message}` }, 500);
    } finally {
      try { conn.release(); } catch {}
    }
  }

  return {
    handleCreateStocktake,
    handleListStocktakes,
    handleGetStocktake,
    handleSaveStocktake,
    handleCompleteStocktake,
    handleCancelStocktake,
  };
};
