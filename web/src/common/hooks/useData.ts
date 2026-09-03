// 常用服务端数据查询 hooks（全局共享，SSE 事件自动失效刷新）
import { useQuery } from '@tanstack/react-query';
import * as api from '../api';
import { defaultEquipmentConfig, defaultInventoryConfig } from '../utils/domain';

export function useInventory() {
  return useQuery({ queryKey: ['inventory'], queryFn: api.getAllInventory });
}

export function useMachines() {
  return useQuery({ queryKey: ['machines'], queryFn: api.getMachines });
}

export function useSNRegistry() {
  return useQuery({ queryKey: ['sn-registry'], queryFn: api.getSNRegistry });
}

export function useTransactions(limit = 2000) {
  return useQuery({ queryKey: ['transactions', limit], queryFn: () => api.getTransactions(limit) });
}

export function useSettings() {
  return useQuery({ queryKey: ['settings'], queryFn: api.getSettings });
}

export function useAuditLog() {
  return useQuery({ queryKey: ['audit-log'], queryFn: api.getAuditLog });
}

export function useUsers() {
  return useQuery({ queryKey: ['users'], queryFn: api.getUsers });
}

export function useTechSupport() {
  return useQuery({ queryKey: ['tech-support'], queryFn: api.getTechSupportList });
}

export function useStorageLocations() {
  return useQuery({ queryKey: ['storage-locations'], queryFn: api.getStorageLocations });
}

export function useWarehouses() {
  return useQuery({ queryKey: ['warehouses'], queryFn: api.getWarehouses });
}

/** 设备类型配置（后端为空时用默认配置兜底） */
export function useEquipmentConfig() {
  return useQuery({
    queryKey: ['equipment-config'],
    queryFn: async () => {
      const data = await api.getEquipmentConfig().catch(() => null);
      return Array.isArray(data) && data.length > 0 ? data : defaultEquipmentConfig();
    },
  });
}

/** 库存类型配置（后端为空时用默认配置兜底） */
export function useInventoryConfig() {
  return useQuery({
    queryKey: ['inventory-config'],
    queryFn: async () => {
      const data = await api.getInventoryConfig().catch(() => null);
      return Array.isArray(data) && data.length > 0 ? data : defaultInventoryConfig();
    },
  });
}

/** 批次列表（Phase 2 批次管理，筛选变化即重新查询） */
export function useBatches(filters: { invType?: string; warehouseId?: string; status?: string } = {}) {
  return useQuery({
    queryKey: ['batches', filters],
    queryFn: () => {
      const params = new URLSearchParams();
      params.set('limit', '1000');
      if (filters.invType) params.set('invType', filters.invType);
      if (filters.warehouseId) params.set('warehouseId', filters.warehouseId);
      if (filters.status) params.set('status', filters.status);
      return api.getBatches(params.toString());
    },
  });
}

/** 仓库调拨单列表（Phase 2 仓库调拨） */
export function useWarehouseTransfers(filters: { status?: string } = {}) {
  return useQuery({
    queryKey: ['warehouse-transfers', filters],
    queryFn: () => {
      const params = new URLSearchParams();
      params.set('limit', '500');
      if (filters.status) params.set('status', filters.status);
      return api.getWarehouseTransfers(params.toString());
    },
  });
}
