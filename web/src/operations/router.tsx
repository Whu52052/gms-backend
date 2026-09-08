// 运营端路由（对应旧版 operations.html 侧边栏各 tab）
// 弹窗句子管理直接复用运维端实现（行为一致）
import { lazy, Suspense } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { Spin } from 'antd';
import { OpsLayout } from './layout/OpsLayout';

const PersonalAnalysisPage = lazy(() => import('./modules/dashboard/PersonalAnalysisPage'));
const TaskListPage = lazy(() => import('./modules/tasks/TaskListPage'));
const DataAnalysisPage = lazy(() => import('./modules/analysis/DataAnalysisPage'));
const TeamMembersPage = lazy(() => import('./modules/team/TeamMembersPage'));
const TaskProgressPage = lazy(() => import('./modules/task-progress/TaskProgressPage'));
const RequirementsPage = lazy(() => import('./modules/requirements/RequirementsPage'));
const TechSupportSubmitPage = lazy(() => import('./modules/tech-support/TechSupportSubmitPage'));
const TechSupportMyPage = lazy(() => import('./modules/tech-support/TechSupportMyPage'));
const OpsUsersPage = lazy(() => import('./modules/users/OpsUsersPage'));
const SOPPage = lazy(() => import('./modules/sop/SOPPage'));

// 复用运维端页面
const PopupMessagesPage = lazy(() => import('../maintenance/modules/popup-messages/PopupMessagesPage'));
const MachineStatusPage = lazy(() => import('../maintenance/modules/machine-status/MachineStatusPage'));

function Fallback() {
  return (
    <div style={{ height: '50vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <Spin />
    </div>
  );
}

export function AppRoutes() {
  return (
    <Suspense fallback={<Fallback />}>
      <Routes>
        <Route element={<OpsLayout />}>
          <Route index element={<PersonalAnalysisPage />} />
          <Route path="tasks" element={<TaskListPage />} />
          <Route path="analysis" element={<DataAnalysisPage />} />
          <Route path="team" element={<TeamMembersPage />} />
          <Route path="task-progress" element={<TaskProgressPage />} />
          <Route path="requirements" element={<RequirementsPage />} />
          <Route path="tech-support/submit" element={<TechSupportSubmitPage />} />
          <Route path="tech-support/my" element={<TechSupportMyPage />} />
          <Route path="users" element={<OpsUsersPage />} />
          <Route path="popup-messages" element={<PopupMessagesPage />} />
          <Route path="machine-status" element={<MachineStatusPage />} />
          <Route path="sop" element={<SOPPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </Suspense>
  );
}
