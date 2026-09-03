// 全局覆盖层：会话过期重新登录提示 + 服务器版本更新提示
import { useEffect, useState } from 'react';
import { Button, Modal } from 'antd';
import { useAuthStore } from '../stores/auth';

export function GlobalOverlays() {
  const logout = useAuthStore(s => s.logout);
  const [authModalOpen, setAuthModalOpen] = useState(false);
  const [newVersion, setNewVersion] = useState<string | null>(null);

  useEffect(() => {
    const onAuthError = () => {
      logout('session_expired');
      setAuthModalOpen(true);
    };
    const onVersionUpdate = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      setNewVersion(detail?.version || '');
    };
    window.addEventListener('gms_auth_error', onAuthError);
    window.addEventListener('gms_version_update', onVersionUpdate);
    return () => {
      window.removeEventListener('gms_auth_error', onAuthError);
      window.removeEventListener('gms_version_update', onVersionUpdate);
    };
  }, [logout]);

  return (
    <>
      <Modal
        title="登录状态已过期"
        open={authModalOpen}
        closable={false}
        maskClosable={false}
        footer={[
          <Button key="relogin" type="primary" onClick={() => { setAuthModalOpen(false); window.location.reload(); }}>
            重新登录
          </Button>,
        ]}
      >
        <p>您的会话已过期，请重新登录以继续使用系统。</p>
      </Modal>
      <Modal
        title="系统已更新"
        open={!!newVersion}
        closable={false}
        maskClosable={false}
        keyboard={false}
        footer={[
          <Button
            key="refresh"
            type="primary"
            onClick={() => {
              if (newVersion) localStorage.setItem('gms_version', newVersion);
              const url = new URL(window.location.href);
              url.searchParams.set('_v', newVersion || String(Date.now()));
              window.location.replace(url.toString());
            }}
          >
            立即刷新
          </Button>,
        ]}
      >
        <p>检测到新版本，为确保数据同步正常，需要刷新页面加载最新代码。</p>
        {newVersion && <p style={{ fontFamily: 'monospace', opacity: 0.7 }}>新版本号: {newVersion}</p>}
      </Modal>
    </>
  );
}
