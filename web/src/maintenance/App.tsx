// 运维端根组件：初始化认证 → 登录页 / 系统分流 / 主界面
import { useEffect } from 'react';
import { Spin } from 'antd';
import { HashRouter } from 'react-router-dom';
import { useAuthStore } from '@common/stores/auth';
import { LoginScreen } from './layout/LoginScreen';
import { AppRoutes } from './router';

export function App() {
  const user = useAuthStore(s => s.user);
  const initialized = useAuthStore(s => s.initialized);
  const init = useAuthStore(s => s.init);

  useEffect(() => { init(); }, [init]);

  // 运营系统用户分流（与旧版 app.js init 行为一致）
  useEffect(() => {
    if (initialized && user && (user.system || 'maintenance') === 'operations') {
      window.location.replace('operations.html');
    }
  }, [initialized, user]);

  if (!initialized) {
    return (
      <div style={{ height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 12 }}>
        <Spin size="large" />
        <span style={{ opacity: 0.6 }}>正在连接服务器...</span>
      </div>
    );
  }

  if (!user) return <LoginScreen />;
  if ((user.system || 'maintenance') === 'operations') return null; // 正在跳转

  return (
    <HashRouter>
      <AppRoutes />
    </HashRouter>
  );
}
