// 机器/设备领域计算（移植自 js/storage.js + js/utils.js 的纯逻辑）

/** 按 machineNumber 取最新记录（比较 updatedAt，其次 id） */
export function latestMachineByNumber(machines: any[]): Record<string, any> {
  const map: Record<string, any> = {};
  for (const m of machines || []) {
    if (!m || !m.machineNumber) continue;
    const existing = map[m.machineNumber];
    if (!existing) { map[m.machineNumber] = m; continue; }
    const mTime = m.updatedAt ? new Date(m.updatedAt).getTime() : 0;
    const eTime = existing.updatedAt ? new Date(existing.updatedAt).getTime() : 0;
    if (mTime > eTime || (mTime === eTime && String(m.id || '') > String(existing.id || ''))) {
      map[m.machineNumber] = m;
    }
  }
  return map;
}

/**
 * 机器有效状态：根据 SN 注册表中 in_use 且绑定该机器的左右手数量判断
 * online(左右都有) / partial(只有一只) / offline(没有)
 */
export function buildEffectiveStatusMap(machines: any[], snRegistry: any[]): Record<string, string> {
  const handsByMachine: Record<string, Set<string>> = Object.create(null);
  for (const s of snRegistry || []) {
    if (s.status !== 'in_use' || !s.machineNumber) continue;
    if (s.handType !== 'left' && s.handType !== 'right') continue;
    if (!handsByMachine[s.machineNumber]) handsByMachine[s.machineNumber] = new Set();
    handsByMachine[s.machineNumber].add(s.handType);
  }
  const result: Record<string, string> = Object.create(null);
  for (const m of machines || []) {
    if (!m || !m.machineNumber) continue;
    if (result[m.machineNumber] !== undefined) continue;
    const hands = handsByMachine[m.machineNumber];
    let st = 'offline';
    if (hands) {
      const hasL = hands.has('left'), hasR = hands.has('right');
      if (hasL && hasR) st = 'online';
      else if (hasL || hasR) st = 'partial';
    }
    result[m.machineNumber] = st;
  }
  return result;
}

// ==================== 默认配置（后端无配置时的兜底） ====================
export const defaultEquipmentConfig = () => [
  {
    id: 'glove', name: '纯手套设备', icon: '🧤',
    consumes: [
      { inventoryType: 'left_glove', handType: 'left', quantity: 1 },
      { inventoryType: 'right_glove', handType: 'right', quantity: 1 },
    ],
  },
  {
    id: 'dexterous', name: '灵巧手设备', icon: '🤖',
    consumes: [
      { inventoryType: 'left_glove', handType: 'left', quantity: 1 },
      { inventoryType: 'right_glove', handType: 'right', quantity: 1 },
      { inventoryType: 'left_dexterous_hand', handType: 'left', quantity: 1 },
      { inventoryType: 'right_dexterous_hand', handType: 'right', quantity: 1 },
    ],
  },
  {
    id: 'gripper', name: '夹爪设备', icon: '🔧',
    consumes: [{ inventoryType: 'gripper', handType: null, quantity: 2 }],
  },
];

export const defaultInventoryConfig = () => [
  { id: 'left_glove', name: '左手手套', icon: '🧤', hasLeftRight: false, trackingMode: 'sn' },
  { id: 'right_glove', name: '右手手套', icon: '🧤', hasLeftRight: false, trackingMode: 'sn' },
  { id: 'left_dexterous_hand', name: '左手灵巧手', icon: '🤖', hasLeftRight: false, trackingMode: 'sn' },
  { id: 'right_dexterous_hand', name: '右手灵巧手', icon: '🤖', hasLeftRight: false, trackingMode: 'sn' },
  { id: 'gripper', name: '夹爪', icon: '🔧', hasLeftRight: false, trackingMode: 'sn' },
];

// ==================== 多品类：跟踪模式解析 ====================

/** 库存类型 → 所属品类配置（含 _left/_right 后缀归并），未匹配返回 null */
export function resolveCategory(invType?: string, inventoryConfig?: any[]): { config: any; handType: string } | null {
  if (!invType) return null;
  const list = inventoryConfig || [];
  const direct = list.find(c => c && c.id === invType);
  if (direct) return { config: direct, handType: '' };
  const m = invType.match(/^(.+)_(left|right)$/);
  if (m) {
    const base = list.find(c => c && c.id === m[1]);
    if (base) return { config: base, handType: m[2] };
  }
  return null;
}

/** 库存类型的跟踪模式：'sn'（SN精细跟踪，默认/兼容旧数据）或 'quantity'（纯数量） */
export function trackingModeOf(invType?: string, inventoryConfig?: any[]): 'sn' | 'quantity' {
  const r = resolveCategory(invType, inventoryConfig);
  return r && r.config.trackingMode === 'quantity' ? 'quantity' : 'sn';
}

/** 设备类型 → 消耗的库存类型映射 */
export function deviceConsumptionMap(equipmentConfig: any[], equipmentTypeId: string): Record<string, number> {
  const eq = (equipmentConfig || []).find(e => e.id === equipmentTypeId);
  const fallback: Record<string, Record<string, number>> = {
    glove: { left_glove: 1, right_glove: 1 },
    dexterous: { left_glove: 1, right_glove: 1, left_dexterous_hand: 1, right_dexterous_hand: 1 },
    gripper: { gripper: 2 },
  };
  if (!eq) return fallback[equipmentTypeId] || {};
  const map: Record<string, number> = {};
  (eq.consumes || []).forEach((c: any) => {
    map[c.inventoryType] = (map[c.inventoryType] || 0) + c.quantity;
  });
  return map;
}

export const deviceTypeLabel = (type?: string): string =>
  ({ glove: '纯手套设备', dexterous: '灵巧手设备', gripper: '夹爪设备' } as Record<string, string>)[type || ''] || type || '-';

/** 库存类型中文标签（从库存类型配置查找，含 _left/_right 后缀解析，移植 Storage._typeLabel） */
export function typeLabelOf(invType?: string, inventoryConfig?: any[]): string {
  if (!invType) return '-';
  const builtin: Record<string, string> = {
    left_glove: '左手手套', right_glove: '右手手套',
    left_dexterous_hand: '左手灵巧手', right_dexterous_hand: '右手灵巧手',
    gripper: '夹爪',
  };
  const cfgList = inventoryConfig || [];
  const direct = cfgList.find(c => c.id === invType);
  if (direct) return direct.name;
  if (builtin[invType]) return builtin[invType];
  const m = invType.match(/^(.+)_(left|right)$/);
  if (m) {
    const base = cfgList.find(c => c.id === m[1]);
    if (base) return `${base.name}${m[2] === 'left' ? '左手' : '右手'}`;
  }
  return invType;
}

// SN 状态中文标签与颜色（AntD Tag）
export const SN_STATUS_META: Record<string, { label: string; color: string }> = {
  available: { label: '可用', color: 'green' },
  in_use: { label: '使用中', color: 'blue' },
  damaged: { label: '损坏', color: 'red' },
  in_repair: { label: '售后维修中', color: 'orange' },
  repaired: { label: '已修复', color: 'cyan' },
  repairing: { label: '维修中', color: 'orange' },
  waiting_repair: { label: '等待维修', color: 'gold' },
  transferred: { label: '已发货', color: 'purple' },
  shipped: { label: '已发货', color: 'purple' },
  after_sales: { label: '送售后', color: 'magenta' },
  scrapped: { label: '已报废', color: 'default' },
};

export const MACHINE_STATUS_META: Record<string, { label: string; color: string }> = {
  online: { label: '在线', color: 'green' },
  partial: { label: '部分绑定', color: 'gold' },
  offline: { label: '离线', color: 'red' },
  waiting_repair: { label: '等待维修', color: 'orange' },
  repairing: { label: '维修中', color: 'blue' },
};

// 机器生产状态（独立于设备挂接状态的生产维度；待维修由维修工单自动驱动）
export const PRODUCTION_STATUS_META: Record<string, { label: string; color: string }> = {
  ready: { label: '可生产', color: 'green' },
  in_production: { label: '在生产', color: 'blue' },
  waiting_repair: { label: '待维修', color: 'red' },
  testing: { label: '在测试', color: 'orange' },
};
export const PRODUCTION_STATUS_ORDER = ['ready', 'in_production', 'waiting_repair', 'testing'];
/** 取机器生产状态，无记录默认可生产 */
export const productionStatusOf = (m: any): string => m?.productionStatus || 'ready';
