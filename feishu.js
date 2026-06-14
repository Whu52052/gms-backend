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
  appId: 'cli_aaa42355f0389cfc',
  appSecret: 'v2vU8YCrU0GHJdUsIa8nN1edaEGdkPm8',
  appToken: 'Fi1iwkk9yiAmBUkDdv9cUWrVnuc',
  tableId: 'tbl2e7qw33F7tatz',
  baseUrl: 'open.feishu.cn',
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
    throw new Error('Feishu auth failed: ' + res.msg);
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

    // Add Authorization if not auth endpoint
    if (!path.includes('/auth/')) {
      // Token will be added in the caller
    }

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error('Invalid JSON response: ' + data.slice(0, 200)));
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
  const fullPath = path.includes('?') ? path + '&' : path;

  return new Promise((resolve, reject) => {
    const options = {
      hostname: FEISHU_CONFIG.baseUrl,
      path: path,
      method: method,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Authorization': 'Bearer ' + token,
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error('Invalid JSON response: ' + data.slice(0, 200)));
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
  const statusMap = {
    'pending': '待处理',
    'responded': '处理中',
    'completed': '已完成',
    'closed': '已关闭',
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
    '等待时长': formatDuration(item.waitSeconds),
    '维修时长': formatDuration(item.repairSeconds),
    '维修结果': item.result || '',
  };
}

function formatDuration(seconds) {
  if (seconds == null || seconds === '') return null;  // Return null for empty, not ''
  const s = parseInt(seconds);
  if (isNaN(s)) return null;
  if (s < 60) return s + '秒';
  if (s < 3600) return Math.floor(s / 60) + '分' + (s % 60) + '秒';
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h + '时' + m + '分';
}

// ==================== RECORD ID MAPPING ====================
// We need to track which Feishu record corresponds to which tech_support ID
// Store in memory (will be rebuilt on server restart via Feishu API query)
const recordIdMap = {}; // tech_support_id → feishu_record_id

// ==================== SYNC FUNCTIONS ====================

/**
 * Remove null/undefined values from fields object
 * Feishu silently rejects null values for Date/Number fields
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
 * Sync a tech_support record to Feishu (create or update)
 */
async function syncToFeishu(item) {
  try {
    const existingRecordId = recordIdMap[item.id];

    if (existingRecordId) {
      // Update existing record
      const fields = cleanFields(mapToFeishuFields(item));
      const res = await feishuAuthRequest(
        'PUT',
        `/open-apis/bitable/v1/apps/${FEISHU_CONFIG.appToken}/tables/${FEISHU_CONFIG.tableId}/records/${existingRecordId}`,
        JSON.stringify({ fields })
      );

      if (res.code === 0) {
        console.log('[Feishu] ✅ Updated record:', item.id);
      } else if (res.code === 1250101) {
        // Record not found (maybe deleted in Feishu), create new
        delete recordIdMap[item.id];
        return await syncToFeishu(item);
      } else {
        console.error('[Feishu] Update error:', res.code, res.msg);
      }
    } else {
      // Create new record
      const fields = cleanFields(mapToFeishuFields(item));
      const res = await feishuAuthRequest(
        'POST',
        `/open-apis/bitable/v1/apps/${FEISHU_CONFIG.appToken}/tables/${FEISHU_CONFIG.tableId}/records`,
        JSON.stringify({ fields })
      );

      if (res.code === 0 && res.data && res.data.record) {
        recordIdMap[item.id] = res.data.record.record_id;
        console.log('[Feishu] ✅ Created record:', item.id, '→', res.data.record.record_id);
      } else {
        console.error('[Feishu] Create error:', res.code, res.msg, JSON.stringify(res).slice(0, 200));
      }
    }
  } catch (err) {
    console.error('[Feishu] Sync error:', err.message);
    // Don't throw — Feishu sync should never break the main app
  }
}

/**
 * Delete a tech_support record from Feishu
 */
async function deleteFromFeishu(techSupportId) {
  try {
    const existingRecordId = recordIdMap[techSupportId];
    if (!existingRecordId) {
      console.log('[Feishu] No Feishu record ID for:', techSupportId, '- skipping delete');
      return;
    }

    const res = await feishuAuthRequest(
      'DELETE',
      `/open-apis/bitable/v1/apps/${FEISHU_CONFIG.appToken}/tables/${FEISHU_CONFIG.tableId}/records/${existingRecordId}`
    );

    if (res.code === 0) {
      delete recordIdMap[techSupportId];
      console.log('[Feishu] 🗑️ Deleted record:', techSupportId);
    } else if (res.code === 1250101) {
      // Already deleted
      delete recordIdMap[techSupportId];
      console.log('[Feishu] Record already deleted:', techSupportId);
    } else {
      console.error('[Feishu] Delete error:', res.code, res.msg);
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
  console.log('[Feishu] Table:', FEISHU_CONFIG.appToken + '/' + FEISHU_CONFIG.tableId);

  try {
    // Verify token
    const token = await getAccessToken();
    console.log('[Feishu] ✅ Auth OK');

    // List all existing records to build the ID map
    let pageToken = undefined;
    let totalRecords = 0;

    do {
      let path = `/open-apis/bitable/v1/apps/${FEISHU_CONFIG.appToken}/tables/${FEISHU_CONFIG.tableId}/records?page_size=500`;
      if (pageToken) path += '&page_token=' + pageToken;

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

module.exports = {
  syncToFeishu,
  deleteFromFeishu,
  initFeishuSync,
};
