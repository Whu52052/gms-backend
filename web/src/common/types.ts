// 领域类型定义（宽松定义，兼容后端历史字段）

export interface User {
  id?: string | number;
  userId?: string | number;
  username: string;
  role: string; // admin | superadmin | ops_admin | team_leader | member ...
  system?: 'maintenance' | 'operations';
  groupRole?: string;
  [k: string]: any;
}

export interface InventoryItem {
  id?: string | number;
  type: string;
  quantity: number;
  updatedAt?: string;
  updatedBy?: string;
  [k: string]: any;
}

export interface Machine {
  id?: string | number;
  machineNumber: string;
  machineCode?: string;
  location?: string;
  status?: string;
  gloveLeftSN?: string;
  gloveRightSN?: string;
  lastMaintenance?: string;
  updatedBy?: string;
  updatedAt?: string;
  [k: string]: any;
}

export interface Transaction {
  id?: string | number;
  type?: string;
  equipmentType?: string;
  handType?: string;
  quantity?: number;
  direction?: 'in' | 'out' | string;
  snCode?: string;
  machineNumber?: string;
  note?: string;
  reason?: string;
  timestamp?: string;
  createdAt?: string;
  updatedBy?: string;
  [k: string]: any;
}

export interface SNEntry {
  snCode: string;
  equipmentType?: string;
  handType?: string;
  status?: string;
  machineNumber?: string;
  damageReason?: string;
  trackingNumber?: string;
  updatedAt?: string;
  updatedBy?: string;
  [k: string]: any;
}

export interface TechSupportTicket {
  id?: string | number;
  status?: string;
  title?: string;
  description?: string;
  createdBy?: string;
  createdAt?: string;
  [k: string]: any;
}

export interface EquipmentConfigItem {
  id: string;
  name?: string;
  label?: string;
  [k: string]: any;
}

export interface InventoryConfigItem {
  id: string;
  name?: string;
  label?: string;
  [k: string]: any;
}

export interface StorageLocation {
  code: string;
  name?: string;
  description?: string;
  [k: string]: any;
}

// ITSM 状态归一化：新枚举 → 旧 bucket（与后端 _legacyStatus 保持一致）
export const tsBucket = (s?: string): string =>
  ({
    open: 'pending',
    assigned: 'pending',
    in_progress: 'responded',
    reopened: 'responded',
    resolved: 'completed',
    closed: 'completed',
  } as Record<string, string>)[s || ''] || s || 'pending';
