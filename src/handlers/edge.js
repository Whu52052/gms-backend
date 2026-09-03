/**
 * src/handlers/edge.js
 * Edge-agent domain HTTP handlers.
 *
 * 部署在每台机器（工控机）上的 machine-heartbeat-agent 容器通过本域上报：
 *   - 主机心跳（30s）：在线状态、IP、agent 版本、主机资源
 *   - 观测到的设备事实：手套 TCP 连通性（192.168.1.100/101:50001）、
 *     自动识别的手套 SN（WUJI 标定目录 / importer-staging machine.jsonc）、
 *     Quest 头显（ADB）等
 *
 * 设计原则：agent 只上报"观测到的事实"，绑定/解绑等业务决策一律在服务端；
 * 服务端将观测 SN 与 sn_registry 比对，产生告警（未登记/状态不可用/绑在别的
 * 机器/左右手接反/系统记录绑定但设备未连接），不自动改写业务数据。
 *
 * Handlers (URL → handler):
 *   POST /api/edge/heartbeat  → handleHeartbeat  (Bearer EDGE_TOKEN, CSRF 豁免)
 *   POST /api/edge/offline    → handleOffline    (Bearer EDGE_TOKEN, CSRF 豁免)
 *   GET  /api/edge/hosts      → handleListHosts  (登录用户)
 *
 * Deps: pool, redisClient(可选), sendJSON, broadcastSSE.
 */
'use strict';

const crypto = require('crypto');

const PRESENCE_FRESH_MS = 120 * 1000; // 心跳周期 30s，容忍 4 次丢失
const SWEEP_INTERVAL_MS = 30 * 1000;

// 告警 → 自动工单策略。默认只对"确定性故障/违规"建单；
// bound_but_disconnected（下班关机误报多）、glove_no_sn（可能仅缺标定文件）
// 默认只告警不建单，需在 .env 设置 EDGE_AUTO_TICKET_EXTRA 显式开启。
const TICKET_RULES = {
  hand_mismatch:        { faultType: '手套接线错误（左右手接反）', priority: 'P2' },
  sn_unusable:          { faultType: '设备状态异常（不可投入使用）', priority: 'P1' },
  sn_bound_elsewhere:   { faultType: '设备串用（SN 绑定在其他机器）', priority: 'P2' },
  unregistered_sn:      { faultType: '设备未登记入库', priority: 'P3' },
  bound_but_disconnected: { faultType: '绑定设备未连接', priority: 'P3' },
  glove_no_sn:          { faultType: '手套 SN 无法识别', priority: 'P3' },
};
const DEFAULT_TICKET_CODES = ['hand_mismatch', 'sn_unusable', 'sn_bound_elsewhere', 'unregistered_sn'];
const TICKET_RETRY_MS = 10 * 60 * 1000; // already_open 跳过后 10 分钟再试（人工单完成后可补建）

module.exports = function createEdgeHandlers(deps) {
  const { pool, redisClient, sendJSON, broadcastSSE } = deps;

  // 由 server.js 在 tech-support 工厂创建后注入（edge 先于 techSupport 创建）
  let _createSystemTicket = null;
  function setTicketCreator(fn) {
    _createSystemTicket = typeof fn === 'function' ? fn : null;
  }

  function _ticketEnabledCodes() {
    const codes = new Set(DEFAULT_TICKET_CODES);
    for (const c of String(process.env.EDGE_AUTO_TICKET_EXTRA || '').split(',')) {
      const code = c.trim();
      if (code) codes.add(code);
    }
    return codes;
  }

  // ==================== 认证 ====================

  function authenticate(req, res) {
    if (!process.env.EDGE_TOKEN) {
      sendJSON(res, { error: '服务端未配置 EDGE_TOKEN，拒绝边缘接入' }, 503);
      return false;
    }
    const auth = String(req.headers['authorization'] || '');
    const provided = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    const expected = process.env.EDGE_TOKEN;
    const a = Buffer.from(provided);
    const b = Buffer.from(expected);
    if (!provided || a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      sendJSON(res, { error: '边缘节点认证失败' }, 401);
      return false;
    }
    return true;
  }

  // ==================== Redis presence（快速通道，可选） ====================

  async function _setRedisPresence(machineNumber, payload) {
    if (!redisClient || typeof redisClient.set !== 'function') return;
    try {
      await redisClient.set(`edge:presence:${machineNumber}`, JSON.stringify(payload), 'EX', 120);
    } catch { /* redis 不可用时以 edge_hosts 表为准 */ }
  }

  async function _clearRedisPresence(machineNumber) {
    if (!redisClient || typeof redisClient.del !== 'function') return;
    try { await redisClient.del(`edge:presence:${machineNumber}`); } catch {}
  }

  // ==================== 观测事实 vs 注册表 比对 ====================

  async function reconcile(machineNumber, devices) {
    const alerts = [];
    const gloves = (devices && devices.gloves) || {};
    const observed = {
      left: {
        connected: !!(gloves.left && gloves.left.connected),
        snCode: (gloves.left && gloves.left.snCode) || null,
        ip: (gloves.left && gloves.left.ip) || '192.168.1.100',
      },
      right: {
        connected: !!(gloves.right && gloves.right.connected),
        snCode: (gloves.right && gloves.right.snCode) || null,
        ip: (gloves.right && gloves.right.ip) || '192.168.1.101',
      },
    };

    // 系统记录：该机器当前 in_use 的手套
    const [dbRows] = await pool.execute(
      "SELECT snCode, handType FROM sn_registry WHERE machineNumber = ? AND status = 'in_use'",
      [machineNumber]
    );
    const dbByHand = { left: null, right: null };
    for (const r of dbRows) {
      if (r.handType === 'left' || r.handType === 'right') dbByHand[r.handType] = r.snCode;
    }

    // 观测到的 SN 在注册表中的状态
    const observedSNs = [observed.left.snCode, observed.right.snCode].filter(Boolean);
    const snMap = Object.create(null);
    if (observedSNs.length) {
      const placeholders = observedSNs.map(() => '?').join(',');
      const [rows] = await pool.execute(
        `SELECT snCode, handType, status, machineNumber FROM sn_registry WHERE snCode IN (${placeholders})`,
        observedSNs
      );
      for (const r of rows) snMap[r.snCode] = r;
    }

    const UNUSABLE = new Set(['damaged', 'transferred', 'shipped', 'repairing', 'waiting_repair', 'scrapped']);

    for (const hand of ['left', 'right']) {
      const obs = observed[hand];
      const handLabel = hand === 'left' ? '左手' : '右手';

      if (obs.connected) {
        if (!obs.snCode) {
          alerts.push({ level: 'info', code: 'glove_no_sn', hand, snCode: null, message: `${handLabel}套已连接但未能识别 SN 码` });
        } else {
          const rec = snMap[obs.snCode];
          if (!rec) {
            alerts.push({ level: 'error', code: 'unregistered_sn', hand, snCode: obs.snCode, message: `${handLabel}套 SN ${obs.snCode} 未在 SN 注册表登记` });
          } else {
            if (rec.handType && rec.handType !== hand) {
              alerts.push({ level: 'error', code: 'hand_mismatch', hand, snCode: obs.snCode, message: `${handLabel}网口检测到 SN ${obs.snCode}，注册表记录为${rec.handType === 'left' ? '左' : '右'}手手套，疑似接反` });
            }
            if (UNUSABLE.has(rec.status)) {
              alerts.push({ level: 'error', code: 'sn_unusable', hand, snCode: obs.snCode, message: `${handLabel}套 SN ${obs.snCode} 当前状态为 ${rec.status}，不可投入使用` });
            } else if (rec.status === 'in_use' && rec.machineNumber && rec.machineNumber !== machineNumber) {
              alerts.push({ level: 'error', code: 'sn_bound_elsewhere', hand, snCode: obs.snCode, message: `${handLabel}套 SN ${obs.snCode} 已绑定在机器 ${rec.machineNumber}` });
            }
          }
        }
      }

      // 系统记录绑定中，但边缘代理观测不到设备（拔线/断电/断网）
      if (dbByHand[hand] && !obs.connected) {
        alerts.push({ level: 'warn', code: 'bound_but_disconnected', hand, snCode: dbByHand[hand], message: `系统记录 ${handLabel}套 ${dbByHand[hand]} 绑定中，但未检测到设备连接` });
      }
    }

    return { observed, alerts };
  }

  // ==================== 告警 → 自动技术支持工单 ====================
  // 防刷屏/防抖：
  //   - 同一告警（code:hand:snCode）已建单 → 不重复建；
  //   - 机器已有未完成工单（人工或自动）→ 跳过，10 分钟后才重试；
  //   - 告警恢复（本次心跳不再出现）→ 清除标记（复发可再建）；
  //   - 不自动关单：维修完成必须人工确认。
  async function _autoTicket(machineNumber, alerts, prevData) {
    const ticketed = (prevData && prevData.ticketedAlerts) || {};
    if (String(process.env.EDGE_AUTO_TICKET || 'on').toLowerCase() === 'off') {
      return ticketed;
    }
    if (typeof _createSystemTicket !== 'function') return ticketed;

    const enabled = _ticketEnabledCodes();
    const now = Date.now();
    const activeKeys = new Set();

    for (const a of alerts) {
      if (!a || !a.code || !enabled.has(a.code)) continue;
      const rule = TICKET_RULES[a.code];
      if (!rule) continue;
      const key = `${a.code}:${a.hand || ''}:${a.snCode || ''}`;
      activeKeys.add(key);

      const prev = ticketed[key];
      if (prev && prev.ticketId) continue; // 已建单，等人工处理
      if (prev && prev.skippedAt && now - new Date(prev.skippedAt).getTime() < TICKET_RETRY_MS) continue;

      try {
        const r = await _createSystemTicket({
          machineNumber,
          equipmentType: 'glove',
          equipmentTypeName: '手套',
          faultType: rule.faultType,
          faultDescription: a.message,
          priority: rule.priority,
          alertCode: a.code,
        });
        const ts = new Date().toISOString();
        if (r && r.ok) {
          ticketed[key] = { ticketId: r.item.id, at: ts };
        } else {
          // already_open / missing_fields：记录跳过时间，避免每 30s 重试刷屏
          ticketed[key] = { skipped: true, reason: (r && r.reason) || 'unknown', existingId: (r && r.existingId) || null, skippedAt: ts };
        }
      } catch (e) {
        console.error(`[EDGE] 自动建单失败 ${machineNumber} ${a.code}:`, e.message);
      }
    }

    // 告警恢复：清除已消失告警的建单标记
    for (const key of Object.keys(ticketed)) {
      if (!activeKeys.has(key)) {
        console.log(`[EDGE] ${machineNumber} 告警恢复: ${key}（对应工单需人工确认完成）`);
        delete ticketed[key];
      }
    }
    return ticketed;
  }

  // ==================== Handlers ====================

  async function handleHeartbeat(req, res, authUser, captures, body) {
    if (!authenticate(req, res)) return;
    const b = body || {};
    // 系统机器编号约定为小写（hostname we-xxx，machines 表存 we-xxx），
    // 统一 toLowerCase 保证 presence map 与 /api/machines 的 machineNumber 键匹配
    const machineNumber = String(b.machineNumber || '').trim().toLowerCase();
    if (!machineNumber) return sendJSON(res, { error: 'machineNumber 为必填' }, 400);

    let observed = {
      left: { connected: false, snCode: null, ip: '192.168.1.100' },
      right: { connected: false, snCode: null, ip: '192.168.1.101' },
    };
    let alerts = [];
    try {
      const r = await reconcile(machineNumber, b.devices || {});
      observed = r.observed;
      alerts = r.alerts;
    } catch (e) {
      console.error('[EDGE] reconcile 失败:', e.message);
      alerts.push({ level: 'warn', code: 'reconcile_failed', message: '服务端比对异常，请人工核查' });
    }

    const now = new Date().toISOString();

    // 上一次心跳记录（变更广播 + 自动工单防抖状态都依赖它）
    let prev = null;
    try {
      const [rows] = await pool.execute('SELECT status, data FROM edge_hosts WHERE machineNumber = ?', [machineNumber]);
      prev = rows[0] || null;
    } catch { /* 表可能尚未建 */ }
    let prevData = {};
    try { prevData = JSON.parse((prev && prev.data) || '{}'); } catch {}

    // 故障类告警 → 自动创建技术支持工单（内部调用，失败不影响心跳）
    let ticketedAlerts = {};
    try {
      ticketedAlerts = await _autoTicket(machineNumber, alerts, prevData);
    } catch (e) {
      console.error('[EDGE] 自动工单流程异常:', e.message);
    }

    const data = {
      observed,
      alerts,
      ticketedAlerts,
      devices: b.devices || {},
      quest: b.quest || null,
      machineType: b.machineType || null,
      host: b.host || {},
    };

    try {
      await pool.execute(
        `INSERT INTO edge_hosts (machineNumber, hostname, ipAddress, agentVersion, status, lastSeen, data, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, 'online', ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE hostname = VALUES(hostname), ipAddress = VALUES(ipAddress),
           agentVersion = VALUES(agentVersion), status = 'online', lastSeen = VALUES(lastSeen),
           data = VALUES(data), updatedAt = VALUES(updatedAt)`,
        [
          machineNumber,
          String(b.hostname || ''),
          String(b.ipAddress || ''),
          String(b.agentVersion || ''),
          now,
          JSON.stringify(data),
          now, now,
        ]
      );
    } catch (e) {
      console.error('[EDGE] 心跳落库失败:', e.message);
      return sendJSON(res, { error: '心跳落库失败' }, 500);
    }

    await _setRedisPresence(machineNumber, { machineNumber, ts: now, observed, alerts });

    let prevAlertCodes = [];
    try { prevAlertCodes = (JSON.parse((prev && prev.data) || '{}').alerts || []).map(a => a.code); } catch {}
    const becameOnline = !prev || prev.status !== 'online';
    const alertsChanged = JSON.stringify(prevAlertCodes.sort()) !== JSON.stringify(alerts.map(a => a.code).sort());
    if (becameOnline || alertsChanged) {
      try { broadcastSSE('machine_presence_updated', { machineNumber }); } catch {}
    }

    sendJSON(res, { success: true, machineNumber, serverTime: now, observed, alerts });
  }

  async function handleOffline(req, res, authUser, captures, body) {
    if (!authenticate(req, res)) return;
    const b = body || {};
    const machineNumber = String(b.machineNumber || '').trim().toLowerCase();
    if (!machineNumber) return sendJSON(res, { error: 'machineNumber 为必填' }, 400);

    const now = new Date().toISOString();
    try {
      await pool.execute(
        "UPDATE edge_hosts SET status = 'offline', updatedAt = ? WHERE machineNumber = ?",
        [now, machineNumber]
      );
    } catch (e) {
      console.error('[EDGE] 下线落库失败:', e.message);
      return sendJSON(res, { error: '下线落库失败' }, 500);
    }
    await _clearRedisPresence(machineNumber);
    try { broadcastSSE('machine_presence_updated', { machineNumber, offline: true }); } catch {}
    console.log(`[EDGE] 主机 ${machineNumber} 主动下线`);
    sendJSON(res, { success: true });
  }

  async function handleListHosts(req, res) {
    const [rows] = await pool.execute(
      'SELECT machineNumber, hostname, ipAddress, agentVersion, status, lastSeen, data, createdAt, updatedAt FROM edge_hosts ORDER BY updatedAt DESC'
    );
    const now = Date.now();
    const hosts = rows.map(r => {
      let d = {};
      try { d = JSON.parse(r.data || '{}'); } catch {}
      const online = r.status === 'online' && r.lastSeen &&
        (now - new Date(r.lastSeen).getTime() < PRESENCE_FRESH_MS);
      return {
        machineNumber: r.machineNumber,
        hostname: r.hostname || '',
        ipAddress: r.ipAddress || '',
        agentVersion: r.agentVersion || '',
        online,
        lastSeen: r.lastSeen || null,
        observedGloves: d.observed || null,
        alerts: Array.isArray(d.alerts) ? d.alerts : [],
        quest: d.quest || null,
        machineType: d.machineType || null,
        host: d.host || {},
        updatedAt: r.updatedAt || null,
      };
    });
    sendJSON(res, hosts);
  }

  // ==================== 供 machines handler 合并 presence 字段 ====================

  async function loadEdgePresence() {
    const map = Object.create(null);
    try {
      const [rows] = await pool.execute(
        'SELECT machineNumber, hostname, ipAddress, agentVersion, status, lastSeen, data FROM edge_hosts'
      );
      const now = Date.now();
      for (const r of rows) {
        let d = {};
        try { d = JSON.parse(r.data || '{}'); } catch {}
        const online = r.status === 'online' && r.lastSeen &&
          (now - new Date(r.lastSeen).getTime() < PRESENCE_FRESH_MS);
        map[r.machineNumber] = {
          hostOnline: online,
          hostLastSeen: r.lastSeen || null,
          hostIp: r.ipAddress || '',
          hostName: r.hostname || '',
          agentVersion: r.agentVersion || '',
          observedGloves: d.observed || null,
          edgeAlerts: Array.isArray(d.alerts) ? d.alerts : [],
          edgeQuest: d.quest || null,
        };
      }
    } catch { /* edge_hosts 未建表 / 查询失败时静默降级，不影响机器列表 */ }
    return map;
  }

  // ==================== 超时扫描 ====================

  function startSweeper() {
    const timer = setInterval(async () => {
      try {
        const cutoff = new Date(Date.now() - PRESENCE_FRESH_MS).toISOString();
        const [rows] = await pool.execute(
          "SELECT machineNumber FROM edge_hosts WHERE status = 'online' AND (lastSeen IS NULL OR lastSeen < ?)",
          [cutoff]
        );
        if (!rows.length) return;
        const now = new Date().toISOString();
        for (const r of rows) {
          await pool.execute(
            "UPDATE edge_hosts SET status = 'offline', updatedAt = ? WHERE machineNumber = ? AND status = 'online'",
            [now, r.machineNumber]
          );
          try { broadcastSSE('machine_presence_updated', { machineNumber: r.machineNumber, offline: true }); } catch {}
        }
        console.log(`[EDGE] 心跳超时，${rows.length} 台主机标记离线: ${rows.map(r => r.machineNumber).join(', ')}`);
      } catch (e) {
        console.error('[EDGE] sweeper 异常:', e.message);
      }
    }, SWEEP_INTERVAL_MS);
    if (typeof timer.unref === 'function') timer.unref();
  }

  return {
    handleHeartbeat,
    handleOffline,
    handleListHosts,
    loadEdgePresence,
    startSweeper,
    setTicketCreator,
  };
};
