// 运维端路由：对应旧版 switchTab 的全部页面
import { lazy, Suspense } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { Spin } from 'antd';
import { AppLayout, lastTab } from './layout/AppLayout';

const DashboardPage = lazy(() => import('./modules/dashboard/DashboardPage'));
const InventoryPage = lazy(() => import('./modules/inventory/InventoryPage'));
const MachinesPage = lazy(() => import('./modules/machines/MachinesPage'));
const MachineStatusPage = lazy(() => import('./modules/machine-status/MachineStatusPage'));
const MachineLinksPage = lazy(() => import('./modules/machine-links/MachineLinksPage'));
const StorageLocationsPage = lazy(() => import('./modules/storage-locations/StorageLocationsPage'));
const TransactionsPage = lazy(() => import('./modules/transactions/TransactionsPage'));
const ReportsPage = lazy(() => import('./modules/reports/ReportsPage'));
const AuditLogPage = lazy(() => import('./modules/audit/AuditLogPage'));
const SNCodesPage = lazy(() => import('./modules/sn-registry/SNCodesPage'));
const SNQRCodesPage = lazy(() => import('./modules/sn-qr/SNQRCodesPage'));
const AfterSalesPage = lazy(() => import('./modules/after-sales/AfterSalesPage'));
const TechSupportPage = lazy(() => import('./modules/tech-support/TechSupportPage'));
const EquipmentConfigPage = lazy(() => import('./modules/equipment-config/EquipmentConfigPage'));
const InventoryConfigPage = lazy(() => import('./modules/inventory-config/InventoryConfigPage'));
const StocktakePage = lazy(() => import('./modules/stocktake/StocktakePage'));
const WarehousesPage = lazy(() => import('./modules/warehouses/WarehousesPage'));
const RolesPage = lazy(() => import('./modules/roles/RolesPage'));
const InventoryAuditPage = lazy(() => import('./modules/inventory-audit/InventoryAuditPage'));
const BatchesPage = lazy(() => import('./modules/batches/BatchesPage'));
const WarehouseTransfersPage = lazy(() => import('./modules/warehouse-transfers/WarehouseTransfersPage'));
const UsersPage = lazy(() => import('./modules/users/UsersPage'));
const SettingsPage = lazy(() => import('./modules/settings/SettingsPage'));
const PopupMessagesPage = lazy(() => import('./modules/popup-messages/PopupMessagesPage'));
const ProfilePage = lazy(() => import('./modules/personal/ProfilePage'));
const NotificationsPage = lazy(() => import('./modules/personal/NotificationsPage'));
const MyActivityPage = lazy(() => import('./modules/personal/MyActivityPage'));
const HelpPage = lazy(() => import('./modules/personal/HelpPage'));

function Loading() {
  return <div style={{ padding: 60, textAlign: 'center' }}><Spin /></div>;
}

export function AppRoutes() {
  const last = lastTab();
  return (
    <Suspense fallback={<Loading />}>
      <Routes>
        <Route element={<AppLayout />}>
          <Route path="/" element={<Navigate to={last && last !== 'dashboard' ? `/${last}` : '/dashboard'} replace />} />
          <Route path="/dashboard" element={<DashboardPage />} />
          <Route path="/inventory/:type" element={<InventoryPage />} />
          <Route path="/machines" element={<MachinesPage />} />
          <Route path="/machine-status" element={<MachineStatusPage />} />
          <Route path="/machine-links" element={<MachineLinksPage />} />
          <Route path="/storage-locations" element={<StorageLocationsPage />} />
          <Route path="/transactions" element={<TransactionsPage />} />
          <Route path="/reports" element={<ReportsPage />} />
          <Route path="/audit" element={<AuditLogPage />} />
          <Route path="/sn-codes" element={<SNCodesPage />} />
          <Route path="/sn-qr-codes" element={<SNQRCodesPage />} />
          <Route path="/after-sales" element={<AfterSalesPage />} />
          <Route path="/tech-support" element={<TechSupportPage />} />
          <Route path="/equipment-config" element={<EquipmentConfigPage />} />
          <Route path="/inventory-config" element={<InventoryConfigPage />} />
          <Route path="/stocktake" element={<StocktakePage />} />
          <Route path="/warehouses" element={<WarehousesPage />} />
          <Route path="/roles" element={<RolesPage />} />
          <Route path="/inventory-audit" element={<InventoryAuditPage />} />
          <Route path="/batches" element={<BatchesPage />} />
          <Route path="/warehouse-transfers" element={<WarehouseTransfersPage />} />
          <Route path="/users" element={<UsersPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/popup-messages" element={<PopupMessagesPage />} />
          <Route path="/profile" element={<ProfilePage />} />
          <Route path="/notifications" element={<NotificationsPage />} />
          <Route path="/my-activity" element={<MyActivityPage />} />
          <Route path="/help" element={<HelpPage />} />
          <Route path="*" element={<Navigate to="/dashboard" replace />} />
        </Route>
      </Routes>
    </Suspense>
  );
}
