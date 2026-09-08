'use strict';

const crypto = require('crypto');

const PRESENCE_FRESH_MS = 120 * 1000;
const SWEEP_INTERVAL_MS = 30 * 1000;

const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key);

const TICKET_RULES = {
  hand_mismatch:        { faultType: '手套接线错误（左右手接反）', priority: 'P2' },
  sn_unusable:          { faultType: '设备状态异常（不可投入使用）', priority: 'P1' },
  sn_bound_elsewhere:   { faultType: '设备串用（SN 绑定在其他机器）', priority: 'P2' },
  unregistered_sn:      { faultType: '设备未登记入库', priority: 'P3' },
  bound_but_disconnected: { faultType: '绑定设备未连接', priority: 'P3' },
  glove_no_sn:          { faultType: '手套 SN 无法识别', priority: 'P3' },
  importer_unreachable: { faultType: 'Importer 采集服务不可达', priority: 'P2' },
  hermes_unreachable:   { faultType: 'Hermes 采集程序不可达', priority: 'P1' },
  collector_degraded:   { faultType: '采集组件降级', priority: 'P1' },
  emergency_stopped:    { faultType: '采集机处于急停状态', priority: 'P1' },
  recorder_not_ready:   { faultType: '录制器未就绪', priority: 'P2' },
  hermes_errors:        { faultType: 'Hermes 采集程序报错', priority: 'P1' },
};

const DEFAULT_TICKET_CODES = ['hand_mismatch', 'sn_unusable', 'sn_bound_elsewhere', 'unregistered_sn', 'collector_degraded'];
const TICKET_RETRY_MS = 10 * 60 * 1000;

module.exports = function createEdgeHandlers(deps) {
  const { pool, redisClient, sendJSON, broadcastSSE } = deps;

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

  async function _setRedisPresence(machineNumber, payload) {
    if (!redisClient || typeof redisClient.set !== 'function') return;
    try {
      await redisClient.set(`edge:presence:${machineNumber}`, JSON.stringify(payload), 'EX', 120);
    } catch {                                  }
  }

  async function _clearRedisPresence(machineNumber) {
    if (!redisClient || typeof redisClient.del !== 'function') return;
    try { await redisClient.del(`edge:presence:${machineNumber}`); } catch {}
  }

  async function reconcile(machineNumber, devices, collector) {
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

    const [dbRows] = await pool.execute(
      "SELECT snCode, handType FROM sn_registry WHERE machineNumber = ? AND status = 'in_use'",
      [machineNumber]
    );
    const dbByHand = { left: null, right: null };
    for (const r of dbRows) {
      if (r.handType === 'left' || r.handType === 'right') dbByHand[r.handType] = r.snCode;
    }

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

      if (dbByHand[hand] && !obs.connected) {
        alerts.push({ level: 'warn', code: 'bound_but_disconnected', hand, snCode: dbByHand[hand], message: `系统记录 ${handLabel}套 ${dbByHand[hand]} 绑定中，但未检测到设备连接` });
      }
    }

    if (collector && hasOwn(collector, 'importer') && collector.importer) {
      const importer = collector.importer;
      if (importer.reachable === false || (importer.endpointStatus && importer.endpointStatus.machine === false)) {
        alerts.push({ level: 'warn', code: 'importer_unreachable', message: `Importer API 不可达${importer.error ? `：${importer.error}` : ''}` });
      }
    }
    if (collector && hasOwn(collector, 'hermes') && collector.hermes) {
      const hermes = collector.hermes;
      if (hermes.reachable === false) {
        alerts.push({ level: 'error', code: 'hermes_unreachable', message: `Hermes API 不可达${hermes.error ? `：${hermes.error}` : ''}` });
      }
      const health = hermes.health || {};
      const degraded = Array.isArray(health.degraded) ? health.degraded : [];
      const healthFresh = !hermes.endpointStatus || hermes.endpointStatus.health !== false;
      if (hermes.reachable !== false && healthFresh && (degraded.length || health.allConnected === false)) {
        alerts.push({ level: 'error', code: 'collector_degraded', components: degraded, message: `采集组件处于降级状态${degraded.length ? `：${degraded.join('、')}` : ''}` });
      }
      const state = hermes.state || {};
      const stateFresh = !hermes.endpointStatus || hermes.endpointStatus.state !== false;
      if (hermes.reachable !== false && stateFresh && state.emergencyStopped === true) {
        alerts.push({ level: 'error', code: 'emergency_stopped', message: '采集机处于急停状态，请现场确认' });
      }
      if (hermes.reachable !== false && stateFresh && state.healthSummary && state.healthSummary.recorder && state.healthSummary.recorder !== 'ready') {
        alerts.push({ level: 'warn', code: 'recorder_not_ready', message: `录制器状态为 ${state.healthSummary.recorder}` });
      }
      if (hermes.reachable !== false && stateFresh && ((Number(state.errorCount) || 0) > 0 || (Array.isArray(state.errors) && state.errors.length > 0))) {
        alerts.push({ level: 'error', code: 'hermes_errors', message: `Hermes 当前有 ${Number(state.errorCount) || state.errors.length} 个错误` });
      }
    }

    return { observed, alerts };
  }

  async function _autoTicket(machineNumber, alerts, prevData, heartbeatPayload) {
    const ticketed = (prevData && prevData.ticketedAlerts) || {};
    if (String(process.env.EDGE_AUTO_TICKET || 'on').toLowerCase() === 'off') {
      return ticketed;
    }
    if (typeof _createSystemTicket !== 'function') return ticketed;

    const enabled = _ticketEnabledCodes();
    const now = Date.now();
    const activeKeys = new Set();

    const environmentInfo = heartbeatPayload ? {
      hostname: heartbeatPayload.hostname || null,
      ipAddress: heartbeatPayload.ipAddress || null,
      agentVersion: heartbeatPayload.agentVersion || null,
      lastHeartbeat: new Date().toISOString(),
      cpuCount: (heartbeatPayload.host && heartbeatPayload.host.cpus) || null,
      totalMemory: (heartbeatPayload.host && heartbeatPayload.host.totalMemory) || null,
      freeMemory: (heartbeatPayload.host && heartbeatPayload.host.freeMemory) || null,
      platform: (heartbeatPayload.host && heartbeatPayload.host.platform) || null,
    } : null;

    const devices = (heartbeatPayload && heartbeatPayload.devices) || {};
    const deviceSnapshot = {
      leftGlove: !!(devices.gloves && devices.gloves.left && devices.gloves.left.connected),
      leftGloveSN: (devices.gloves && devices.gloves.left && devices.gloves.left.snCode) || null,
      rightGlove: !!(devices.gloves && devices.gloves.right && devices.gloves.right.connected),
      rightGloveSN: (devices.gloves && devices.gloves.right && devices.gloves.right.snCode) || null,
      leftDexterous: !!(devices.dexterousHands && devices.dexterousHands.left && devices.dexterousHands.left.connected),
      rightDexterous: !!(devices.dexterousHands && devices.dexterousHands.right && devices.dexterousHands.right.connected),
      roboticArm: !!(devices.roboticArm && devices.roboticArm.connected),
      quest: !!(heartbeatPayload.quest && heartbeatPayload.quest.connected),
      questBattery: (heartbeatPayload.quest && heartbeatPayload.quest.battery) || null,
    };

    for (const a of alerts) {
      if (!a || !a.code || !enabled.has(a.code)) continue;
      const rule = TICKET_RULES[a.code];
      if (!rule) continue;
      const key = `${a.code}:${a.hand || ''}:${a.snCode || ''}`;
      activeKeys.add(key);

      const prev = ticketed[key];
      if (prev && prev.ticketId) continue;
      if (prev && prev.skippedAt && now - new Date(prev.skippedAt).getTime() < TICKET_RETRY_MS) continue;

      const diagnostics = {};
      const collectorAlert = new Set([
        'importer_unreachable', 'hermes_unreachable', 'collector_degraded',
        'emergency_stopped', 'recorder_not_ready', 'hermes_errors',
      ]).has(a.code);
      if (a.snCode) diagnostics.observedSN = a.snCode;
      if (a.hand) diagnostics.actualHand = a.hand;
      if (collectorAlert) {
        const importer = heartbeatPayload && heartbeatPayload.importer;
        const hermes = heartbeatPayload && heartbeatPayload.hermes;
        diagnostics.collector = {
          importer: importer ? {
            reachable: importer.reachable,
            endpointStatus: importer.endpointStatus || null,
            error: importer.error || null,
          } : null,
          hermes: hermes ? {
            reachable: hermes.reachable,
            version: hermes.version || null,
            endpointStatus: hermes.endpointStatus || null,
            health: hermes.health ? {
              allConnected: hermes.health.allConnected,
              degraded: hermes.health.degraded || [],
              errors: hermes.health.errors || [],
            } : null,
            state: hermes.state ? {
              controlState: hermes.state.controlState,
              isRecording: hermes.state.isRecording,
              emergencyStopped: hermes.state.emergencyStopped,
              errorCount: hermes.state.errorCount,
              errors: hermes.state.errors || [],
            } : null,
          } : null,
        };
      }

      if (a.code === 'hand_mismatch') {

        diagnostics.expectedHand = a.hand === 'left' ? 'right' : 'left';
        diagnostics.possibleCause = '手套网线接错端口，或标定文件中左右手标记错误';
        diagnostics.suggestedAction = '检查192.168.1.100(左手)和192.168.1.101(右手)的网线连接是否正确';
      } else if (a.code === 'sn_unusable') {

        diagnostics.deviceStatus = '不可用（damaged/transferred/shipped/repairing等）';
        diagnostics.possibleCause = '设备在系统中标记为不可用状态';
        diagnostics.suggestedAction = '检查设备实际状态，必要时在系统中更新设备状态';
      } else if (a.code === 'sn_bound_elsewhere') {

        diagnostics.possibleCause = '设备可能从其他机器移动过来，但系统中未更新绑定关系';
        diagnostics.suggestedAction = '确认设备实际位置，在系统中解绑原机器并重新绑定';
      } else if (a.code === 'unregistered_sn') {

        diagnostics.possibleCause = '新设备尚未入库登记，或SN码识别错误';
        diagnostics.suggestedAction = '在"SN码管理"中登记该设备，或检查标定文件中的SN是否正确';
      } else if (a.code === 'bound_but_disconnected') {

        diagnostics.registeredSN = a.snCode;
        diagnostics.possibleCause = '设备断电、网线松动、或设备故障';
        diagnostics.suggestedAction = '检查设备电源和网线连接，尝试重启设备';
      } else if (a.code === 'glove_no_sn') {

        diagnostics.possibleCause = '标定文件缺失、格式错误、或采集器容器未运行';
        diagnostics.suggestedAction = '检查/var/.rdc2/wuji_calib/目录是否存在标定文件，或检查importer-staging容器状态';
      } else if (a.code === 'importer_unreachable') {
        diagnostics.possibleCause = 'Importer 进程未运行、端口被占用、或本机服务网络异常';
        diagnostics.suggestedAction = '检查采集机 5025 端口和 Importer 服务日志';
      } else if (a.code === 'hermes_unreachable') {
        diagnostics.possibleCause = 'Hermes 进程未运行或 5006 端口暂不可用';
        diagnostics.suggestedAction = '检查 Hermes 主程序状态和 5006 端口';
      } else if (a.code === 'collector_degraded') {
        diagnostics.possibleCause = '摄像头、手套、Quest 或录制器组件未连接';
        diagnostics.suggestedAction = '根据降级组件名称检查对应设备连接和采集程序日志';
      } else if (a.code === 'emergency_stopped') {
        diagnostics.possibleCause = '现场触发急停或采集程序检测到急停信号';
        diagnostics.suggestedAction = '现场确认安全后按流程解除急停，不要远程绕过安全机制';
      } else if (a.code === 'recorder_not_ready') {
        diagnostics.possibleCause = '录制器仍在预热或初始化失败';
        diagnostics.suggestedAction = '等待录制器就绪，若持续异常则检查磁盘和 Hermes 日志';
      } else if (a.code === 'hermes_errors') {
        diagnostics.possibleCause = 'Hermes 当前报告一个或多个运行错误';
        diagnostics.suggestedAction = '查看 Hermes 错误列表和对应组件状态';
      }

      const alertContext = {
        firstDetected: new Date().toISOString(),
        occurrenceCount: 1,
        relatedAlerts: alerts.filter(x => x.code !== a.code).map(x => `${x.code}(${x.hand || '-'})`),
      };

      try {
        const r = await _createSystemTicket({
          machineNumber,
          equipmentType: collectorAlert ? 'collector' : 'glove',
          equipmentTypeName: collectorAlert ? '采集程序' : '手套',
          faultType: rule.faultType,
          faultDescription: a.message,
          priority: rule.priority,
          alertCode: a.code,
          diagnostics,
          deviceSnapshot,
          environmentInfo,
          alertContext,
        });
        const ts = new Date().toISOString();
        if (r && r.ok) {
          ticketed[key] = { ticketId: r.item.id, at: ts };
        } else {

          ticketed[key] = { skipped: true, reason: (r && r.reason) || 'unknown', existingId: (r && r.existingId) || null, skippedAt: ts };
        }
      } catch (e) {
        console.error(`[EDGE] 自动建单失败 ${machineNumber} ${a.code}:`, e.message);
      }
    }

    for (const key of Object.keys(ticketed)) {
      if (!activeKeys.has(key)) {
        console.log(`[EDGE] ${machineNumber} 告警恢复: ${key}（对应工单需人工确认完成）`);
        delete ticketed[key];
      }
    }
    return ticketed;
  }

  async function handleHeartbeat(req, res, body) {
    if (!authenticate(req, res)) return;
    const b = body || {};

    const machineNumber = String(b.machineNumber || '').trim().toLowerCase();
    if (!machineNumber) return sendJSON(res, { error: 'machineNumber 为必填' }, 400);

    let observed = {
      left: { connected: false, snCode: null, ip: '192.168.1.100' },
      right: { connected: false, snCode: null, ip: '192.168.1.101' },
    };
    let alerts = [];
    try {
      const r = await reconcile(machineNumber, b.devices || {}, b);
      observed = r.observed;
      alerts = r.alerts;
    } catch (e) {
      console.error('[EDGE] reconcile 失败:', e.message);
      alerts.push({ level: 'warn', code: 'reconcile_failed', message: '服务端比对异常，请人工核查' });
    }

    const now = new Date().toISOString();

    let prev = null;
    try {
      const [rows] = await pool.execute('SELECT status, data FROM edge_hosts WHERE machineNumber = ?', [machineNumber]);
      prev = rows[0] || null;
    } catch {              }
    let prevData = {};
    try { prevData = JSON.parse((prev && prev.data) || '{}'); } catch {}

    let ticketedAlerts = {};
    try {
      ticketedAlerts = await _autoTicket(machineNumber, alerts, prevData, b);
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
      cameraFps: b.cameraFps || null,
      handStream: b.handStream || null,
      host: b.host || {},
      importer: b.importer || null,
      hermes: b.hermes || null,
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

    await _setRedisPresence(machineNumber, {
      machineNumber,
      ts: now,
      observed,
      alerts,
      importer: b.importer || null,
      hermes: b.hermes || null,
    });

    let prevAlertCodes = [];
    try { prevAlertCodes = (JSON.parse((prev && prev.data) || '{}').alerts || []).map(a => a.code); } catch {}
    const becameOnline = !prev || prev.status !== 'online';
    const alertsChanged = JSON.stringify(prevAlertCodes.sort()) !== JSON.stringify(alerts.map(a => a.code).sort());
    if (becameOnline || alertsChanged) {
      try { broadcastSSE('machine_presence_updated', { machineNumber }); } catch {}
    }

    sendJSON(res, { success: true, machineNumber, serverTime: now, observed, alerts });
  }

  async function handleOffline(req, res, body) {
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
        importer: d.importer || null,
        hermes: d.hermes || null,
        updatedAt: r.updatedAt || null,
      };
    });
    sendJSON(res, hosts);
  }

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
          edgeDevices: d.devices || null,
          edgeCameraFps: d.cameraFps || null,
          edgeHandStream: d.handStream || null,
          importer: d.importer || null,
          hermes: d.hermes || null,
        };
      }
    } catch {                                          }
    return map;
  }

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
