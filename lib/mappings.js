/**
 * lib/mappings.js
 * Pure data-transformation helpers — zero external state, no DB/IO.
 * Extracted from server.js for testability and to reduce file-level coupling.
 */

// Format duration in seconds → human-readable string
// Boundary uses the raw input: [0, 60) → "<1分钟", so 59.9s stays "<1分钟"
// instead of rounding up to 60 and becoming "1分钟".
function fmtDuration(seconds) {
  if (seconds == null) return '-';
  if (seconds < 60) return '<1分钟';
  const s = Math.round(seconds);
  const m = Math.round(s / 60);
  if (m < 60) return `${m  }分钟`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm > 0 ? `${h  }时${  rm  }分` : `${h  }小时`;
}

// Map SN registry status → Chinese display label
function getStatusLabel(status) {
  const labels = {
    'available': '库存可用',
    'in_use': '使用中',
    'damaged': '已损坏',
    'shipped': '发货维修中',
    'repaired': '已修复',
    'scrapped': '已报废',
    'in_repair': '售后维修中',
    'transferred': '已转出',
    'replacement': '置换中',
    'retired': '已发厂家（报废）',
  };
  return labels[status] || status;
}

// Map SN equipmentType + handType → inventory type key
// e.g. ('glove','left') → 'left_glove', ('dexterous_hand','right') → 'right_dexterous_hand'
function snToInvType(equipmentType, handType) {
  if (equipmentType === 'glove') {
    if (handType === 'left') return 'left_glove';
    if (handType === 'right') return 'right_glove';
    return null;
  }
  if (equipmentType === 'dexterous_hand') {
    if (handType === 'left') return 'left_dexterous_hand';
    if (handType === 'right') return 'right_dexterous_hand';
    return null;
  }
  if (handType === 'left' || handType === 'right') return `${equipmentType  }_${  handType}`;
  if (equipmentType) return equipmentType;
  return null;
}

// Map inventory type key → [equipmentType, handType] tuple for sn_registry mutations
// e.g. 'left_glove' → ['glove','left'], 'right_dexterous_hand' → ['dexterous_hand','right']
function invTypeToSNFields(invType) {
  const mapping = {
    'left_glove': ['glove', 'left'],
    'right_glove': ['glove', 'right'],
    'left_dexterous_hand': ['dexterous_hand', 'left'],
    'right_dexterous_hand': ['dexterous_hand', 'right'],
  };
  if (mapping[invType]) return mapping[invType];
  const parts = invType.split('_');
  if (parts.length >= 2 && ['left', 'right'].includes(parts[parts.length - 1])) {
    return [parts.slice(0, -1).join('_'), parts[parts.length - 1]];
  }
  return [invType, ''];
}

// ==================== 多品类（品类配置解析） ====================
// 库存类型 → 所属品类配置项（含 _left/_right 后缀归并到基础品类）
// e.g. 'sensor' → {config: {...sensor}, handType: ''}
//      'mysensor_left' → {config: {...mysensor}, handType: 'left'}
// 未匹配（含内置 left_glove 等配置 id 直连）返回 null
function resolveCategoryConfig(invType, configItems) {
  if (!invType) return null;
  const list = configItems || [];
  const direct = list.find(c => c && c.id === invType);
  if (direct) return { config: direct, handType: '' };
  const m = String(invType).match(/^(.+)_(left|right)$/);
  if (m) {
    const base = list.find(c => c && c.id === m[1]);
    if (base) return { config: base, handType: m[2] };
  }
  return null;
}

// 库存类型的跟踪模式：'sn'（SN精细跟踪，默认/兼容旧数据）或 'quantity'（纯数量）
function categoryTrackingMode(invType, configItems) {
  const r = resolveCategoryConfig(invType, configItems);
  return r && r.config.trackingMode === 'quantity' ? 'quantity' : 'sn';
}

// 品类配置项覆盖的所有库存类型 key（用于同步/校验时跳过纯数量品类）
function categoryInvTypes(configItem) {
  if (!configItem || !configItem.id) return [];
  if (configItem.trackingMode !== 'quantity') return [];
  return configItem.hasLeftRight
    ? [`${configItem.id}_left`, `${configItem.id}_right`]
    : [configItem.id];
}

module.exports = {
  fmtDuration, getStatusLabel, snToInvType, invTypeToSNFields,
  resolveCategoryConfig, categoryTrackingMode, categoryInvTypes,
};
