// TanStack Query 全局客户端（单例，供 SSE 管理器直接触发失效刷新）
import { QueryClient } from '@tanstack/react-query';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 10_000,
      gcTime: 5 * 60_000,
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

// SSE/WS 事件 → 需要失效的查询键前缀
const EVENT_QUERY_MAP: Record<string, string[]> = {
  inventory_updated: ['inventory'],
  machines_updated: ['machines'],
  transactions_updated: ['transactions'],
  settings_updated: ['settings'],
  equipment_config_updated: ['equipment-config', 'configs'],
  inventory_config_updated: ['inventory-config', 'configs'],
  users_updated: ['users'],
  sn_registry_updated: ['sn-registry', 'machines'],
  audit_log_updated: ['audit-log'],
  storage_locations_updated: ['storage-locations'],
  ops_orders_updated: ['ops'],
  ops_customers_updated: ['ops'],
  ops_production_updated: ['ops'],
  tech_support_updated: ['tech-support', 'solutions'],
  group_transfer_updated: ['group-transfers', 'users'],
  machine_bindings_updated: ['machines'],
  machine_presence_updated: ['machines'],
};

/** 事件风暴防抖：同一组查询键 1 秒内只失效一次 */
const pendingKeys = new Set<string>();
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

export function invalidateForEvent(eventName: string, payload?: any): void {
  let keys = EVENT_QUERY_MAP[eventName] ? [...EVENT_QUERY_MAP[eventName]] : [];
  if (eventName === 'data_changed' && payload) {
    const main = payload.main;
    const sideEffects = Array.isArray(payload.sideEffects) ? payload.sideEffects : [];
    const all = [main, ...sideEffects].filter(Boolean);
    for (const k of all) {
      const mapped = EVENT_QUERY_MAP[`${k}_updated`];
      if (mapped) keys.push(...mapped);
      else if (k === 'tech_support') keys.push('tech-support', 'solutions');
      else keys.push(k);
    }
    if (keys.length === 0) keys = [''];  // 未知领域：全量失效
  }
  keys.forEach(k => pendingKeys.add(k));
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    const ks = Array.from(pendingKeys);
    pendingKeys.clear();
    debounceTimer = null;
    for (const k of ks) {
      if (k === '') queryClient.invalidateQueries();
      else queryClient.invalidateQueries({ queryKey: [k] });
    }
  }, 1000);
}
