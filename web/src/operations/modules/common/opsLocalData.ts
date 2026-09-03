// 运营端本地数据（移植 OpsApp._loadLocalData/_saveTasks/_saveRequirements）
// 任务与需求存于 localStorage，保留原存储键 ops_tasks / ops_requirements
export interface OpsTask {
  id: string;
  text: string;
  priority: 'high' | 'medium' | 'low';
  done: boolean;
  date: string; // zh-CN 本地日期字符串
}

export interface OpsRequirement {
  id: string;
  title: string;
  requester: string;
  priority: 'high' | 'medium' | 'low';
  status: 'pending' | 'approved' | 'rejected';
  date: string;
}

export function loadTasks(): OpsTask[] {
  try { return JSON.parse(localStorage.getItem('ops_tasks') || '[]'); } catch { return []; }
}
export function saveTasks(tasks: OpsTask[]) {
  localStorage.setItem('ops_tasks', JSON.stringify(tasks));
}
export function loadRequirements(): OpsRequirement[] {
  try { return JSON.parse(localStorage.getItem('ops_requirements') || '[]'); } catch { return []; }
}
export function saveRequirements(reqs: OpsRequirement[]) {
  localStorage.setItem('ops_requirements', JSON.stringify(reqs));
}

export const PRIORITY_LABEL: Record<string, string> = { high: '高优先', medium: '中优先', low: '低优先' };
export const PRIORITY_COLOR: Record<string, string> = { high: '#ef4444', medium: '#f59e0b', low: '#10b981' };
export const REQ_STATUS_LABEL: Record<string, string> = { pending: '待处理', approved: '已通过', rejected: '已拒绝' };
export const REQ_STATUS_COLOR: Record<string, string> = { pending: 'orange', approved: 'green', rejected: 'red' };

// 时长格式化（移植 OpsApp._fmtDuration）
export function fmtDuration(seconds?: number | null): string {
  if (seconds == null) return '-';
  const s = Math.round(seconds);
  if (s < 60) return '<1分钟';
  const m = Math.round(s / 60);
  if (m < 60) return m + '分钟';
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm > 0 ? h + '时' + rm + '分' : h + '小时';
}

// 分类色（移植 OpsApp._catColor）
export function catColor(cat?: string): string {
  const colors = ['#6366f1', '#10b981', '#f59e0b', '#ef4444', '#3b82f6', '#8b5cf6', '#14b8a6'];
  let h = 0;
  for (let i = 0; i < (cat || '').length; i++) h = (h * 31 + (cat || '').charCodeAt(i)) % 997;
  return colors[h % colors.length];
}
