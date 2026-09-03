/**
 * src/handlers/machines.js
 * Machine-domain HTTP handlers — extracted from server.js (Phase 2.1 step5).
 *
 * Covers machine-code discovery, machine records CRUD, one-machine-one-user
 * binding, and the transactional online/offline sync (handleSyncMachineState)
 * which is the most complex path: row-locked SN mutations + inventory recompute
 * + transaction write + machine record insert, all in one DB transaction.
 *
 * Same factory / dependency-injection pattern as auth/users/transactions/inventory.
 *
 * Handlers in this domain (URL → handler):
 *   GET    /api/machine-code                    → handleGetMachineCode  (os.hostname())
 *   GET    /api/mobile/machines                 → handleMobileGetMachines
 *   GET    /api/machines                        → handleGetMachines
 *   POST   /api/machines                        → handleAddMachine
 *   DELETE /api/machines/:id                    → handleDeleteMachine
 *   POST   /api/machines/:number/bind           → handleBindMachine
 *   POST   /api/machines/:number/unbind         → handleUnbindMachine
 *   GET    /api/machine-bindings                → handleGetMachineBindings
 *   POST   /api/machines/:number/sync-state     → handleSyncMachineState
 *
 * Internal helper (not exported): unbindGlovesFromMachine — transactional
 * release of all in_use gloves on a machine; shared by handleAddMachine and
 * handleUnbindMachine.
 *
 * Deps: pool, sendJSON, _cached (cache wrapper), _cache (Map for invalidation),
 * saveMachine (dual-write: JSON data + redundant cols), saveMachineBinding,
 * readJSONById, deleteJSON, saveJSON (audit_log), _syncInventoryFromSN
 * (server.js, has broadcastSSE side effect), _insertTransaction (lib/db-helpers
 * alias), _snToInvType (lib/mappings), broadcastChange (Phase 1.2 helper),
 * broadcastSSE.
 *
 * `os` is required directly (node built-in, no injection needed).
 * saveMachine / saveMachineBinding are kept in server.js because migration
 * code (migrateFromJSON) also calls them; passed here as deps.
 */
'use strict';

const os = require('os');

module.exports = function createMachinesHandlers(deps) {
  const {
    pool,
    sendJSON,
    _cached,
    _cache,
    saveMachine,
    saveMachineBinding,
    readJSONById,
    deleteJSON,
    saveJSON,
    _syncInventoryFromSN,
    _insertTransaction,
    _snToInvType,
    broadcastChange,
    broadcastSSE,
    loadEdgePresence,
  } = deps;

  // ==================== MACHINE-CODE UTILITY ====================

  function handleGetMachineCode(req, res) {
    const hostname = os.hostname();
    const machineCodeMatch = hostname.match(/^(we-\d+)$/);
    const machineCode = machineCodeMatch ? machineCodeMatch[1] : hostname;
    sendJSON(res, { machineCode, hostname });
  }

  // ==================== MOBILE MACHINES ====================

  async function handleMobileGetMachines(req, res) {
    try {
      // 获取所有机器最新状态
      const [rows] = await pool.execute('SELECT data FROM machines ORDER BY id DESC LIMIT 5000');
      const all = rows.map(r => JSON.parse(r.data));
      all.sort((a, b) => new Date(b.updatedAt || b.id) - new Date(a.updatedAt || a.id));
      const latest = new Map();
      for (const m of all) {
        const num = m.machineNumber;
        if (!num) continue;
        if (!latest.has(num)) latest.set(num, m);
      }
      const machines = Array.from(latest.values()).map(m => ({
        machineNumber: m.machineNumber,
        deviceType: m.deviceType || '',
        status: m.status || 'offline'
      }));

      // 获取所有使用中的手套绑定情况
      const [snRows] = await pool.execute(
        "SELECT snCode, handType, machineNumber FROM sn_registry WHERE status = 'in_use' AND machineNumber IS NOT NULL AND machineNumber != ''"
      );
      const occupancy = {};
      for (const r of snRows) {
        if (!occupancy[r.machineNumber]) occupancy[r.machineNumber] = { left: null, right: null };
        if (r.handType === 'left') occupancy[r.machineNumber].left = r.snCode;
        else if (r.handType === 'right') occupancy[r.machineNumber].right = r.snCode;
      }

      // 有效状态由手套绑定推算（与桌面端 buildEffectiveStatusMap、链接页 handleGetMachineStatus 同一规则）：
      // 左右都绑 → online；仅一只 → partial；无绑定 → offline；技术支持流程态（waiting_repair/repairing）优先。
      // 之前直接返回 machines 表静态 status，未绑手套的"上线"机器会错误显示在线，与桌面端不一致。
      const result = machines.map(m => {
        const o = occupancy[m.machineNumber];
        let effectiveStatus = 'offline';
        if (o && o.left && o.right) effectiveStatus = 'online';
        else if (o && (o.left || o.right)) effectiveStatus = 'partial';
        if (m.status === 'waiting_repair' || m.status === 'repairing') effectiveStatus = m.status;
        return {
          ...m,
          status: effectiveStatus,
          leftSN: (o && o.left) || null,
          rightSN: (o && o.right) || null,
        };
      });

      // 合并边缘代理上报的主机在线状态/观测手套SN/告警
      if (typeof loadEdgePresence === 'function') {
        try {
          const presence = await loadEdgePresence();
          if (Object.keys(presence).length) {
            for (const m of result) {
              if (presence[m.machineNumber]) Object.assign(m, presence[m.machineNumber]);
            }
          }
        } catch (e) {
          console.error('[Mobile Machines] edge presence 合并失败:', e.message);
        }
      }

      sendJSON(res, { success: true, machines: result });
    } catch (e) {
      console.error('[Mobile Machines] Error:', e);
      sendJSON(res, { error: '服务器内部错误' }, 500);
    }
  }

  // ==================== PUBLIC MACHINE STATUS (link page) ====================
  // 机器状态链接页用：按 machineNumber 返回有效状态 + 手套绑定 + 活跃技术支持工单。
  // 设计参照 handleGetSNStatus (src/handlers/sn-registry.js:411)。免认证。
  async function handleGetMachineStatus(req, res, machineNumber) {
    try {
      if (!machineNumber) return sendJSON(res, { error: '机器编号不能为空' }, 400);

      // 1. 最新机器记录（查询模式同 handleMobileGetMachines / sn-registry.js:421）
      const [mRows] = await pool.execute(
        'SELECT data FROM machines WHERE machineNumber = ? ORDER BY updatedAt DESC, id DESC LIMIT 1',
        [machineNumber]
      );
      if (mRows.length === 0) return sendJSON(res, { error: '机器不存在' }, 404);
      const m = JSON.parse(mRows[0].data);

      // 2. 由手套绑定推算有效状态（只读版 _recomputeMachineStatusFromGloves, tech-support.js:93）
      const [snRows] = await pool.execute(
        "SELECT snCode, handType FROM sn_registry WHERE machineNumber = ? AND status = 'in_use'",
        [machineNumber]
      );
      const hands = new Set(snRows.map(r => r.handType));
      let effectiveStatus = 'offline';
      if (hands.has('left') && hands.has('right')) effectiveStatus = 'online';
      else if (hands.size > 0) effectiveStatus = 'partial';
      // 技术支持流程态优先（守护同 sn-registry.js:88 的 _updateMachineStatusInTxn）
      if (m.status === 'waiting_repair' || m.status === 'repairing') {
        effectiveStatus = m.status;
      }

      const leftSN = (snRows.find(r => r.handType === 'left') || {}).snCode || null;
      const rightSN = (snRows.find(r => r.handType === 'right') || {}).snCode || null;

      // 3. 活跃技术支持工单：用冗余列 machine_no 高效查询（同 tech-support.js:205 的未完成枚举）
      const unfinishedStatuses = ['open', 'assigned', 'in_progress', 'reopened'];
      const placeholders = unfinishedStatuses.map(() => '?').join(',');
      const [tsRows] = await pool.execute(
        `SELECT data FROM tech_support WHERE machine_no = ? AND status_v2 IN (${placeholders}) ORDER BY id DESC LIMIT 5`,
        [machineNumber, ...unfinishedStatuses]
      );
      let activeTicket = null;
      for (const row of tsRows) {
        try {
          const item = JSON.parse(row.data);
          // 双保险：JSON status 也校验（防 status_v2 与 JSON 不同步）
          if (item.machineNumber === machineNumber && unfinishedStatuses.includes(item.status)) {
            activeTicket = {
              id: item.id,
              status: item.status,
              faultType: item.faultType,
              faultDescription: item.faultDescription || '',
              submitterName: item.submitterName,
              submittedAt: item.submittedAt,
              responderName: item.responderName || null,
              respondedAt: item.respondedAt || null,
              priority: item.priority || 'P2',
            };
            break; // 最近一条未完成
          }
        } catch {}
      }

      const statusLabelMap = {
        online: '在线', partial: '部分绑定', offline: '离线',
        waiting_repair: '等待维修', repairing: '维修中',
      };

      sendJSON(res, {
        success: true,
        machineNumber: m.machineNumber,
        deviceType: m.deviceType || '',
        status: effectiveStatus,
        statusLabel: statusLabelMap[effectiveStatus] || effectiveStatus,
        onlineTime: m.onlineTime || null,
        offlineTime: m.offlineTime || null,
        updatedAt: m.updatedAt || null,
        leftSN,
        rightSN,
        activeTicket,
      });
    } catch (e) {
      console.error('[Machine Status] Error:', e);
      sendJSON(res, { error: '服务器内部错误' }, 500);
    }
  }

  // ==================== MACHINES CRUD ====================

  async function handleGetMachines(req, res, user) {
    const result = await _cached('machines', async () => {
      const [rows] = await pool.execute('SELECT data FROM machines ORDER BY id DESC LIMIT 5000');
      const all = rows.map(r => JSON.parse(r.data));
      // 按 updatedAt 排序，确保最新的记录在前面
      all.sort((a, b) => new Date(b.updatedAt || b.id) - new Date(a.updatedAt || a.id));
      const latest = new Map();
      for (const m of all) {
        const num = m.machineNumber;
        if (!num) continue;
        if (!latest.has(num)) latest.set(num, m);
      }
      return Array.from(latest.values());
    });
    sendJSON(res, result);
  }

  async function handleAddMachine(req, res, user, body) {
    // 普通用户可添加上下线记录（含损坏/调用标记）
    const id = body.id || (`m-${  Date.now().toString(36)  }${Math.random().toString(36).slice(2, 6)}`);

    // 机器下线/报修时，自动解绑该机器上的所有手套，并确保与机器记录写入处于同一事务
    if ((body.status === 'offline' || body.status === 'repairing') && body.machineNumber) {
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        await saveMachine(id, { ...body, id }, conn);
        await unbindGlovesFromMachine(body.machineNumber, body.status, user.username, conn);
        await conn.commit();
      } catch (e) {
        await conn.rollback();
        console.error('[Machine] 添加机器记录及解绑失败:', e.message);
        return sendJSON(res, { error: '添加机器记录失败' }, 500);
      } finally {
        try { conn.release(); } catch {}
      }
    } else {
      await saveMachine(id, { ...body, id });
    }

    _cache.delete('machines'); // 清除缓存，确保下次获取最新数据
    broadcastSSE('machines_updated', {});
    sendJSON(res, { success: true, machine: { ...body, id } });
  }

  // 解绑指定机器上所有使用中的手套（支持外部传入事务连接）
  async function unbindGlovesFromMachine(machineNumber, reason, operator, externalConn = null) {
    const conn = externalConn || await pool.getConnection();
    const isExternal = !!externalConn;
    try {
      if (!isExternal) await conn.beginTransaction();
      const [useConn] = await conn.execute(
        "SELECT snCode, handType FROM sn_registry WHERE machineNumber = ? AND status = 'in_use' FOR UPDATE",
        [machineNumber]
      );
      if (useConn.length === 0) {
        if (!isExternal) await conn.commit();
        return;
      }

      const now = new Date().toISOString();
      // 批量把全部手套状态设为可用，避免 N+1 UPDATE
      await conn.execute(
        "UPDATE sn_registry SET status='available', machineNumber=NULL, updatedAt=? WHERE machineNumber=? AND status='in_use'",
        [now, machineNumber]
      );
      // 逐条写入历史记录（需要保留每只手套的老/新状态）
      for (const glove of useConn) {
        const historyId = `h-${  Date.now().toString(36)  }${Math.random().toString(36).slice(2, 6)  }-${  glove.snCode.slice(-6)}`;
        await conn.execute(
          "INSERT INTO sn_status_history (id, snCode, oldStatus, newStatus, operator, reason, machineNumber, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          [historyId, glove.snCode, 'in_use', 'available', operator, `机器${reason === 'offline' ? '下线' : '报修'}自动解绑`, machineNumber, now]
        );
      }
      await _syncInventoryFromSN(conn);
      if (!isExternal) await conn.commit();
      broadcastChange('sn_registry', ['inventory']);
      console.log(`[Machine] 已解绑 ${machineNumber} 上的 ${useConn.length} 只手套`);
    } catch (e) {
      if (!isExternal) await conn.rollback();
      console.error('[Machine] 解绑手套失败:', e.message);
      throw e;
    } finally {
      if (!isExternal) {
        try { conn.release(); } catch {}
      }
    }
  }

  async function handleDeleteMachine(req, res, user, machineId) {
    if (user.role !== 'superadmin') return sendJSON(res, { error: '仅超级管理员可删除机器记录' }, 403);
    const machine = await readJSONById('machines', machineId);
    if (!machine) return sendJSON(res, { error: '机器不存在' }, 404);
    await deleteJSON('machines', machineId);
    const auditId = `audit-${  Date.now().toString(36)  }${Math.random().toString(36).slice(2, 6)}`;
    await saveJSON('audit_log', auditId, {
      id: auditId,
      action: 'machine_delete',
      detail: `删除机器 ${machine.machineNumber} (ID: ${machineId})，设备类型: ${machine.deviceType || '未知'}，状态: ${machine.status || '未知'}`,
      user: user.username,
      userId: user.userId,
      machineId: machineId,
      machineNumber: machine.machineNumber,
      deviceType: machine.deviceType,
      status: machine.status,
      timestamp: new Date().toISOString(),
    });
    broadcastChange('machines', ['audit_log']);
    sendJSON(res, { success: true });
  }

  // ==================== MACHINE BINDING (一机一用户) ====================

  // 运营用户绑定机器（一机一用户）
  async function handleBindMachine(req, res, user, machineNumber, body) {
    if (!machineNumber) return sendJSON(res, { error: '缺少机器编号' }, 400);

    // 检查机器是否存在（用冗余列索引替代 JSON_EXTRACT）
    const [machineRows] = await pool.execute(
      "SELECT data FROM machines WHERE machineNumber = ? ORDER BY updatedAt DESC, id DESC LIMIT 1",
      [machineNumber]
    );
    if (machineRows.length === 0) return sendJSON(res, { error: '机器不存在' }, 404);

    const machine = JSON.parse(machineRows[0].data);
    if (!machine || !machine.machineNumber) return sendJSON(res, { error: '机器数据异常' }, 500);

    // 检查该机器是否已被其他用户活跃绑定（用冗余列索引替代全表加载 + JS filter）
    const [conflictRows] = await pool.execute(
      "SELECT data FROM machine_bindings WHERE machineNumber = ? AND unboundAt IS NULL ORDER BY id DESC LIMIT 1",
      [machineNumber]
    );
    if (conflictRows.length > 0) {
      const existingBinding = JSON.parse(conflictRows[0].data);
      if (existingBinding.userId && existingBinding.userId !== user.userId) {
        return sendJSON(res, {
          error: `机器 ${machineNumber} 已被 ${existingBinding.username} 绑定，请选择其他机器`,
          boundBy: existingBinding.username
        }, 409);
      }
    }

    // 解绑当前用户之前绑定的所有活跃机器（用 userId 索引替代全表 filter）
    // 批量解绑当前用户的所有活跃绑定，避免 N+1 UPDATE
    const unbindTimestamp = new Date().toISOString();
    try {
      await pool.execute(
        "UPDATE machine_bindings SET data = JSON_SET(data, '$.unboundAt', ?, '$.unboundBy', ?), unboundAt = ? WHERE userId = ? AND unboundAt IS NULL",
        [unbindTimestamp, user.username, unbindTimestamp, user.userId]
      );
    } catch (e) {
      // 兜底：若 data 中存在非法 JSON 导致 JSON_SET 失败，退回逐条更新
      console.warn('[Machine] 批量解绑失败，退回逐条解绑:', e.message);
      const [oldBindings] = await pool.execute(
        'SELECT id, data FROM machine_bindings WHERE userId = ? AND unboundAt IS NULL',
        [user.userId]
      );
      for (const ob of oldBindings) {
        try {
          const obData = JSON.parse(ob.data);
          obData.unboundAt = unbindTimestamp;
          obData.unboundBy = user.username;
          await saveMachineBinding(ob.id, obData);
        } catch (e2) { console.warn('[Machine] 解绑单条失败:', ob.id, e2.message); }
      }
    }

    // 创建新绑定
    const bindingId = `bind-${  Date.now().toString(36)  }${Math.random().toString(36).slice(2, 6)}`;
    const bindingData = {
      id: bindingId,
      machineNumber,
      userId: user.userId,
      username: user.username,
      displayName: user.displayName || user.username,
      boundAt: new Date().toISOString(),
      deviceType: machine.deviceType || null
    };
    await saveMachineBinding(bindingId, bindingData);

    broadcastSSE('machine_bindings_updated', { machineNumber, userId: user.userId, username: user.username, displayName: user.displayName || user.username, action: 'bind' });

    console.log(`[Binding] ${user.displayName || user.username} 绑定机器 ${machineNumber}`);
    sendJSON(res, { success: true, binding: bindingData });
  }

  // 用户退出时解绑机器
  async function handleUnbindMachine(req, res, user, machineNumber) {
    if (!machineNumber) return sendJSON(res, { error: '缺少机器编号' }, 400);

    // 用冗余列复合索引精准定位当前用户的活跃绑定，替代全表加载 + JS filter
    const [rows] = await pool.execute(
      "SELECT id, data FROM machine_bindings WHERE machineNumber = ? AND userId = ? AND unboundAt IS NULL",
      [machineNumber, user.userId]
    );

    let unbound = false;
    for (const row of rows) {
      const bData = JSON.parse(row.data);
      bData.unboundAt = new Date().toISOString();
      bData.unboundBy = user.username;
      await saveMachineBinding(row.id, bData);
      unbound = true;
      console.log(`[Binding] ${user.username} 解绑机器 ${machineNumber}`);
    }

    if (!unbound) {
      return sendJSON(res, { success: true, message: '无需解绑' });
    }

    // Auto-unbind gloves from this machine when user unbundles
    try {
      await unbindGlovesFromMachine(machineNumber, 'user_unbind', user.username);
    } catch (e) {
      console.error('[UnbindMachine] Glove unbind failed:', e.message);
    }

    broadcastSSE('machine_bindings_updated', { machineNumber, userId: user.userId, username: user.username, action: 'unbind' });
    sendJSON(res, { success: true });
  }

  // 获取当前机器绑定状态
  async function handleGetMachineBindings(req, res, user) {
    // 用冗余列索引直接查活跃绑定（unboundAt IS NULL），替代全表加载 + JS filter
    const [bindings] = await pool.execute(
      "SELECT data FROM machine_bindings WHERE unboundAt IS NULL ORDER BY id DESC"
    );
    const result = bindings.map(b => JSON.parse(b.data));
    sendJSON(res, result);
  }

  // ==================== SYNC MACHINE STATE (事务化上下线) ====================
  // Phase 1.1: 单事务内 锁行+批量UPDATE sn_registry+_syncInventoryFromSN+
  // 写交易+插机器记录。全成全败。
  async function handleSyncMachineState(req, res, authUser, machineNumber, body) {
    if (!machineNumber) return sendJSON(res, { error: '缺少机器编号' }, 400);
    const { status, deviceType, reason, offlineType, snOperations } = body;
    if (status !== 'online' && status !== 'offline') return sendJSON(res, { error: 'status 必须为 online 或 offline' }, 400);
    const ops = Array.isArray(snOperations) ? snOperations.filter(o => o && o.snCode) : [];
    const now = new Date().toISOString();
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      // 1. 锁定 + 读取该机器当前所有 in_use 的 SN（服务端权威，不信任前端本地缓存）
      const [currentInUse] = await conn.execute(
        "SELECT snCode, equipmentType, handType FROM sn_registry WHERE machineNumber = ? AND status = 'in_use' FOR UPDATE",
        [machineNumber]
      );
      const inUseBySn = Object.create(null);
      for (const r of currentInUse) inUseBySn[r.snCode] = r;

      // 2. 锁定所有目标 SN（上线时要绑定的 SN）
      if (ops.length > 0) {
        const sns = ops.map(o => o.snCode);
        const ph = sns.map(() => '?').join(',');
        await conn.execute(
          `SELECT snCode FROM sn_registry WHERE snCode IN (${ph}) FOR UPDATE`,
          sns
        );
      }

      // 3. 构建完整操作列表（上线先释放旧 in_use，再绑新；下线按 per-SN 或全局 offlineType）
      const allOps = [];
      const opBySn = Object.create(null);
      for (const o of ops) opBySn[o.snCode] = o;

      if (status === 'online') {
        // 上线：先把该机器所有旧 in_use 释放为 available（防重复绑定）
        for (const r of currentInUse) {
          if (!opBySn[r.snCode]) {
            allOps.push({ snCode: r.snCode, equipmentType: r.equipmentType, handType: r.handType,
              fromStatus: 'in_use', targetStatus: 'available', machineNumber: '', reason: '' });
          }
        }
        // 再绑新 SN → in_use
        for (const o of ops) {
          allOps.push({ snCode: o.snCode, equipmentType: o.equipmentType, handType: o.handType,
            fromStatus: inUseBySn[o.snCode] ? 'in_use' : 'available', targetStatus: 'in_use',
            machineNumber, reason: '' });
        }
      } else {
        // 下线：有 per-SN 操作就按操作；无则对全部 in_use 应用 offlineType
        if (ops.length === 0) {
          for (const r of currentInUse) {
            let ts = 'available', rsn = reason || '';
            if (offlineType === 'damaged') { ts = 'damaged'; rsn = reason || '损坏'; }
            else if (offlineType === 'transfer') { ts = 'transferred'; rsn = reason || '未指定地点'; }
            allOps.push({ snCode: r.snCode, equipmentType: r.equipmentType, handType: r.handType,
              fromStatus: 'in_use', targetStatus: ts, machineNumber: '', reason: rsn });
          }
        } else {
          for (const o of ops) {
            allOps.push({ snCode: o.snCode, equipmentType: o.equipmentType, handType: o.handType,
              fromStatus: inUseBySn[o.snCode] ? 'in_use' : 'available',
              targetStatus: o.targetStatus || 'available', machineNumber: '', reason: o.reason || '' });
          }
        }
      }

      // 4. 上线校验：目标 SN 必须存在且可绑定（未被其他机器占用）
      if (status === 'online' && ops.length > 0) {
        const sns = ops.map(o => o.snCode);
        const ph = sns.map(() => '?').join(',');
        const [snRows] = await conn.execute(
          `SELECT snCode, status, machineNumber FROM sn_registry WHERE snCode IN (${ph})`,
          sns
        );
        const snMap = Object.create(null);
        for (const r of snRows) snMap[r.snCode] = r;
        for (const o of ops) {
          if (!snMap[o.snCode]) throw new Error(`SN码 ${o.snCode} 不存在，无法上线`);
          const sn = snMap[o.snCode];
          if (sn.status === 'in_use' && sn.machineNumber && sn.machineNumber !== machineNumber) {
            throw new Error(`SN码 ${o.snCode} 已绑定到机器 ${sn.machineNumber}`);
          }
          // 校验 available 充足：上线需该 SN 处于 available（库存语义：available 才能投入使用）
          if (sn.status === 'transferred' || sn.status === 'damaged') {
            throw new Error(`SN码 ${o.snCode} 当前状态为 ${sn.status}，无法投入使用`);
          }
        }
      }

      // 5. 应用所有 SN 更新 + 写状态变更历史
      for (const op of allOps) {
        const damageReason = op.targetStatus === 'damaged' ? (op.reason || '') : '';
        const trackingNumber = op.targetStatus === 'transferred' ? (op.reason || '') : '';
        await conn.execute(
          "UPDATE sn_registry SET status=?, machineNumber=?, damageReason=?, trackingNumber=?, updatedAt=? WHERE snCode=?",
          [op.targetStatus, op.machineNumber || '', damageReason, trackingNumber, now, op.snCode]
        );
        const hid = `h-${  Date.now().toString(36)  }${Math.random().toString(36).slice(2, 6)  }-${  op.snCode.slice(-6)}`;
        await conn.execute(
          "INSERT INTO sn_status_history (id, snCode, oldStatus, newStatus, operator, reason, machineNumber, createdAt) VALUES (?,?,?,?,?,?,?,?)",
          [hid, op.snCode, op.fromStatus || 'available', op.targetStatus, authUser.username,
           status === 'online' ? `机器${machineNumber}上线` : `机器${machineNumber}下线`, machineNumber, now]
        );
      }

      // 6. 从 sn_registry 重算库存（原子、权威；available→in_use 不改变 quantity 总量）
      await _syncInventoryFromSN(conn);

      // 7. 写交易记录（审计流水）
      for (const op of allOps) {
        const invType = _snToInvType(op.equipmentType, op.handType) || op.equipmentType;
        let txType, direction, note;
        if (op.targetStatus === 'in_use') {
          txType = 'machine_online'; direction = 'out'; note = `机器${machineNumber}上线自动扣减`;
        } else if (op.targetStatus === 'available') {
          txType = 'machine_offline'; direction = 'in'; note = `机器${machineNumber}下线自动归还`;
        } else if (op.targetStatus === 'damaged') {
          txType = 'damaged'; direction = 'out'; note = `机器${machineNumber}下线损坏: ${op.reason || '损坏'}`;
        } else if (op.targetStatus === 'transferred') {
          txType = 'transfer'; direction = 'out'; note = `机器${machineNumber}下线调出: ${op.reason || ''}`;
        } else continue;
        await _insertTransaction(conn, {
          type: txType, refId: machineNumber, equipmentType: op.equipmentType, handType: op.handType,
          invType, direction, quantity: 1, snCode: op.snCode, machineNumber,
          operator: authUser.username, note, timestamp: now
        });
      }

      // 8. 插入机器记录（下线时从最近 online 记录继承 onlineTime）
      let recordOnlineTime = status === 'online' ? now : null;
      const recordOfflineTime = status === 'offline' ? now : null;
      if (status === 'offline') {
        const [onlineRecs] = await conn.execute(
          "SELECT data FROM machines WHERE machineNumber = ? ORDER BY updatedAt DESC LIMIT 5",
          [machineNumber]
        );
        for (const r of onlineRecs) {
          try {
            const d = typeof r.data === 'string' ? JSON.parse(r.data) : r.data;
            if (d && d.status === 'online' && d.onlineTime) { recordOnlineTime = d.onlineTime; break; }
          } catch {}
        }
      }
      const offlineReason = status === 'offline'
        ? (reason || (offlineType === 'damaged' ? '损坏' : offlineType === 'transfer' ? '调出' : ''))
        : '';
      const machineId = `m-${  Date.now().toString(36)  }${Math.random().toString(36).slice(2, 6)}`;
      await saveMachine(machineId, {
        id: machineId, machineNumber, deviceType, status,
        onlineTime: recordOnlineTime, offlineTime: recordOfflineTime,
        onlineReason: status === 'online' ? (reason || '') : '',
        offlineReason, updatedBy: authUser.username, updatedAt: now,
      }, conn);

      await conn.commit();
      broadcastChange('machines', ['sn_registry', 'inventory', 'transactions']);
      sendJSON(res, { success: true, machineNumber, status, machineId, opsApplied: allOps.length });
    } catch (e) {
      await conn.rollback();
      console.error('[SyncMachineState] failed:', e.message);
      sendJSON(res, { error: e.message }, 500);
    } finally {
      try { conn.release(); } catch {}
    }
  }

  return {
    handleGetMachineCode,
    handleMobileGetMachines,
    handleGetMachineStatus,
    handleGetMachines,
    handleAddMachine,
    handleDeleteMachine,
    handleBindMachine,
    handleUnbindMachine,
    handleGetMachineBindings,
    handleSyncMachineState,
  };
};
