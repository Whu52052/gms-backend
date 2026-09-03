// 运营端根组件：初始化认证 → 登录页 / 系统分流 / 主界面
// 移植 OpsApp.init：运维系统用户（非超管）踢回 index.html，超管可访问双端
import { useEffect } from 'react';
import { Spin } from 'antd';
import { HashRouter } from 'react-router-dom';
import { useAuthStore } from '@common/stores/auth';
import { LoginScreen } from '../maintenance/layout/LoginScreen';
import { AppRoutes } from './router';

export function App() {
  const user = useAuthStore(s => s.user);
  const initialized = useAuthStore(s => s.initialized);
  const init = useAuthStore(s => s.init);

  useEffect(() => { init(); }, [init]);

  // 运维系统用户分流（超管除外）
  const isMaintenanceUser = !!user && (user.system || 'maintenance') === 'maintenance' && user.role !== 'superadmin';
  useEffect(() => {
    if (initialized && isMaintenanceUser) {
      window.location.replace('index.html');
    }
  }, [initialized, isMaintenanceUser]);

  if (!initialized) {
    return (
      <div style={{ height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 12 }}>
        <Spin size="large" />
        <span style={{ opacity: 0.6 }}>正在连接服务器...</span>
      </div>
    );
  }

  if (!user) return <LoginScreen />;
  if (isMaintenanceUser) return null; // 正在跳转

  return (
    <HashRouter>
      <AppRoutes />
    </HashRouter>
  );
}
