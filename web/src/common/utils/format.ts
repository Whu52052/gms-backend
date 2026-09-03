// 格式化与映射工具（移植自 js/ui/format-helpers.js）

export function formatTime(ts?: string | number | null): string {
  if (!ts) return '-';
  const d = new Date(ts);
  if (isNaN(d.getTime())) return '-';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function relativeTime(ts?: string | number | null): string {
  if (!ts) return '-';
  const then = new Date(ts).getTime();
  if (isNaN(then)) return '-';
  const seconds = Math.floor((Date.now() - then) / 1000);
  if (seconds < 60) return '刚刚';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}天前`;
  return formatTime(ts).slice(0, 10);
}

export function getHandType(invType: string): string | null {
  if (invType === 'left_glove' || invType === 'left_dexterous_hand') return 'left';
  if (invType === 'right_glove' || invType === 'right_dexterous_hand') return 'right';
  if (invType.endsWith('_left')) return 'left';
  if (invType.endsWith('_right')) return 'right';
  return null;
}

export function getEquipmentType(invType: string): string {
  if (invType === 'left_glove' || invType === 'right_glove') return 'glove';
  if (invType === 'left_dexterous_hand' || invType === 'right_dexterous_hand') return 'dexterous_hand';
  return invType;
}

export function isGloveType(invType: string): boolean {
  return invType === 'left_glove' || invType === 'right_glove'
    || invType === 'left_dexterous_hand' || invType === 'right_dexterous_hand'
    || invType.endsWith('_left') || invType.endsWith('_right');
}

export function snToInvType(equipmentType?: string, handType?: string): string {
  if (equipmentType === 'glove') return handType === 'left' ? 'left_glove' : 'right_glove';
  if (equipmentType === 'dexterous_hand') return handType === 'left' ? 'left_dexterous_hand' : 'right_dexterous_hand';
  if (handType) return `${equipmentType}_${handType}`;
  return equipmentType || 'left_glove';
}

export function equipmentLabel(type?: string, handType?: string): string {
  if (type === 'glove') return handType === 'left' ? '左手手套' : '右手手套';
  if (type === 'dexterous_hand') return handType === 'left' ? '左手灵巧手' : (handType === 'right' ? '右手灵巧手' : '灵巧手');
  if (type === 'gripper') return '夹爪(Pika)';
  return type || '-';
}

export function cumulativeSum(arr: number[]): number[] {
  let sum = 0;
  return arr.map(v => (sum += v));
}

/** 机器编号自然排序（提取数字部分按数值比较） */
export function naturalCompare(a: string, b: string): number {
  const ma = a.match(/^(\D*)(\d+)$/), mb = b.match(/^(\D*)(\d+)$/);
  if (ma && mb && ma[1] === mb[1]) return parseInt(ma[2], 10) - parseInt(mb[2], 10);
  const na = parseInt(a, 10), nb = parseInt(b, 10);
  if (!isNaN(na) && !isNaN(nb)) return na - nb;
  return a.localeCompare(b, 'zh-CN', { numeric: true });
}
