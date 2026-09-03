'use strict';

/**
 * Enhanced configuration handler with:
 * - Incremental add/update/delete for inventory config items
 * - Config file import (JSON)
 * - Audit logging for all operations
 * - Auto-initialize inventory records for new types
 * - Dual tracking mode (sn / quantity) per category
 */
const { invTypeToSNFields } = require('../../lib/mappings');

const TRACKING_MODES = ['sn', 'quantity'];

// 规范化跟踪模式：非法值回落 'sn'（兼容旧数据，旧品类无此字段）
function _normMode(v) {
  return TRACKING_MODES.includes(v) ? v : 'sn';
}

// 品类语义约束：左右手类型仅对 SN 精细跟踪有意义（手套类机器绑定需要左右手语义），
// 纯数量跟踪（耗材类）不分左右手 —— 强制关闭，避免产生两个无意义的数量计数器
function _applyCategoryRules(item) {
  if (item.trackingMode === 'quantity') item.hasLeftRight = false;
  return item;
}

module.exports = function createConfigurationHandlers(deps) {
  const { pool, sendJSON, _cached, readJSONArray, deleteJSON, broadcastSSE, broadcastChange } = deps;
  const isAdmin = user => user && ['admin', 'superadmin'].includes(user.role);

  // ========== 模式切换保护 ==========
  // 切换 trackingMode 要求该品类完全无数据（无 SN 记录且库存为 0），
  // 否则 SN 化重算与纯数量计数会互相覆盖，造成库存错乱
  async function _assertModeSwitchAllowed(conn, configItem, oldMode, newMode, username) {
    if (oldMode === newMode) return;
    const invTypes = configItem.hasLeftRight
      ? [`${configItem.id}_left`, `${configItem.id}_right`]
      : [configItem.id];
    // SN 记录检查（invType → sn_registry 的 equipmentType/handType）
    let snCount = 0;
    for (const t of invTypes) {
      const [eq, hand] = invTypeToSNFields(t);
      const [rows] = await conn.execute(
        'SELECT COUNT(*) as c FROM sn_registry WHERE equipmentType = ? AND handType = ?',
        [eq, hand]
      );
      snCount += rows[0].c;
    }
    // 库存余量检查（Phase 1 多仓库：聚合各仓库余量）
    let qty = 0;
    for (const t of invTypes) {
      const [rows] = await conn.execute('SELECT COALESCE(SUM(quantity),0) as qty FROM inventory WHERE inv_type = ?', [t]);
      qty += rows.length > 0 ? (rows[0].qty || 0) : 0;
    }
    if (snCount > 0 || qty !== 0) {
      throw Object.assign(new Error(
        `该品类已有数据（SN记录 ${snCount} 条、库存余量 ${qty}），不能切换跟踪模式。请先清空该品类库存后再切换。`
      ), { statusCode: 409 });
    }
    void username;
  }

  // ========== Audit Log Helper ==========
  async function _addAuditLog(action, detail, user, conn) {
    const db = conn || pool;
    const id = `cfg-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    try {
      await db.execute(
        'INSERT INTO audit_log (id, data) VALUES (?, ?)',
        [id, JSON.stringify({ id, action, detail, user: user?.username || '系统', timestamp: new Date().toISOString() })]
      );
    } catch (e) { /* non-fatal */ }
  }

  // ========== Common helpers ==========
  async function getConfig(req, res, key, table) {
    sendJSON(res, await _cached(key, () => readJSONArray(table)));
  }

  async function saveConfig(req, res, user, body, table, event, denial) {
    if (!isAdmin(user)) return sendJSON(res, { error: denial }, 403);
    // 全表替换接口的安全闸：body 必须为非空数组。
    // 历史 bug：传单对象/空数组会 DELETE 全表且不写入任何行（曾导致 inventory_config 被清空）。
    if (!Array.isArray(body) || body.length === 0) {
      return sendJSON(res, { error: '批量保存必须提供非空数组（全表替换），单条操作请使用 item 接口' }, 400);
    }
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.execute(`DELETE FROM ${table}`);
      if (Array.isArray(body)) {
        for (const item of body) {
          // Ensure sku field exists
          if (!item.sku) item.sku = item.id;
          await conn.execute(`INSERT INTO ${table} (id, data) VALUES (?, ?)`, [item.id, JSON.stringify(item)]);
        }
      }
      await conn.commit();
      broadcastSSE(event, {});
      _addAuditLog('inventory_config_save', `批量保存库存配置，共 ${Array.isArray(body) ? body.length : 0} 项`, user);
      sendJSON(res, { success: true });
    } catch (error) {
      await conn.rollback();
      sendJSON(res, { error: `保存失败: ${error.message}` }, 500);
    } finally { conn.release(); }
  }

  async function deleteConfig(req, res, user, id, table, event, denial) {
    if (!isAdmin(user)) return sendJSON(res, { error: denial }, 403);
    await deleteJSON(table, id);
    broadcastSSE(event, {});
    _addAuditLog('inventory_config_delete', `删除库存配置: ${id}`, user);
    sendJSON(res, { success: true });
  }

  // ========== Inventory config: single item add ==========
  async function handleAddInventoryConfigItem(req, res, user, body) {
    if (!isAdmin(user)) return sendJSON(res, { error: '无权限添加库存配置' }, 403);

    const { name, sku, icon, hasLeftRight, trackingMode } = body;
    if (!name || !name.trim()) return sendJSON(res, { error: '库存名称不能为空' }, 400);
    if (!sku || !sku.trim()) return sendJSON(res, { error: 'SKU编码不能为空' }, 400);
    if (trackingMode !== undefined && !TRACKING_MODES.includes(trackingMode)) {
      return sendJSON(res, { error: `跟踪模式必须是 ${TRACKING_MODES.join('/')} 之一` }, 400);
    }

    const id = sku.trim().toLowerCase().replace(/[^a-z0-9_]/g, '_');
    const item = _applyCategoryRules({
      id,
      name: name.trim(),
      sku: sku.trim(),
      icon: icon || '',
      hasLeftRight: !!hasLeftRight,
      trackingMode: _normMode(trackingMode),
      createdAt: new Date().toISOString(),
    });

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      // Check for duplicate
      const [existing] = await conn.execute('SELECT id FROM inventory_config WHERE id = ?', [id]);
      if (existing.length > 0) {
        await conn.rollback();
        return sendJSON(res, { error: `SKU "${sku}" 已存在，请使用不同的SKU` }, 409);
      }

      await conn.execute('INSERT INTO inventory_config (id, data) VALUES (?, ?)', [id, JSON.stringify(item)]);

      // Auto-initialize inventory records（用规则修正后的值：quantity 模式不建 _left/_right）
      const now = new Date().toISOString();
      if (item.hasLeftRight) {
        await conn.execute(
          'REPLACE INTO inventory (inv_type, quantity, updatedAt, updatedBy) VALUES (?, 0, ?, ?)',
          [`${id}_left`, now, user.username]
        );
        await conn.execute(
          'REPLACE INTO inventory (inv_type, quantity, updatedAt, updatedBy) VALUES (?, 0, ?, ?)',
          [`${id}_right`, now, user.username]
        );
      } else {
        await conn.execute(
          'REPLACE INTO inventory (inv_type, quantity, updatedAt, updatedBy) VALUES (?, 0, ?, ?)',
          [id, now, user.username]
        );
      }

      await conn.commit();
      broadcastChange('inventory_config', ['inventory'], { action: 'add', id });
      _addAuditLog('inventory_config_add', `添加库存类型: ${name} (SKU: ${sku})`, user);
      sendJSON(res, { success: true, item });
    } catch (e) {
      await conn.rollback();
      sendJSON(res, { error: `添加失败: ${e.message}` }, 500);
    } finally {
      try { conn.release(); } catch {}
    }
  }

  // ========== Inventory config: single item update ==========
  async function handleUpdateInventoryConfigItem(req, res, user, id, body) {
    if (!isAdmin(user)) return sendJSON(res, { error: '无权限修改库存配置' }, 403);

    const { name, sku, icon, hasLeftRight, trackingMode } = body;
    if (!name || !name.trim()) return sendJSON(res, { error: '库存名称不能为空' }, 400);
    if (trackingMode !== undefined && !TRACKING_MODES.includes(trackingMode)) {
      return sendJSON(res, { error: `跟踪模式必须是 ${TRACKING_MODES.join('/')} 之一` }, 400);
    }

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      // Read existing
      const [rows] = await conn.execute('SELECT data FROM inventory_config WHERE id = ?', [id]);
      if (rows.length === 0) {
        await conn.rollback();
        return sendJSON(res, { error: '库存类型不存在' }, 404);
      }

      const existing = JSON.parse(rows[0].data);
      const oldMode = _normMode(existing.trackingMode);
      const newMode = _normMode(trackingMode !== undefined ? trackingMode : existing.trackingMode);
      // 模式切换保护：有库存/SN 数据时禁止切换
      await _assertModeSwitchAllowed(conn, { id, hasLeftRight: hasLeftRight !== undefined ? !!hasLeftRight : !!existing.hasLeftRight }, oldMode, newMode, user.username);
      const updatedItem = _applyCategoryRules({
        ...existing,
        name: name.trim(),
        icon: icon !== undefined ? icon : existing.icon,
        sku: sku || existing.sku || existing.id,
        hasLeftRight: hasLeftRight !== undefined ? !!hasLeftRight : existing.hasLeftRight,
        trackingMode: newMode,
      });

      await conn.execute('REPLACE INTO inventory_config (id, data) VALUES (?, ?)', [id, JSON.stringify(updatedItem)]);

      // Ensure inventory records exist
      const now = new Date().toISOString();
      if (updatedItem.hasLeftRight) {
        await conn.execute(
          'INSERT IGNORE INTO inventory (inv_type, quantity, updatedAt, updatedBy) VALUES (?, 0, ?, ?)',
          [`${id}_left`, now, user.username]
        );
        await conn.execute(
          'INSERT IGNORE INTO inventory (inv_type, quantity, updatedAt, updatedBy) VALUES (?, 0, ?, ?)',
          [`${id}_right`, now, user.username]
        );
      } else {
        await conn.execute(
          'INSERT IGNORE INTO inventory (inv_type, quantity, updatedAt, updatedBy) VALUES (?, 0, ?, ?)',
          [id, now, user.username]
        );
      }

      await conn.commit();
      broadcastSSE('inventory_config_updated', {});
      _addAuditLog('inventory_config_update', `更新库存类型: ${name} (ID: ${id})`, user);
      sendJSON(res, { success: true, item: updatedItem });
    } catch (e) {
      await conn.rollback();
      sendJSON(res, { error: e.statusCode ? e.message : `更新失败: ${e.message}` }, e.statusCode || 500);
    } finally {
      try { conn.release(); } catch {}
    }
  }

  // ========== Inventory config: import from JSON ==========
  async function handleImportInventoryConfig(req, res, user, body) {
    if (!isAdmin(user)) return sendJSON(res, { error: '无权限导入库存配置' }, 403);

    const { items } = body;
    if (!Array.isArray(items) || items.length === 0) {
      return sendJSON(res, { error: '请提供有效的库存配置数据（items 数组）' }, 400);
    }

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const now = new Date().toISOString();
      let added = 0, updated = 0, skipped = 0;

      for (const item of items) {
        if (!item.name || !item.name.trim()) { skipped++; continue; }

        const sku = (item.sku || item.id || item.name).trim().toLowerCase().replace(/[^a-z0-9_]/g, '_');
        const configItem = _applyCategoryRules({
          id: sku,
          name: item.name.trim(),
          sku: item.sku || sku,
          icon: item.icon || '',
          hasLeftRight: !!item.hasLeftRight,
          trackingMode: _normMode(item.trackingMode),
          createdAt: item.createdAt || now,
        });

        const [existingRows] = await conn.execute('SELECT data FROM inventory_config WHERE id = ?', [sku]);
        if (existingRows.length > 0) {
          // Update existing（模式切换保护同单项更新）
          const existing = JSON.parse(existingRows[0].data);
          await _assertModeSwitchAllowed(conn, configItem, _normMode(existing.trackingMode), configItem.trackingMode, user.username);
          await conn.execute('REPLACE INTO inventory_config (id, data) VALUES (?, ?)', [sku, JSON.stringify({ ...existing, ...configItem, createdAt: existing.createdAt })]);
          updated++;
        } else {
          await conn.execute('INSERT INTO inventory_config (id, data) VALUES (?, ?)', [sku, JSON.stringify(configItem)]);
          added++;
        }

        // Auto-initialize inventory records
        if (configItem.hasLeftRight) {
          await conn.execute(
            'INSERT IGNORE INTO inventory (inv_type, quantity, updatedAt, updatedBy) VALUES (?, 0, ?, ?)',
            [`${sku}_left`, now, user.username]
          );
          await conn.execute(
            'INSERT IGNORE INTO inventory (inv_type, quantity, updatedAt, updatedBy) VALUES (?, 0, ?, ?)',
            [`${sku}_right`, now, user.username]
          );
        } else {
          await conn.execute(
            'INSERT IGNORE INTO inventory (inv_type, quantity, updatedAt, updatedBy) VALUES (?, 0, ?, ?)',
            [sku, now, user.username]
          );
        }
      }

      await conn.commit();
      broadcastChange('inventory_config', ['inventory'], { action: 'import' });
      _addAuditLog('inventory_config_import', `导入库存配置: 新增 ${added} 项, 更新 ${updated} 项, 跳过 ${skipped} 项`, user);
      sendJSON(res, { success: true, added, updated, skipped, total: items.length });
    } catch (e) {
      await conn.rollback();
      sendJSON(res, { error: e.statusCode ? e.message : `导入失败: ${e.message}` }, e.statusCode || 500);
    } finally {
      try { conn.release(); } catch {}
    }
  }

  return {
    // Equipment config
    handleGetEquipmentConfig: (req, res) => getConfig(req, res, 'equipment_config', 'equipment_config'),
    handleSaveEquipmentConfig: (req, res, user, body) => saveConfig(req, res, user, body, 'equipment_config', 'equipment_config_updated', '无权限修改设备配置'),
    handleDeleteEquipmentConfig: (req, res, user, id) => deleteConfig(req, res, user, id, 'equipment_config', 'equipment_config_updated', '无权限删除设备配置'),

    // Inventory config (full replace - legacy)
    handleGetInventoryConfig: (req, res) => getConfig(req, res, 'inventory_config', 'inventory_config'),
    handleSaveInventoryConfig: (req, res, user, body) => saveConfig(req, res, user, body, 'inventory_config', 'inventory_config_updated', '无权限修改库存配置'),
    handleDeleteInventoryConfig: (req, res, user, id) => deleteConfig(req, res, user, id, 'inventory_config', 'inventory_config_updated', '无权限删除库存配置'),

    // Inventory config (incremental operations)
    handleAddInventoryConfigItem,
    handleUpdateInventoryConfigItem,
    handleImportInventoryConfig,
  };
};