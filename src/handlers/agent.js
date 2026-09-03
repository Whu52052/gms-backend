/**
 * src/handlers/agent.js
 * 智能助手 v2 — 自然对话模式（像豆包一样聊天）
 *
 * 核心变化：
 *   - 不再强制 JSON 输出，LLM 可以自由对话
 *   - 需要查系统数据时，在回复末尾加 [TOOL:QUERY]SQL[/TOOL] 标记
 *   - 需要执行操作时，加 [TOOL:OP]{action,snCode}[/TOOL] 标记
 *   - 后端解析标记，执行工具，再做第二轮润色回复
 *
 * 端点：
 *   POST /api/agent/chat   → 与 Agent 对话（仅限白名单账户）
 */
'use strict';

const crypto = require('crypto');

const AGENT_WHITELIST = ['Wuzhenyu', 'zhanghao', 'liuxingtong'];

module.exports = function createAgentHandlers(deps) {
  const { pool, sendJSON, broadcastSSE, _cached } = deps;

  const LLM_API_KEY = process.env.LLM_API_KEY;
  const LLM_BASE_URL = (process.env.LLM_BASE_URL || 'https://yunshuzhilian.asia/v1').replace(/\/$/, '');
  const LLM_MODEL = process.env.LLM_MODEL || 'deepseek-v4-flash';

  // ============================================================
  // 调用 LLM（OpenAI 兼容）
  // ============================================================
  async function _callLLM(messages, { temperature = 0.7 } = {}) {
    if (!LLM_API_KEY) throw new Error('未配置 LLM_API_KEY');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60000);
    try {
      const resp = await fetch(`${LLM_BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${LLM_API_KEY}` },
        body: JSON.stringify({ model: LLM_MODEL, messages, temperature }),
        signal: controller.signal,
      });
      if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        throw new Error(`LLM 请求失败 ${resp.status}: ${text.slice(0, 200)}`);
      }
      const data = await resp.json();
      return (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
    } finally {
      clearTimeout(timeout);
    }
  }

  // 从 LLM 回复中提取 [TOOL:...] 标记
  function _extractTool(text) {
    if (!text) return null;
    // [TOOL:QUERY]SELECT ...[/TOOL]
    const qm = text.match(/\[TOOL:QUERY\]([\s\S]*?)\[\/TOOL\]/i);
    if (qm) {
      let sql = qm[1].trim();
      // 只提取 SELECT 语句
      const sm = sql.match(/SELECT[\s\S]*/i);
      if (sm) sql = sm[0].trim();
      sql = sql.replace(/;\s*$/, '').trim();
      if (/^\s*SELECT/i.test(sql)) return { tool: 'query', sql };
      return null;
    }
    // [TOOL:OP]{...}[/TOOL]
    const om = text.match(/\[TOOL:OP\]([\s\S]*?)\[\/TOOL\]/i);
    if (om) {
      try {
        const op = JSON.parse(om[1].trim());
        if (op && op.action) return { tool: 'op', op };
      } catch {}
      return null;
    }
    // [TOOL:WEATHER]城市名[/TOOL]
    const wm = text.match(/\[TOOL:WEATHER\]([\s\S]*?)\[\/TOOL\]/i);
    if (wm) {
      const city = wm[1].trim();
      if (city) return { tool: 'weather', city };
      return null;
    }
    return null;
  }

  // 去掉工具标记，只保留回复文本
  function _cleanReply(text) {
    if (!text) return '';
    return text.replace(/\[TOOL:(?:QUERY|OP|WEATHER)\][\s\S]*?\[\/TOOL\]/gi, '').trim();
  }

  // ============================================================
  // 天气工具（Open-Meteo，免费无需 key）
  // ============================================================
  async function _getWeather(city) {
    // 1. 城市 → 经纬度（geocoding API）
    const geoResp = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=zh&format=json`, { signal: AbortSignal.timeout(15000) });
    const geo = await geoResp.json();
    const loc = geo.results && geo.results[0];
    if (!loc) return { error: `未找到城市「${city}」的位置信息` };

    // 2. 按经纬度查天气
    const weatherResp = await fetch(
      `https://api.open-meteo.com/v1/forecast?latitude=${loc.latitude}&longitude=${loc.longitude}&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m&daily=temperature_2m_max,temperature_2m_min,sunrise,sunset,precipitation_sum&timezone=auto&forecast_days=1`,
      { signal: AbortSignal.timeout(15000) }
    );
    const w = await weatherResp.json();

    const code = w.current && w.current.weather_code;
    const desc = {
      0: '晴', 1: '基本晴朗', 2: '局部多云', 3: '阴',
      45: '雾', 48: '雾凇', 51: '毛毛雨', 53: '毛毛雨', 55: '毛毛雨',
      61: '小雨', 63: '中雨', 65: '大雨', 71: '小雪', 73: '中雪', 75: '大雪',
      80: '阵雨', 81: '阵雨', 82: '强阵雨', 95: '雷阵雨', 96: '雷阵雨伴冰雹'
    }[code] || '未知';

    const daily = w.daily || {};
    return {
      city: loc.name + (loc.admin1 ? '（' + loc.admin1 + '）' : ''),
      description: desc,
      temperature: w.current.temperature_2m,
      feelsLike: w.current.apparent_temperature,
      humidity: w.current.relative_humidity_2m,
      windSpeed: w.current.wind_speed_10m,
      maxTemp: daily.temperature_2m_max && daily.temperature_2m_max[0],
      minTemp: daily.temperature_2m_min && daily.temperature_2m_min[0],
      sunrise: daily.sunrise && daily.sunrise[0],
      sunset: daily.sunset && daily.sunset[0],
      precipitation: daily.precipitation_sum && daily.precipitation_sum[0],
    };
  }

  // ============================================================
  // 数据库工具
  // ============================================================
  async function _query(sql) {
    const [rows] = await pool.execute(sql);
    return rows;
  }

  async function _inbound(snCode, authUser) {
    const code = String(snCode || '').trim().toUpperCase();
    if (!code) return { error: 'SN 码不能为空' };
    if (!/^[A-Z0-9\-]{6,}$/.test(code)) return { error: 'SN 码格式不正确' };
    const handType = /^WG1K/i.test(code) ? 'right' : 'left';
    const equipmentType = /(robot|灵巧|K)/i.test(code) ? 'robot_paw' : 'glove';
    const now = new Date().toISOString();
    const [existing] = await pool.execute('SELECT snCode FROM sn_registry WHERE snCode = ?', [code]);
    if (existing.length > 0) return { error: `SN ${code} 已存在，请勿重复入库` };
    await pool.execute(
      `INSERT INTO sn_registry (snCode, equipmentType, handType, status, machineNumber, trackingNumber, updatedAt)
       VALUES (?, ?, ?, 'available', NULL, NULL, ?)`,
      [code, equipmentType, handType, now]
    );
    await _logAudit('sn_inbound', { snCode: code, equipmentType, handType }, authUser);
    return { success: true, snCode: code, equipmentType, handType, status: 'available' };
  }

  async function _markDamage(snCode, reason, authUser) {
    const code = String(snCode || '').trim().toUpperCase();
    if (!code) return { error: 'SN 码不能为空' };
    const [rows] = await pool.execute('SELECT * FROM sn_registry WHERE snCode = ?', [code]);
    if (rows.length === 0) return { error: `未找到 SN ${code}` };
    const oldStatus = rows[0].status;
    await pool.execute('UPDATE sn_registry SET status = ?, damageReason = ?, updatedAt = ? WHERE snCode = ?',
      ['damaged', reason || '由 Agent 标记', new Date().toISOString(), code]);
    await _recordHistory(code, oldStatus, 'damaged', reason || '由 Agent 标记', authUser);
    await _logAudit('sn_damaged', { snCode: code, reason: reason || '由 Agent 标记' }, authUser);
    return { success: true, snCode: code, oldStatus, newStatus: 'damaged' };
  }

  async function _recordHistory(snCode, oldStatus, newStatus, reason, authUser) {
    const id = 'h-' + Date.now() + '-' + crypto.randomBytes(4).toString('hex');
    await pool.execute(
      'INSERT INTO sn_status_history (id, snCode, oldStatus, newStatus, operator, reason, createdAt) VALUES (?,?,?,?,?,?,?)',
      [id, snCode, oldStatus, newStatus, authUser.displayName || authUser.username, reason, new Date().toISOString()]
    );
  }

  async function _logAudit(action, detail, authUser) {
    try {
      const id = 'a-' + Date.now() + '-' + crypto.randomBytes(4).toString('hex');
      const data = { id, action, detail, operator: authUser.username, operatorName: authUser.displayName || authUser.username, createdAt: new Date().toISOString() };
      await pool.execute('INSERT INTO audit_log (id, data) VALUES (?, ?)', [id, JSON.stringify(data)]);
    } catch {}
  }

  // ============================================================
  // 系统提示词
  // ============================================================
  function _systemPrompt(authUser, now) {
    return `你是"小符"，一个全能中文 AI 助手，就像豆包一样自然、友好。

当前用户：${authUser.displayName || authUser.username}（${authUser.role}）
当前时间：${now}

【核心规则】
- 你可以回答任何问题：聊天、写代码、讲笑话、写诗、解答疑问、讨论天气等，不限领域。
- 如果用户问的是本系统（手套/灵巧手康复管理系统）的数据，你可以查数据库来回答。
- 语气自然、友好，像朋友一样聊天。

【查数据库的方法】
当用户需要查询系统数据时，在你的回复末尾加上：
[TOOL:QUERY]你的 SELECT SQL 语句[/TOOL]

当用户需要执行系统操作时，在你的回复末尾加上：
[TOOL:OP]{"action": "inbound"|"markDamage", "snCode": "SN码", "reason": "原因"（可选）}[/TOOL]

当用户问天气时，在你的回复末尾加上：
[TOOL:WEATHER]城市名（如 深圳、北京、东京）[/TOOL]

【系统数据库表结构】
- sn_registry(snCode, equipmentType[glove/robot_paw], handType[left/right], status[available/in_use/damaged/repair/shipped], machineNumber, trackingNumber, damageReason, shippedAt, repairedAt, updatedAt)
- inventory(inv_type, quantity, updatedAt)  —— inv_type: "glove_left"、"glove_right"、"robot_paw_left" 等
- machines(id, data JSON)  —— data 含 machineNumber、status[online/offline]、lastSeen、boundGloves 等
- tech_support(id, data JSON)  —— 工单。data 关键字段：
    · id、machineNumber、faultType、faultDescription、status[open/in_progress/complete/reopened]
    · submitterId、submitterName（报修人）
    · responderId、responderName（维修人/响应人）
    · createdAt、submittedAt（创建时间）、respondedAt（响应时间）、completedAt（完成时间）
    · waitSeconds、repairSeconds、totalSeconds（时长）
    · affectedSNs、replacedSNs（相关/更换的SN）
    · 注意：技术工单的【维修人】字段是 responderName / responderId，不是 operator
- transactions(id, data JSON)  —— 出入库流水，data 含 direction[in/out]、invType、quantity、operator、createdAt
- users(id, username, role, system, parentId, displayName)
  · parentId 指向组长的用户ID，用于定义"组长-组员"关系
  · 当前用户的ID：${authUser.userId}
  · 当前用户的角色：${authUser.role}

【统计"某人今日维修工单"的正确方法】
工单的维修人字段是 responderId（用户ID，如 u-xxx）和 responderName（拼音）。
要按用户名（如 zhanghao）统计，需先查 users 表拿到用户ID，再按 responderId 匹配：
SELECT COUNT(*) FROM tech_support
WHERE data->>'$.responderId' = '用户ID'
  AND data->>'$.completedAt' LIKE '2026-08-11%'
 
说明：
- 维修人用 responderId 匹配更准确
- 统计"今日"用 completedAt 字段 LIKE 'YYYY-MM-DD%'
- 统计"处理中"可用 status='in_progress' 和 respondedAt

【统计"我的组员提交了多少工单"的正确方法】
组员关系通过 users.parentId 定义：组员的 parentId = 组长的用户ID。
可以用一条 SQL 子查询搞定：
SELECT COUNT(*) FROM tech_support
WHERE data->>'$.submitterId' IN (
  SELECT id FROM users WHERE parentId = '当前用户ID'
)
AND data->>'$.submittedAt' LIKE '2026-08-11%'

要同时列出组员名单，可以分别查：
1. 先查组员：SELECT id, username, displayName FROM users WHERE parentId = '当前用户ID'
2. 再查工单数：SELECT COUNT(*) FROM tech_support WHERE ...

【统计"每个组员分别提交了多少工单"的正确方法】
用 GROUP BY 按提交人分组即可：
SELECT COALESCE(data->>'$.submitterName', data->>'$.submitterId') AS 提交人, COUNT(*) AS 条数
FROM tech_support
WHERE data->>'$.submitterId' IN (SELECT id FROM users WHERE parentId = '当前用户ID')
  AND data->>'$.submittedAt' LIKE '2026-08-11%'
GROUP BY 提交人
ORDER BY 条数 DESC

要列出每个组员具体提交了哪些工单（故障类型、机器号），可以：
SELECT data->>'$.submitterName' AS 提交人, data->>'$.machineNumber' AS 机器号, data->>'$.faultType' AS 故障类型, data->>'$.status' AS 状态
FROM tech_support
WHERE data->>'$.submitterId' IN (SELECT id FROM users WHERE parentId = '当前用户ID')
  AND data->>'$.submittedAt' LIKE '2026-08-11%'
ORDER BY data->>'$.submitterName'

说明：
- 用 COALESCE 兼容 submitterName 为空的情况
- 具体工单列表用 ORDER BY 提交人排序，方便归类展示

【示例】
用户：库存里还有多少康复手套？
助手：让我查一下数据库[TOOL:QUERY]SELECT quantity FROM inventory WHERE inv_type LIKE 'glove%'[/TOOL]

用户：帮我写一首关于夏天的诗
助手：（直接写诗，无需任何工具标记）

用户：入库 TEST001
助手：好的，我来帮你入库[TOOL:OP]{"action":"inbound","snCode":"TEST001"}[/TOOL]

用户：我的组员今天提交了多少个技术支持？
助手：我来查一下你的组员和他们的工单情况[TOOL:QUERY]SELECT COUNT(*) FROM tech_support WHERE data->>'$.submitterId' IN (SELECT id FROM users WHERE parentId = '${authUser.userId}') AND data->>'$.submittedAt' LIKE '2026-08-11%'[/TOOL]

用户：这些组员分别提交了哪些技术支持？
助手：我来按组员分组统计一下[TOOL:QUERY]SELECT COALESCE(data->>'$.submitterName', data->>'$.submitterId') AS 提交人, COUNT(*) AS 条数 FROM tech_support WHERE data->>'$.submitterId' IN (SELECT id FROM users WHERE parentId = '${authUser.userId}') AND data->>'$.submittedAt' LIKE '2026-08-11%' GROUP BY 提交人 ORDER BY 条数 DESC[/TOOL]

规则：
- 只用 SELECT 只读查询，不要修改数据库。
- machines、tech_support、transactions 是 JSON 表，用 data->>'$.字段' 访问。
- 主体用中文。`;
  }

  // ============================================================
  // 主入口：POST /api/agent/chat
  // ============================================================
  async function handleAgentChat(req, res, authUser, body) {
    try {
      if (!AGENT_WHITELIST.includes(authUser.username)) {
        return sendJSON(res, { error: 'Agent 功能暂未对当前账户开通' }, 403);
      }
      const message = (body && body.message && typeof body.message === 'string' ? body.message : '').trim();
      if (!message) return sendJSON(res, { error: '请输入消息内容' }, 400);

      const now = new Date();
      const systemMsg = _systemPrompt(authUser, now.toUTCString());

      // 第一轮：自然对话，LLM 自由回复，可能带 [TOOL] 标记
      const rawReply = await _callLLM([
        { role: 'system', content: systemMsg },
        { role: 'user', content: message },
      ]);

      // 解析工具标记
      const toolCall = _extractTool(rawReply);
      let cleanReply = _cleanReply(rawReply);
      let result = null;
      let usedTool = 'none';

      if (toolCall) {
        console.log('[Agent] TOOL CALL:', JSON.stringify(toolCall).slice(0, 500));
        console.log('[Agent] RAW REPLY:', rawReply.slice(0, 500));
        usedTool = toolCall.tool;
        if (toolCall.tool === 'query') {
          try {
            result = await _query(toolCall.sql);
          } catch (e) {
            console.error('[Agent] SQL error:', toolCall.sql, e.message);
            result = { error: `查询失败：${e.message}` };
          }
        } else if (toolCall.tool === 'weather') {
          try {
            result = await _getWeather(toolCall.city);
          } catch (e) {
            console.error('[Agent] weather error:', e.message);
            result = { error: `天气查询失败：${e.message}` };
          }
        } else if (toolCall.tool === 'op') {
          const op = toolCall.op;
          if (op.action === 'inbound') {
            result = await _inbound(op.snCode, authUser);
            if (result.success) broadcastSSE('sn_registry_updated', { action: 'inbound', snCode: result.snCode });
          } else if (op.action === 'markDamage') {
            result = await _markDamage(op.snCode, op.reason, authUser);
            if (result.success) broadcastSSE('sn_registry_updated', { action: 'damaged', snCode: result.snCode });
          } else {
            result = { error: `不支持的操作：${op.action}` };
          }
        }
      }

      // 如果有工具结果，做第二轮润色
      if (result !== null && !result.error) {
        try {
          const finalText = await _callLLM([
            { role: 'system', content: systemMsg },
            { role: 'user', content: message },
            { role: 'assistant', content: cleanReply || '让我查一下数据库' },
            { role: 'user', content: `数据库查询结果：${JSON.stringify(result).slice(0, 8000)}\n\n请据此给用户一个自然、友好的中文回答（不要加任何 [TOOL] 标记）。` },
          ]);
          cleanReply = finalText.replace(/\[TOOL:(?:QUERY|OP|WEATHER)\][\s\S]*?\[\/TOOL\]/gi, '').trim() || cleanReply;
        } catch (e) {
          cleanReply = cleanReply || `查询完成，结果：${JSON.stringify(result).slice(0, 200)}`;
        }
      } else if (result && result.error) {
        cleanReply = cleanReply + `\n\n（查询出错：${result.error}）`;
      }

      // 如果没有工具标记也没有工具结果，直接返回 LLM 的自然回复
      sendJSON(res, { reply: cleanReply || rawReply, tool: usedTool });
    } catch (e) {
      console.error('[Agent] error:', e.message);
      sendJSON(res, { error: `Agent 处理失败：${e.message}` }, 500);
    }
  }

  return { handleAgentChat };
};