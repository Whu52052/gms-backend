/**
 * src/handlers/sn-registry.js
 * SN-registry-domain HTTP handlers — extracted from server.js (Phase 2.1 step6).
 *
 * Covers the SN (glove) lifecycle: upsert / batch-insert / ship-to-repair /
 * repair-complete / delete / status-change, plus the public QR-code & status
 * endpoints used by the WeChat-scanned mobile page.
 *
 * Same factory / dependency-injection pattern as the other domains.
 *
 * Handlers in this domain (URL → handler):
 *   GET    /api/sn-registry                       → handleGetSNRegistry
 *   POST   /api/sn-registry                       → handleUpsertSNRegistry
 *   POST   /api/sn-registry/batch-insert            → handleBatchInsertSNRegistry
 *   POST   /api/sn-registry/delete-full            → handleDeleteSNFull
 *   POST   /api/sn-registry/ship                   → handleShipSN
 *   POST   /api/sn-registry/repair-complete        → handleRepairCompleteSN
 *   DELETE /api/sn-registry/:snCode                → handleDeleteSNRegistry
 *   POST   /api/sn-status-change                   → handleSNStatusChange
 *   GET    /api/sn-registry/:snCode/status         → handleGetSNStatus      (public)
 *   GET    /api/sn-registry/:snCode/history         → handleGetSNStatusHistory (public)
 *   GET    /api/qr-code/:snCode                    → handleGenerateQRCode    (public)
 *   GET    /api/export/sn-links-xlsx               → handleExportSNLinksXLSX (auth)
 *
 * Internal helpers / module-level state (not exported):
 *   _updateMachineStatusInTxn — in-transaction machine-status cascade used by
 *     handleSNStatusChange (left+right both bound → online; either unbound → offline).
 *     Skips waiting_repair/repairing so the tech-support flow owns those statuses.
 *   qrCodeCache (Map) + QR_CACHE_MAX_SIZE — LRU-ish PNG cache for handleGenerateQRCode
 *     (QR is static per SN, so cached aggressively).
 *
 * Deps: pool, sendJSON, _cached (cache wrapper), _syncInventoryFromSN (server.js,
 * has broadcastSSE side effect), _insertTransaction (lib/db-helpers alias),
 * _getStatusLabel (lib/mappings alias), broadcastChange (Phase 1.2 helper).
 *
 * External requires: `qrcode` (QRCode.toDataURL). Module-level cache state lives
 * here (was const qrCodeCache in server.js, only used by handleGenerateQRCode).
 * `_updateMachineStatusInTxn` moved here from server.js (only caller is
 * handleSNStatusChange); its body is unchanged.
 */
'use strict';

const QRCode = require('qrcode');
const { requireAdmin } = require('./_permissions');
// xlsx is also required lazily inside handleExportSNLinksXLSX to keep startup
// cost down (only loaded when export is actually invoked), matching the
// pattern in tech-support.js handleExportTechSupportXLSX.

// QR Code cache - since QR codes are static (SN doesn't change), cache them
const qrCodeCache = new Map();
const QR_CACHE_MAX_SIZE = 500;

// Build the public base URL from an incoming request.
// Node's raw http module does NOT set req.protocol (that's an Express property),
// so we read X-Forwarded-Proto (set by reverse proxies) and fall back to 'http'.
// Used by both handleGenerateQRCode and handleExportSNLinksXLSX so that exported
// QR codes / Excel links are valid absolute URLs regardless of deployment.
function _reqBaseURL(req) {
  const proto = (req.headers && req.headers['x-forwarded-proto']) || 'http';
  const host = (req.headers && req.headers.host) || 'localhost';
  return `${proto}://${host}`;
}

module.exports = function createSNRegistryHandlers(deps) {
  const {
    pool,
    sendJSON,
    _cached,
    _syncInventoryFromSN,
    _insertTransaction,
    _getStatusLabel,
    broadcastChange,
  } = deps;

  // ==================== INTERNAL HELPER: in-txn machine-status cascade ====================
  // 关键：跳过 waiting_repair/repairing 状态，保留技术支持流程对机器状态的独占管理
  async function _updateMachineStatusInTxn(conn, machineNumber, newStatus, now) {
    if (!machineNumber) return;
    const [rows] = await conn.execute(
      'SELECT id, data FROM machines WHERE machineNumber = ? ORDER BY updatedAt DESC, id DESC LIMIT 1 FOR UPDATE',
      [machineNumber]
    );
    if (rows.length === 0) {
      console.log(`[Machine Status InTxn] ${machineNumber} not found`);
      return;
    }
    const d = JSON.parse(rows[0].data);
    // 边界保护：机器处于技术支持流程设置的状态时，不被 SN 联动覆盖
    if (d.status === 'waiting_repair' || d.status === 'repairing') {
      console.log(`[Machine Status InTxn] skip ${machineNumber}: in ${d.status}`);
      return;
    }
    d.status = newStatus;
    d.updatedAt = now;
    await conn.execute(
      `INSERT INTO machines (id, data, machineNumber, status, updatedAt)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         data = VALUES(data), machineNumber = VALUES(machineNumber),
         status = VALUES(status), updatedAt = VALUES(updatedAt)`,
      [rows[0].id, JSON.stringify(d), d.machineNumber, d.status, d.updatedAt]
    );
    console.log(`[Machine Status InTxn] ${machineNumber} -> ${newStatus}`);
  }

  // ==================== SN REGISTRY ====================

  async function handleGetSNRegistry(req, res, authUser) {
    const rows = await _cached('sn_registry', async () => {
      // LEFT JOIN sn_status_history 取入库时间（reason 含"入库"的最早 createdAt）。
      // 用于前端按入库时间筛选。无入库记录的旧数据 inboundTime 为 null。
      const [r] = await pool.execute(
        `SELECT s.*, h.inboundTime
         FROM sn_registry s
         LEFT JOIN (
           SELECT snCode, MIN(createdAt) AS inboundTime
           FROM sn_status_history
           WHERE reason LIKE '%入库%'
           GROUP BY snCode
         ) h ON s.snCode = h.snCode
         ORDER BY s.updatedAt DESC LIMIT 5000`
      );
      return r;
    });
    sendJSON(res, rows);
  }

  async function handleUpsertSNRegistry(req, res, authUser, body) {
    // 普通用户可标记损坏/调用，但不能改其他字段（equipmentType/handType等由管理员设置）
    const { snCode, equipmentType, handType, status, machineNumber, damageReason, trackingNumber, attachment, shippedAt, repairedAt, source, location_code } = body;
    if (!snCode) return sendJSON(res, { error: 'SN码不能为空' }, 400);
    const now = new Date().toISOString();
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [existing] = await conn.execute('SELECT * FROM sn_registry WHERE snCode = ? FOR UPDATE', [snCode]);
      if (existing.length > 0) {
        const isAdmin = authUser.role === 'admin' || authUser.role === 'superadmin';
        const fields = ['equipmentType', 'handType', 'status', 'machineNumber', 'trackingNumber', 'damageReason', 'shippedAt', 'repairedAt', 'attachment', 'source', 'location_code'];
        const vals = {};
        fields.forEach(f => {
          if (f === 'equipmentType' || f === 'handType' || f === 'attachment' || f === 'source') {
            vals[f] = (isAdmin && body[f] !== undefined) ? body[f] : existing[0][f];
          } else {
            vals[f] = body[f] !== undefined ? body[f] : existing[0][f];
          }
        });
        vals.updatedAt = now;
        await conn.execute(
          'UPDATE sn_registry SET equipmentType=?, handType=?, status=?, machineNumber=?, trackingNumber=?, damageReason=?, shippedAt=?, repairedAt=?, attachment=?, source=?, location_code=?, updatedAt=? WHERE snCode=?',
          [vals.equipmentType, vals.handType, vals.status, vals.machineNumber, vals.trackingNumber, vals.damageReason, vals.shippedAt, vals.repairedAt, vals.attachment, vals.source, vals.location_code, vals.updatedAt, snCode]
        );
      } else {
        await conn.execute(
          'INSERT INTO sn_registry (snCode,equipmentType,handType,status,machineNumber,trackingNumber,damageReason,shippedAt,repairedAt,attachment,source,location_code,updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
          [snCode, equipmentType || '', handType || '', status || 'available', machineNumber || '', trackingNumber || '', damageReason || '', shippedAt || '', repairedAt || '', attachment || '', source || '', location_code || '', now]
        );
        // Insert initial history record for new SN
        const historyId = `h-${  Date.now()  }-${  Math.random().toString(36).substr(2, 9)}`;
        await conn.execute(
          'INSERT INTO sn_status_history (id, snCode, oldStatus, newStatus, operator, reason, machineNumber, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          [historyId, snCode, null, status || 'available', authUser.displayName || authUser.username, 'SN码入库初始化', machineNumber || '', now]
        );
      }
      await _syncInventoryFromSN(conn);
      await conn.commit();
      broadcastChange('sn_registry', ['inventory']);
      sendJSON(res, { success: true });
    } catch (e) {
      await conn.rollback();
      sendJSON(res, { error: e.message }, 500);
    } finally {
      try { conn.release(); } catch {}
    }
  }

  async function handleBatchInsertSNRegistry(req, res, authUser, body) {
    if (!requireAdmin(authUser, res, sendJSON, '仅管理员可批量入库')) return;
    const { snCodes } = body;
    if (!Array.isArray(snCodes) || snCodes.length === 0) {
      return sendJSON(res, { error: '请提供SN码列表' }, 400);
    }
    const now = new Date().toISOString();
    let inserted = 0, updated = 0, failed = 0;
    const errors = [];
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      for (const item of snCodes) {
        try {
          const { snCode, equipmentType, handType, source } = item;
          if (!snCode || typeof snCode !== 'string') { failed++; continue; }

          let eqType = equipmentType || '';
          let hType = handType || '';
          const src = source || '';

          // Auto-detect equipment type and hand type from SN code prefix
          // Pattern: XX[version][J/K]A... e.g. WG1JA..., WG1KA..., WH2JA..., WH2KA...
          // WG = glove, WH = dexterous_hand; J = left, K = right
          if (snCode.startsWith('WG')) {
            eqType = eqType || 'glove';
            hType = hType || (snCode[3] === 'J' ? 'left' : snCode[3] === 'K' ? 'right' : '');
          } else if (snCode.startsWith('WH')) {
            eqType = eqType || 'dexterous_hand';
            hType = hType || (snCode[3] === 'J' ? 'left' : snCode[3] === 'K' ? 'right' : '');
          }

          const [existing] = await conn.execute('SELECT snCode FROM sn_registry WHERE snCode = ? FOR UPDATE', [snCode]);
          if (existing.length > 0) {
            updated++;
          } else {
            await conn.execute(
              'INSERT INTO sn_registry (snCode,equipmentType,handType,status,machineNumber,trackingNumber,damageReason,shippedAt,repairedAt,attachment,source,updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
              [snCode, eqType, hType, 'available', '', '', '', '', '', '', src, now]
            );
            // Insert initial history record for new SN
            const historyId = `h-${  Date.now()  }-${  Math.random().toString(36).substr(2, 9)}`;
            await conn.execute(
              'INSERT INTO sn_status_history (id, snCode, oldStatus, newStatus, operator, reason, machineNumber, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
              [historyId, snCode, null, 'available', authUser.displayName || authUser.username, 'SN码批量入库初始化', '', now]
            );
            inserted++;
          }
        } catch (e) {
          failed++;
          errors.push(`${item.snCode}: ${e.message}`);
        }
      }
      await _syncInventoryFromSN(conn);
      await conn.commit();
      broadcastChange('sn_registry', ['inventory']);
      sendJSON(res, { success: true, inserted, updated, failed, errors });
    } catch (e) {
      await conn.rollback();
      sendJSON(res, { error: e.message }, 500);
    } finally {
      try { conn.release(); } catch {}
    }
  }

  async function handleShipSN(req, res, authUser, body) {
    const { snCode, trackingNumber, manufacturer } = body;
    if (!snCode || !trackingNumber) return sendJSON(res, { error: '缺少SN码或快递单号' }, 400);
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [existing] = await conn.execute('SELECT status, equipmentType, handType FROM sn_registry WHERE snCode = ? FOR UPDATE', [snCode]);
      if (existing.length === 0) {
        await conn.rollback();
        return sendJSON(res, { error: 'SN码不存在' }, 404);
      }
      if (existing[0].status !== 'damaged') {
        await conn.rollback();
        return sendJSON(res, { error: `当前状态 "${existing[0].status}" 不支持发货，仅有"损坏"状态的SN码可以发货返厂` }, 400);
      }
      const now = new Date().toISOString();
      await conn.execute(
        'UPDATE sn_registry SET status=?, trackingNumber=?, shippedAt=?, updatedAt=? WHERE snCode=?',
        ['in_repair', trackingNumber, now, now, snCode]
      );

      // Auto-create outbound order for repair shipment
      const orderNo = `OUT-${  Date.now().toString(36).toUpperCase()}`;
      const outboundId = `outb-${  orderNo}`;
      const dest = manufacturer || '厂家维修';
      await conn.execute(
        'INSERT INTO outbound_orders (id, order_no, destination, total_qty, shipped_qty, status, operator, note, source_type, related_sn, tracking_no, createdAt, shippedAt) VALUES (?, ?, ?, 1, 1, ?, ?, ?, ?, ?, ?, ?, ?)',
        [outboundId, orderNo, dest, 'completed', authUser.username, `SN ${snCode} 发货返厂维修`, 'repair', JSON.stringify([snCode]), trackingNumber, now, now]
      );

      await _syncInventoryFromSN(conn);
      await conn.commit();
      broadcastChange('sn_registry', ['inventory', 'transactions', 'outbound_orders']);
      sendJSON(res, { success: true, outboundOrderNo: orderNo });
    } catch (e) {
      await conn.rollback();
      sendJSON(res, { error: e.message }, 500);
    } finally {
      try { conn.release(); } catch {}
    }
  }

  async function handleRepairCompleteSN(req, res, authUser, body) {
    const { snCode, supplier } = body;
    if (!snCode) return sendJSON(res, { error: '缺少SN码' }, 400);
    const now = new Date().toISOString();
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [existing] = await conn.execute('SELECT * FROM sn_registry WHERE snCode = ? FOR UPDATE', [snCode]);
      if (existing.length > 0 && (existing[0].status === 'damaged' || existing[0].status === 'in_repair')) {
        await conn.execute(
          'UPDATE sn_registry SET status=?, repairedAt=?, updatedAt=? WHERE snCode=?',
          ['available', now, now, snCode]
        );

        // Auto-create inbound order for repaired return
        const orderNo = `INB-${  Date.now().toString(36).toUpperCase()}`;
        const inboundId = `inb-${  orderNo}`;
        const sup = supplier || '厂家维修返回';
        const trackingNo = existing[0].trackingNumber || '';

        // Find the related outbound order to link them
        let relatedOrderId = null;
        if (trackingNo) {
          const [prevOutbound] = await conn.execute(
            'SELECT id FROM outbound_orders WHERE related_sn LIKE ? AND source_type = ? ORDER BY createdAt DESC LIMIT 1',
            [`%${snCode}%`, 'repair']
          );
          if (prevOutbound.length > 0) relatedOrderId = prevOutbound[0].id;
        }

        await conn.execute(
          'INSERT INTO inbound_orders (id, order_no, supplier, total_qty, received_qty, status, operator, note, source_type, related_sn, related_order_id, createdAt, receivedAt) VALUES (?, ?, ?, 1, 1, ?, ?, ?, ?, ?, ?, ?, ?)',
          [inboundId, orderNo, sup, 'completed', authUser.username, `SN ${snCode} 维修完成入库`, 'repair', JSON.stringify([snCode]), relatedOrderId, now, now]
        );

        // Link back to outbound order
        if (relatedOrderId) {
          await conn.execute('UPDATE outbound_orders SET related_order_id = ? WHERE id = ?', [inboundId, relatedOrderId]);
        }

        await _syncInventoryFromSN(conn);
        await conn.commit();
        broadcastChange('sn_registry', ['inventory', 'transactions', 'inbound_orders']);
        sendJSON(res, { success: true, inboundOrderNo: orderNo });
      } else {
        await conn.rollback();
        sendJSON(res, { error: '该SN码状态不支持维修完成操作' }, 400);
      }
    } catch (e) {
      await conn.rollback();
      sendJSON(res, { error: e.message }, 500);
    } finally {
      conn.release();
    }
  }

  async function handleDeleteSNFull(req, res, authUser, body) {
    if (!requireAdmin(authUser, res, sendJSON, '仅管理员可执行此操作')) return;
    const { snCode } = body;
    if (!snCode) return sendJSON(res, { error: '缺少snCode' }, 400);
    const now = new Date().toISOString();
    const user = authUser.username;

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [existing] = await conn.execute('SELECT * FROM sn_registry WHERE snCode = ? FOR UPDATE', [snCode]);
      if (existing.length === 0) { await conn.rollback(); return sendJSON(res, { success: false, message: 'SN码不存在' }, 404); }

      await conn.execute('DELETE FROM sn_registry WHERE snCode = ?', [snCode]);

      await _syncInventoryFromSN(conn);

      const txId = `tx-del-${  Date.now().toString(36)}`;
      await _insertTransaction(conn, {
        id: txId, equipmentType: existing[0].equipmentType || '', handType: existing[0].handType || '',
        direction: 'out', quantity: 1, snCode: snCode, updatedBy: user,
        note: 'SN码删除', timestamp: now, refType: 'sn_delete', refId: snCode,
      });

      await conn.commit();
      broadcastChange('sn_registry', ['inventory', 'transactions']);
      sendJSON(res, { success: true });
    } catch (e) {
      await conn.rollback();
      sendJSON(res, { error: e.message }, 500);
    } finally {
      conn.release();
    }
  }

  async function handleDeleteSNRegistry(req, res, authUser, snCode) {
    if (!requireAdmin(authUser, res, sendJSON, '仅管理员可删除SN码')) return;
    const now = new Date().toISOString();
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [existing] = await conn.execute('SELECT * FROM sn_registry WHERE snCode = ? FOR UPDATE', [snCode]);
      if (existing.length === 0) {
        await conn.rollback();
        return sendJSON(res, { success: false, message: 'SN码不存在' }, 404);
      }
      await conn.execute('DELETE FROM sn_registry WHERE snCode = ?', [snCode]);
      await _syncInventoryFromSN(conn);

      const txId = `tx-del-${  Date.now().toString(36)}`;
      await _insertTransaction(conn, {
        id: txId, equipmentType: existing[0].equipmentType || '', handType: existing[0].handType || '',
        direction: 'out', quantity: 1, snCode: snCode, updatedBy: authUser.username,
        note: 'SN码删除', timestamp: now, refType: 'sn_delete', refId: snCode,
      });

      await conn.commit();
      broadcastChange('sn_registry', ['inventory', 'transactions']);
      sendJSON(res, { success: true });
    } catch (e) {
      await conn.rollback();
      sendJSON(res, { error: e.message }, 500);
    } finally {
      try { conn.release(); } catch {}
    }
  }

  // ==================== SN Status QR Code API (public) ====================

  async function handleGetSNStatus(req, res, snCode) {
    try {
      const [rows] = await pool.execute('SELECT * FROM sn_registry WHERE snCode = ?', [snCode]);
      if (rows.length === 0) {
        return sendJSON(res, { error: 'SN码不存在' }, 404);
      }
      const sn = rows[0];

      // Get latest machine status（用冗余列索引替代 JSON_EXTRACT）
      let machineStatus = null;
      if (sn.machineNumber) {
        const [machineRows] = await pool.execute(
          "SELECT data FROM machines WHERE machineNumber = ? ORDER BY updatedAt DESC, id DESC LIMIT 1",
          [sn.machineNumber]
        );
        if (machineRows.length > 0) {
          const machine = JSON.parse(machineRows[0].data);
          machineStatus = {
            status: machine.status || 'offline',
            onlineTime: machine.onlineTime || null,
            offlineTime: machine.offlineTime || null
          };
        }
      }

      sendJSON(res, {
        success: true,
        snCode: sn.snCode,
        equipmentType: sn.equipmentType,
        handType: sn.handType,
        status: sn.status,
        statusLabel: _getStatusLabel(sn.status),
        machineNumber: sn.machineNumber,
        damageReason: sn.damageReason,
        trackingNumber: sn.trackingNumber,
        shippedAt: sn.shippedAt,
        repairedAt: sn.repairedAt,
        updatedAt: sn.updatedAt,
        machineStatus: machineStatus
      });
    } catch (e) {
      console.error('[SN Status] Error:', e);
      sendJSON(res, { error: '服务器内部错误' }, 500);
    }
  }

  async function handleGenerateQRCode(req, res, snCode) {
    try {
      const sn = decodeURIComponent(snCode);

      // Check cache first
      if (qrCodeCache.has(sn)) {
        const cached = qrCodeCache.get(sn);
        res.writeHead(200, {
          'Content-Type': 'image/png',
          'Content-Length': cached.length,
          'Cache-Control': 'public, max-age=86400'
        });
        res.end(cached);
        return;
      }

      const baseURL = _reqBaseURL(req);
      const qrContent = `${baseURL}/sn-status.html?sn=${encodeURIComponent(sn)}`;

      const dataUrl = await QRCode.toDataURL(qrContent, {
        width: 200,
        color: { dark: '#1e293b', light: '#ffffff' },
        margin: 2,
        errorCorrectionLevel: 'H'
      });

      // Extract base64 data
      const base64Data = dataUrl.split(',')[1];
      const buffer = Buffer.from(base64Data, 'base64');

      // Add to cache (LRU-like: evict oldest if full)
      if (qrCodeCache.size >= QR_CACHE_MAX_SIZE) {
        const oldestKey = qrCodeCache.keys().next().value;
        qrCodeCache.delete(oldestKey);
      }
      qrCodeCache.set(sn, buffer);

      res.writeHead(200, {
        'Content-Type': 'image/png',
        'Content-Length': buffer.length,
        'Cache-Control': 'public, max-age=86400'
      });
      res.end(buffer);
    } catch (e) {
      console.error('[QR Code] Error:', e);
      sendJSON(res, { error: '二维码生成失败' }, 500);
    }
  }

  async function handleGetSNStatusHistory(req, res, snCode) {
    try {
      const [rows] = await pool.execute(
        'SELECT * FROM sn_status_history WHERE snCode = ? ORDER BY createdAt DESC',
        [snCode]
      );
      sendJSON(res, {
        success: true,
        history: rows.map(r => ({
          id: r.id,
          oldStatus: r.oldStatus,
          oldStatusLabel: r.oldStatus ? _getStatusLabel(r.oldStatus) : null,
          newStatus: r.newStatus,
          newStatusLabel: _getStatusLabel(r.newStatus),
          operator: r.operator,
          reason: r.reason,
          machineNumber: r.machineNumber,
          createdAt: r.createdAt
        }))
      });
    } catch (e) {
      console.error('[SN History] Error:', e);
      sendJSON(res, { error: '服务器内部错误' }, 500);
    }
  }

  async function handleSNStatusChange(req, res, authUser, body) {
    const { snCode, newStatus, reason, machineNumber, trackingNumber } = body;
    if (!snCode || !newStatus) {
      return sendJSON(res, { error: 'SN码和新状态不能为空' }, 400);
    }

    // 运维系统用户可修改手套状态（移动端操作），运营系统仅管理员可操作
    if (authUser.system !== 'maintenance' && authUser.role !== 'admin' && authUser.role !== 'superadmin') {
      return sendJSON(res, { error: '仅管理员可修改状态' }, 403);
    }

    const now = new Date().toISOString();
    const conn = await pool.getConnection();

    try {
      await conn.beginTransaction();

      const [existing] = await conn.execute('SELECT * FROM sn_registry WHERE snCode = ? FOR UPDATE', [snCode]);
      if (existing.length === 0) {
        await conn.rollback();
        return sendJSON(res, { error: 'SN码不存在' }, 404);
      }

      const oldStatus = existing[0].status;
      const snHandType = existing[0].handType;
      const allowedTransitions = {
        available: new Set(['damaged', 'in_repair', 'in_use', 'transferred', 'shipped', 'scrapped']),
        in_use: new Set(['available', 'damaged', 'in_repair', 'transferred', 'scrapped']),
        damaged: new Set(['available', 'in_repair', 'scrapped']),
        in_repair: new Set(['available', 'damaged', 'repaired', 'scrapped']),
        repaired: new Set(['available', 'in_use', 'scrapped']),
        transferred: new Set(['available', 'in_use', 'scrapped']),
        shipped: new Set(['scrapped']),
        scrapped: new Set(),
      };
      if (!allowedTransitions[oldStatus] || !allowedTransitions[oldStatus].has(newStatus)) {
        await conn.rollback();
        return sendJSON(res, { error: `不允许将状态从 ${oldStatus} 变更为 ${newStatus}` }, 409);
      }
      // 关键：UPDATE 前快照旧机器编号，避免解绑（machineNumber=null）后丢失联动目标
      const oldMachineNumber = existing[0].machineNumber || null;
      // 请求体显式传 machineNumber（含 null=解绑）才覆盖，否则沿用旧值
      const effectiveMachineNumber = (machineNumber !== undefined) ? machineNumber : oldMachineNumber;

      // 上线业务规则校验：每台机器在使用状态下仅允许同时关联一只左手手套和一只右手手套
      if (newStatus === 'in_use' && effectiveMachineNumber) {
        const [conflictRows] = await conn.execute(
          "SELECT snCode, handType FROM sn_registry WHERE machineNumber = ? AND status = 'in_use' AND snCode != ? FOR UPDATE",
          [effectiveMachineNumber, snCode]
        );
        const sameHandConflict = conflictRows.find(r => r.handType === snHandType);
        if (sameHandConflict) {
          await conn.rollback();
          const handLabel = snHandType === 'left' ? '左手' : snHandType === 'right' ? '右手' : '该手型';
          return sendJSON(res, {
            error: `机器 ${effectiveMachineNumber} 已绑定${handLabel}手套（${sameHandConflict.snCode}），无法重复上线`
          }, 409);
        }
      }

      // Update sn_registry
      const updateFields = [];
      const updateValues = [];

      updateFields.push('status = ?');
      updateValues.push(newStatus);

      if (machineNumber !== undefined) {
        updateFields.push('machineNumber = ?');
        updateValues.push(machineNumber);
      }
      if (reason) {
        updateFields.push('damageReason = ?');
        updateValues.push(reason);
      }
      if (trackingNumber) {
        updateFields.push('trackingNumber = ?');
        updateValues.push(trackingNumber);
      }
      if (newStatus === 'shipped') {
        updateFields.push('shippedAt = ?');
        updateValues.push(now);
      }
      if (newStatus === 'repaired') {
        updateFields.push('repairedAt = ?');
        updateValues.push(now);
      }

      updateFields.push('updatedAt = ?');
      updateValues.push(now);
      updateValues.push(snCode);

      await conn.execute(
        `UPDATE sn_registry SET ${updateFields.join(', ')} WHERE snCode = ?`,
        updateValues
      );

      // Insert history record
      const historyId = `h-${  Date.now()  }-${  Math.random().toString(36).substr(2, 9)}`;
      await conn.execute(
        'INSERT INTO sn_status_history (id, snCode, oldStatus, newStatus, operator, reason, machineNumber, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [historyId, snCode, oldStatus, newStatus, authUser.displayName || authUser.username, reason || '', effectiveMachineNumber || '', now]
      );

      // 机器状态联动（移入事务，用同一锁定连接 + FOR UPDATE，消除原 commit 后查询的竞态）
      // 规则: 左右手都绑定 → online；仅一只绑定 → partial；无绑定 → offline
      // 修复：之前只在"左右手都绑定"时才更新为 online，忽略了 partial 状态，导致
      // machines 表 status 字段与实际绑定情况不一致（/api/machines 返回过时状态）。
      if (newStatus === 'in_use' && effectiveMachineNumber) {
        const [counts] = await conn.execute(
          "SELECT handType FROM sn_registry WHERE machineNumber = ? AND status = 'in_use' FOR UPDATE",
          [effectiveMachineNumber]
        );
        const hands = new Set(counts.map(c => c.handType));
        if (hands.has('left') && hands.has('right')) {
          await _updateMachineStatusInTxn(conn, effectiveMachineNumber, 'online', now);
        } else if (hands.has('left') || hands.has('right')) {
          // partial：只有一只手绑定（之前缺失的分支）
          await _updateMachineStatusInTxn(conn, effectiveMachineNumber, 'partial', now);
        }
      } else if (newStatus !== 'in_use' && oldStatus === 'in_use' && oldMachineNumber) {
        // 关键：用 oldMachineNumber（解绑前的机器），不要用 effectiveMachineNumber
        // 否则 machineNumber=null 时会漏掉联动（"机器下线了手套还显示绑定"的根因）
        const [counts] = await conn.execute(
          "SELECT handType FROM sn_registry WHERE machineNumber = ? AND status = 'in_use' FOR UPDATE",
          [oldMachineNumber]
        );
        const hands = new Set(counts.map(c => c.handType));
        if (hands.size > 0) {
          // 解绑一只手后，另一只手仍在 → partial（之前缺失的分支）
          await _updateMachineStatusInTxn(conn, oldMachineNumber, 'partial', now);
        } else {
          // 无 in_use 手套 → offline
          await _updateMachineStatusInTxn(conn, oldMachineNumber, 'offline', now);
        }
      }

      // Sync inventory table from sn_registry - ensure consistency
      await _syncInventoryFromSN(conn);

      await conn.commit();

      broadcastChange('sn_registry', ['inventory', 'machines']);
      sendJSON(res, { success: true });
    } catch (e) {
      await conn.rollback();
      // 行锁范围扩大后理论上可能死锁，重试一次
      if (e.code === 'ER_LOCK_DEADLOCK' && !body.__retried) {
        body.__retried = true;
        console.warn('[SN Status Change] Deadlock, retrying once');
        conn.release();
        return handleSNStatusChange(req, res, authUser, body);
      }
      console.error('[SN Status Change] Error:', e);
      sendJSON(res, { error: e.message }, 500);
    } finally {
      // 死锁重试路径已在 catch 中 release 并 return，这里 try-catch 容错避免 double-release
      try { conn.release(); } catch {}
    }
  }

  // ==================== EXPORT TO XLSX ====================
  // Exports filtered SN registry rows (with their status-query links) as an .xlsx
  // file. Mirrors handleExportTechSupportXLSX in tech-support.js: lazily require
  // `xlsx`, build a worksheet with json_to_sheet, set column widths, and stream
  // the buffer back with a UTF-8 filename.
  //
  // Query params (all optional — mirror the SN Links page's filter UI):
  //   status = all | available | in_use | damaged | in_repair | transferred
  //   search = free-text (matches snCode / machineNumber / handType / equipmentType)
  //   inboundStart = YYYY-MM-DD (inclusive, filters by 入库时间)
  //   inboundEnd   = YYYY-MM-DD (inclusive)
  //
  // The status-query URL is built from the request host (same scheme as
  // handleGenerateQRCode) so the exported links work regardless of which
  // front-end instance generated the export.
  async function handleExportSNLinksXLSX(req, res, authUser) {
    const XLSX = require('xlsx');
    const baseURL = _reqBaseURL(req);
    const url = new URL(req.url, baseURL);
    const statusFilter = url.searchParams.get('status') || 'all';
    const search = (url.searchParams.get('search') || '').trim().toLowerCase();
    const inboundStart = url.searchParams.get('inboundStart'); // YYYY-MM-DD
    const inboundEnd = url.searchParams.get('inboundEnd');     // YYYY-MM-DD

    // LEFT JOIN sn_status_history 取入库时间（与 handleGetSNRegistry 一致）。
    // 日期筛选在 JS 层做（数据量小，避免 SQL 字符串日期比较的索引失效）。
    // inboundStart/End 均为闭区间（含当天）。inboundTime 为 null 的旧数据
    // 在指定了任一端时会被排除（无法判断是否在范围内）。
    const [rows] = await pool.execute(
      `SELECT s.snCode, s.equipmentType, s.handType, s.status, s.machineNumber,
              s.updatedAt, h.inboundTime
       FROM sn_registry s
       LEFT JOIN (
         SELECT snCode, MIN(createdAt) AS inboundTime
         FROM sn_status_history
         WHERE reason LIKE '%入库%'
         GROUP BY snCode
       ) h ON s.snCode = h.snCode
       ORDER BY s.updatedAt DESC LIMIT 10000`
    );
    let data = rows;
    if (statusFilter && statusFilter !== 'all') {
      data = data.filter(r => r.status === statusFilter);
    }
    if (search) {
      data = data.filter(r =>
        (r.snCode && r.snCode.toLowerCase().includes(search)) ||
        (r.machineNumber && r.machineNumber.toLowerCase().includes(search)) ||
        (r.handType && r.handType.toLowerCase().includes(search)) ||
        (r.equipmentType && r.equipmentType.toLowerCase().includes(search))
      );
    }
    if (inboundStart || inboundEnd) {
      const startMs = inboundStart ? new Date(`${inboundStart  }T00:00:00`).getTime() : -Infinity;
      // inboundEnd 含当天，所以截止到次日 00:00:00（即 < 次日）
      const endMs = inboundEnd ? new Date(`${inboundEnd  }T23:59:59.999`).getTime() : Infinity;
      data = data.filter(r => {
        if (!r.inboundTime) return false;
        const t = new Date(r.inboundTime).getTime();
        return t >= startMs && t <= endMs;
      });
    }

    const handMap = { left: '左手', right: '右手' };
    // 设备类型标签：内置三类型 + 从库存品类配置动态读取（多品类扩展）
    const eqMap = { glove: '手套', dexterous_hand: '灵巧手', gripper: '夹爪' };
    try {
      const [cfgRows] = await pool.execute('SELECT id, data FROM inventory_config');
      for (const row of cfgRows) {
        try {
          const c = JSON.parse(row.data);
          if (!c || !c.id) continue;
          const m = String(c.id).match(/^(.+)_(left|right)$/);
          const base = m ? m[1] : c.id; // SN 的 equipmentType 对应基础品类 id
          if (!eqMap[base]) eqMap[base] = String(c.name || '').replace(/左手|右手/g, '') || c.id;
        } catch { /* 坏配置行跳过 */ }
      }
    } catch { /* inventory_config 不可用时仅用内置映射 */ }
    const statusMap = {
      available: '库存可用', in_use: '使用中', damaged: '已损坏',
      in_repair: '售后维修中', transferred: '已转出', repaired: '已修复', shipped: '已发货',
    };
    const fm = t => t ? new Date(t).toLocaleString('zh-CN') : '-';

    const sheetRows = data.map(r => ({
      'SN码': r.snCode || '-',
      '手型': handMap[r.handType] || r.handType || '-',
      '设备类型': eqMap[r.equipmentType] || r.equipmentType || '-',
      '状态': statusMap[r.status] || r.status || '-',
      '绑定机器': r.machineNumber || '-',
      '入库时间': fm(r.inboundTime),
      '状态查询链接': r.snCode ? `${baseURL}/sn-status.html?sn=${encodeURIComponent(r.snCode)}` : '-',
      '更新时间': fm(r.updatedAt),
    }));

    const ws = XLSX.utils.json_to_sheet(sheetRows);
    ws['!cols'] = [
      { wch: 22 }, // SN码
      { wch: 8 },  // 手型
      { wch: 12 }, // 设备类型
      { wch: 14 }, // 状态
      { wch: 12 }, // 绑定机器
      { wch: 22 }, // 入库时间
      { wch: 60 }, // 状态查询链接
      { wch: 22 }, // 更新时间
    ];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'SN码链接');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

    const filename = encodeURIComponent(`SN码链接-${  new Date().toISOString().slice(0, 10)}`);
    res.writeHead(200, {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename*=UTF-8''${filename}.xlsx`,
      'Access-Control-Allow-Origin': '*',
    });
    res.end(buf);
  }

  return {
    handleGetSNRegistry,
    handleUpsertSNRegistry,
    handleBatchInsertSNRegistry,
    handleShipSN,
    handleRepairCompleteSN,
    handleDeleteSNFull,
    handleDeleteSNRegistry,
    handleGetSNStatus,
    handleGenerateQRCode,
    handleGetSNStatusHistory,
    handleSNStatusChange,
    handleExportSNLinksXLSX,
  };
};
