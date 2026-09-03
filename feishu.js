/**
 * Feishu Bitable Sync Module
 * 飞书多维表格实时同步模块
 *
 * Syncs tech_support (维修日志) to Feishu Bitable in real-time.
 * Created / Updated / Deleted records are synced to the configured Bitable.
 */

const https = require('https');

// ==================== CONFIG ====================
const FEISHU_CONFIG = {
  appId: process.env.FEISHU_APP_ID || 'cli_aaa42355f0389cfc',
  appSecret: process.env.FEISHU_APP_SECRET || 'v2vU8YCrU0GHJdUsIa8nN1edaEGdkPm8',
  // SZX3 多维表格: https://weai-apac.feishu.cn/base/Lo7mb8Virax0k2smZticmh6JnAg?table=tblJ65qGy7te8NC5
  appToken: process.env.FEISHU_APP_TOKEN || 'Lo7mb8Virax0k2smZticmh6JnAg',
  tableId: process.env.FEISHU_TABLE_ID || 'tblJ65qGy7te8NC5',
  baseUrl: 'open.feishu.cn',
  // 飞书群机器人 Webhook（SZX3 运维通知群）
  groupWebhook: process.env.FEISHU_WEBHOOK || 'https://open.feishu.cn/open-apis/bot/v2/hook/7a28653d-43b8-4586-a840-6736816304fb',
};

// ==================== TOKEN CACHE ====================
let cachedToken = null;
let tokenExpiresAt = 0;

/**
 * Get tenant_access_token (auto-cached, 2h TTL)
 */
async function getAccessToken() {
  if (cachedToken && Date.now() < tokenExpiresAt - 60000) {
    return cachedToken;
  }

  const body = JSON.stringify({
    app_id: FEISHU_CONFIG.appId,
    app_secret: FEISHU_CONFIG.appSecret,
  });

  const res = await feishuRequest('POST', '/open-apis/auth/v3/tenant_access_token/internal', body);

  if (res.code !== 0) {
    console.error('[Feishu] Failed to get token:', res.msg);
    throw new Error(`Feishu auth failed: ${  res.msg}`);
  }

  cachedToken = res.tenant_access_token;
  tokenExpiresAt = Date.now() + (res.expire || 7200) * 1000;
  console.log('[Feishu] Token refreshed, expires in', res.expire, 's');
  return cachedToken;
}

/**
 * Make a request to Feishu Open API
 */
function feishuRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: FEISHU_CONFIG.baseUrl,
      path: path,
      method: method,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`Invalid JSON response: ${  data.slice(0, 200)}`));
        }
      });
    });

    req.on('error', (e) => reject(e));
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Request timeout')); });

    if (body) req.write(body);
    req.end();
  });
}

/**
 * Make an authenticated request
 */
async function feishuAuthRequest(method, path, body) {
  const token = await getAccessToken();
  return new Promise((resolve, reject) => {
    const options = {
      hostname: FEISHU_CONFIG.baseUrl,
      path: path,
      method: method,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Authorization': `Bearer ${  token}`,
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`Invalid JSON response: ${  data.slice(0, 200)}`));
        }
      });
    });

    req.on('error', (e) => reject(e));
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Request timeout')); });

    if (body) req.write(body);
    req.end();
  });
}

// ==================== FIELD MAPPING ====================
// tech_support record → Feishu Bitable fields
function mapToFeishuFields(item) {
  // 3 种状态：待响应 / 处理中 / 已完成（兼容旧枚举）
  // ⚠️ 取值必须存在于飞书表格"状态"单选字段选项中
  const statusMap = {
    pending: '待响应', in_progress: '处理中', completed: '已完成',
  };

  // Convert ISO date string to Unix timestamp (ms), or null if empty
  function toTimestamp(isoStr) {
    if (!isoStr) return null;
    const ts = new Date(isoStr).getTime();
    return isNaN(ts) ? null : ts;
  }

  return {
    '请求ID': item.id || '',
    '提交人': item.submitterName || '',
    '设备类型': item.equipmentTypeName || item.equipmentType || '',
    '机器编号': item.machineNumber || '',
    '故障类型': item.faultType || '',
    '故障描述': item.faultDescription || '',
    '状态': statusMap[item.status] || item.status || '',
    '维修人': item.responderName || '',
    '提交时间': toTimestamp(item.submittedAt),
    '响应时间': toTimestamp(item.respondedAt),
    '完成时间': toTimestamp(item.completedAt),
    '等待时长': toMinutes(item.waitSeconds),
    '维修时长': toMinutes(item.repairSeconds),
    '总时长': toMinutes(item.totalSeconds),
    '维修结果': item.result || '',
  };
}

function formatDuration(seconds) {
  if (seconds == null || seconds === '') return null;
  const s = parseInt(seconds);
  if (isNaN(s)) return null;
  if (s < 60) return '<1分钟';
  const m = Math.round(s / 60);
  if (m < 60) return `${m  }分钟`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm > 0 ? `${h  }时${  rm  }分` : `${h  }小时`;
}

// Plain number in minutes (for Feishu number field — sum/average friendly)
function toMinutes(seconds) {
  if (seconds == null || seconds === '') return null;
  const s = parseInt(seconds);
  if (isNaN(s)) return null;
  return Math.round((s / 60) * 10) / 10; // 1 decimal place
}

// ==================== RECORD ID MAPPING ====================
// We need to track which Feishu record corresponds to which tech_support ID
// Store in memory (will be rebuilt on server restart via Feishu API query)
const recordIdMap = {}; // tech_support_id → feishu_record_id

// ==================== SYNC FUNCTIONS ====================

let _initialized = false;
let _initPromise = null; // 共享初始化 promise，避免并发重复初始化
async function ensureInit() {
  if (_initialized) return;
  // 并发保护：多个调用共享同一个初始化 promise，避免各自重跑 initFeishuSync
  if (!_initPromise) {
    _initPromise = initFeishuSync().then(ok => { _initialized = ok; return ok; });
  }
  await _initPromise;
}

/**
 * Remove null/undefined values from fields object
 */
function cleanFields(fields) {
  const cleaned = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value !== null && value !== undefined) {
      cleaned[key] = value;
    }
  }
  return cleaned;
}

/**
 * 按请求ID精确查询飞书表格中的记录ID（替代全量初始化依赖）
 * 使用 Bitable filter：CurrentValue.[请求ID]="xxx"
 */
async function findRecordIdByRequestId(techSupportId) {
  try {
    const filter = encodeURIComponent(`CurrentValue.[请求ID]="${techSupportId}"`);
    const path = `/open-apis/bitable/v1/apps/${FEISHU_CONFIG.appToken}/tables/${FEISHU_CONFIG.tableId}/records?page_size=1&filter=${filter}`;
    const res = await feishuAuthRequest('GET', path);
    if (res.code === 0 && res.data?.items?.length > 0) {
      return res.data.items[0].record_id;
    }
    return null;
  } catch (e) {
    console.error('[Feishu] Find record error:', e.message);
    return null;
  }
}

/**
 * Sync a tech_support record to Feishu (real-time, async, non-blocking)
 */
async function syncToFeishu(item) {
  try {
    // 后台预热全量映射（不阻塞本次同步）；失败时由按需查询兜底
    ensureInit().catch(() => {});
    let existingRecordId = recordIdMap[item.id];
    if (!existingRecordId) {
      // 映射缺失（如服务器刚重启、全量初始化未完成）时按请求ID精确查询，
      // 避免把"更新"误做成"新建"导致重复记录
      existingRecordId = await findRecordIdByRequestId(item.id);
      if (existingRecordId) recordIdMap[item.id] = existingRecordId;
    }

    if (existingRecordId) {
      const fields = cleanFields(mapToFeishuFields(item));
      const res = await feishuAuthRequest('PUT',
        `/open-apis/bitable/v1/apps/${FEISHU_CONFIG.appToken}/tables/${FEISHU_CONFIG.tableId}/records/${existingRecordId}`,
        JSON.stringify({ fields }));
      if (res.code === 0) {
        console.log('[Feishu] ✅ Updated:', item.id);
      } else if (res.code === 1250101) {
        delete recordIdMap[item.id];
        return await syncToFeishu(item);
      } else {
        console.error('[Feishu] Update error:', res.code, res.msg);
      }
    } else {
      const fields = cleanFields(mapToFeishuFields(item));
      const res = await feishuAuthRequest('POST',
        `/open-apis/bitable/v1/apps/${FEISHU_CONFIG.appToken}/tables/${FEISHU_CONFIG.tableId}/records`,
        JSON.stringify({ fields }));
      if (res.code === 0 && res.data?.record) {
        recordIdMap[item.id] = res.data.record.record_id;
        console.log('[Feishu] ✅ Created:', item.id);
      } else {
        console.error('[Feishu] Create error:', res.code, res.msg);
      }
    }
  } catch (err) {
    console.error('[Feishu] Sync error:', err.message);
  }
}

/**
 * Delete a tech_support record from Feishu (real-time, async, non-blocking)
 */
async function deleteFromFeishu(techSupportId) {
  try {
    await ensureInit();
    const existingRecordId = recordIdMap[techSupportId];
    if (!existingRecordId) return;
    const res = await feishuAuthRequest('DELETE',
      `/open-apis/bitable/v1/apps/${FEISHU_CONFIG.appToken}/tables/${FEISHU_CONFIG.tableId}/records/${existingRecordId}`);
    if (res.code === 0 || res.code === 1250101) {
      delete recordIdMap[techSupportId];
      console.log('[Feishu] 🗑️ Deleted:', techSupportId);
    }
  } catch (err) {
    console.error('[Feishu] Delete error:', err.message);
  }
}

/**
 * Initialize: rebuild the record ID mapping from existing Feishu records
 * Called once at server startup
 */
async function initFeishuSync() {
  console.log('[Feishu] Initializing sync...');
  console.log('[Feishu] App ID:', FEISHU_CONFIG.appId);
  console.log('[Feishu] Table:', `${FEISHU_CONFIG.appToken  }/${  FEISHU_CONFIG.tableId}`);

  try {
    // Verify token
    const token = await getAccessToken();
    console.log('[Feishu] ✅ Auth OK');

    // List all existing records to build the ID map
    let pageToken = undefined;
    let totalRecords = 0;

    do {
      let path = `/open-apis/bitable/v1/apps/${FEISHU_CONFIG.appToken}/tables/${FEISHU_CONFIG.tableId}/records?page_size=500`;
      if (pageToken) path += `&page_token=${  pageToken}`;

      const res = await feishuAuthRequest('GET', path);

      if (res.code !== 0) {
        console.error('[Feishu] List records error:', res.code, res.msg);
        break;
      }

      if (res.data && res.data.items) {
        for (const record of res.data.items) {
          const techSupportId = record.fields['请求ID'];
          if (techSupportId) {
            recordIdMap[techSupportId] = record.record_id;
          }
        }
        totalRecords += res.data.items.length;
      }

      pageToken = res.data?.page_token;
    } while (pageToken);

    console.log('[Feishu] ✅ Sync initialized. Mapped', totalRecords, 'existing records');
    return true;
  } catch (err) {
    console.error('[Feishu] Init error:', err.message);
    console.error('[Feishu] Sync will retry on next operation');
    return false;
  }
}

// ==================== GROUP MESSAGE ====================
/**
 * 发送消息到飞书群（通过自定义机器人 Webhook）
 * @param {string} title 消息标题
 * @param {string} content 消息内容
 */
async function sendGroupMessage(title, content) {
  if (!FEISHU_CONFIG.groupWebhook) {
    console.log('[Feishu] Webhook not configured, skip group message');
    return false;
  }
  try {
    const url = new URL(FEISHU_CONFIG.groupWebhook);
    const body = JSON.stringify({
      msg_type: 'interactive',
      card: {
        header: { title: { tag: 'plain_text', content: title }, template: 'red' },
        elements: [{ tag: 'markdown', content: content }],
      },
    });
    const res = await new Promise((resolve, reject) => {
      const req = https.request({
        hostname: url.hostname, path: url.pathname + url.search, method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        timeout: 8000,
      }, (res) => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(JSON.parse(d))); });
      req.on('error', reject);
      req.write(body);
      req.end();
    });
    console.log('[Feishu] Group message sent:', res.StatusMessage || 'ok');
    return true;
  } catch (e) {
    console.error('[Feishu] Group message failed:', e.message);
    return false;
  }
}

module.exports = {
  syncToFeishu,
  deleteFromFeishu,
  initFeishuSync,
  sendGroupMessage,
};
