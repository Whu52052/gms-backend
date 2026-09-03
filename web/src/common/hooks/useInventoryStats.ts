// 库存状态统计（移植自 js/ui/inventory.js _getStatusCounts/_getAvailableInventory）
import { useInventory, useSNRegistry, useInventoryConfig } from './useData';

export interface StatusCounts {
  total: number;
  available: number;
  inUse: number;
  damaged: number;
  inRepair: number;
}

export function statusCountsFor(inventoryType: string, registry: any[]): StatusCounts {
  let eqType: string, handType: string | null;
  if (inventoryType === 'left_glove') { eqType = 'glove'; handType = 'left'; }
  else if (inventoryType === 'right_glove') { eqType = 'glove'; handType = 'right'; }
  else if (inventoryType === 'left_dexterous_hand') { eqType = 'dexterous_hand'; handType = 'left'; }
  else if (inventoryType === 'right_dexterous_hand') { eqType = 'dexterous_hand'; handType = 'right'; }
  else if (inventoryType.endsWith('_left')) { eqType = inventoryType.slice(0, -5); handType = 'left'; }
  else if (inventoryType.endsWith('_right')) { eqType = inventoryType.slice(0, -6); handType = 'right'; }
  else { eqType = inventoryType; handType = null; }

  const relevant = (registry || []).filter(r => {
    if (r.equipmentType === eqType) {
      if (handType) return r.handType === handType;
      return true;
    }
    return r.equipmentType === inventoryType;
  });
  return {
    total: relevant.length,
    available: relevant.filter(r => r.status === 'available').length,
    inUse: relevant.filter(r => r.status === 'in_use').length,
    damaged: relevant.filter(r => r.status === 'damaged').length,
    inRepair: relevant.filter(r => r.status === 'in_repair').length,
  };
}

/** 组合库存 + SN 统计 */
export function useInventoryStats() {
  const inventory = useInventory();
  const snRegistry = useSNRegistry();
  const inventoryConfig = useInventoryConfig();

  const invMap: Record<string, any> = {};
  (inventory.data || []).forEach((it: any) => { invMap[it.type] = it; });

  const getQuantity = (type: string): number => invMap[type]?.quantity ?? 0;
  const getCounts = (type: string): StatusCounts => statusCountsFor(type, snRegistry.data || []);

  return {
    inventory,
    snRegistry,
    inventoryConfig,
    invMap,
    getQuantity,
    getCounts,
  };
}
