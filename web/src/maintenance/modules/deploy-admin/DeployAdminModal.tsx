// 部署管理面板（移植 js/ui/deploy-admin.js）：
// 密码保护（仅 Yunwei），服务器状态/列表、数据库配置、次服务器部署、清除、实时日志
import { useEffect, useRef, useState } from 'react';
import {
  Alert, Button, Card, Flex, Form, Input, Modal, Popconfirm, Space, Steps, Tabs, Tag, message,
} from 'antd';
import { post } from '@common/api/http';
import { useAuthStore, isAdmin } from '@common/stores/auth';

const SERVERS_KEY = 'gms_deploy_servers';
const DB_KEY = 'gms_deploy_db';

interface DeployServer {
  id: string; name: string; ip: string; port?: number; role: string;
  sshUser?: string; password?: string;
}

function getServers(): DeployServer[] {
  try { return JSON.parse(localStorage.getItem(SERVERS_KEY) || '[]'); } catch { return []; }
}
function saveServers(list: DeployServer[]) {
  localStorage.setItem(SERVERS_KEY, JSON.stringify(list));
}
function getDbConfig(): any {
  try { return JSON.parse(localStorage.getItem(DB_KEY) || '{}'); } catch { return {}; }
}

const NUKE_STEPS = [
  { label: '停止 PM2 进程' },
  { label: '移除开机自启' },
  { label: '删除应用目录 ~/glove-management' },
  { label: '清理临时文件' },
  { label: '终止残留 Node 进程' },
];

type LogType = 'success' | 'error' | 'warning' | 'info';
const LOG_COLOR: Record<LogType, string> = { success: '#10b981', error: '#ef4444', warning: '#f59e0b', info: '#94a3b8' };

export function DeployAdminModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const user = useAuthStore(s => s.user);
  const [verified, setVerified] = useState(false);
  const [password, setPassword] = useState('');
  const [pwdError, setPwdError] = useState('');
  const [tab, setTab] = useState('servers');

  const [primaryStatus, setPrimaryStatus] = useState<{ online: boolean; info: string; db?: boolean; users?: number }>({ online: false, info: '检测中...' });
  const [secondaryStatus, setSecondaryStatus] = useState<{ online: boolean | null; info: string }>({ online: null, info: '未配置' });
  const [servers, setServersState] = useState<DeployServer[]>(getServers);
  const [logs, setLogs] = useState<{ time: string; msg: string; type: LogType }[]>([]);
  const logRef = useRef<HTMLDivElement>(null);

  // 清除进度
  const [nukeTarget, setNukeTarget] = useState<string | null>(null);
  const [nukeSteps, setNukeSteps] = useState<string[]>(['wait', 'wait', 'wait', 'wait', 'wait']);
  const [nukeDone, setNukeDone] = useState(false);
  // 快速清除表单
  const [quickNukeOpen, setQuickNukeOpen] = useState(false);
  const [quickForm] = Form.useForm();
  // 添加服务器表单
  const [addOpen, setAddOpen] = useState(false);
  const [addForm] = Form.useForm();
  // 部署表单
  const [deployForm] = Form.useForm();
  const [deploying, setDeploying] = useState(false);
  const [dbForm] = Form.useForm();

  const deployLog = (msg: string, type: LogType = 'info') => {
    setLogs(prev => [...prev.slice(-300), { time: new Date().toLocaleTimeString('zh-CN'), msg, type }]);
  };
  useEffect(() => { if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight; }, [logs]);

  const updateServers = (list: DeployServer[]) => { saveServers(list); setServersState([...list]); };

  // ==================== 密码验证（仅 Yunwei） ====================
  const verifyPassword = () => {
    if (!user || user.username !== 'Yunwei') {
      setPwdError('此功能仅限Yunwei使用');
      setTimeout(() => setPwdError(''), 3000);
      return;
    }
    const adminPassword = localStorage.getItem('gms_deploy_admin_password') || 'yunwei2024';
    if (password === adminPassword) {
      setVerified(true);
      checkServerStatus();
    } else {
      setPwdError('密码错误');
      setTimeout(() => setPwdError(''), 3000);
    }
  };

  // 关闭时重置状态
  useEffect(() => {
    if (!open) { setVerified(false); setPassword(''); setPwdError(''); setTab('servers'); }
  }, [open]);

  // ==================== 服务器状态 ====================
  const checkServerStatus = async () => {
    try {
      const res = await fetch('/api/status');
      if (res.ok) {
        const data = await res.json();
        setPrimaryStatus({
          online: true,
          info: `角色: ${data.serverRole || 'primary'} | 版本: ${data.version}`,
          db: !!data.dbConnected,
          users: data.onlineUsers,
        });
      } else {
        setPrimaryStatus({ online: false, info: '无法获取状态' });
      }
    } catch {
      setPrimaryStatus({ online: false, info: '离线' });
    }
    const list = getServers();
    const secondary = list.find(s => s.role === 'secondary');
    if (secondary) {
      try {
        const res = await fetch(`/api/proxy-status?ip=${secondary.ip}&port=${secondary.port || 8765}`);
        if (res.ok) {
          const data = await res.json();
          setSecondaryStatus({
            online: true,
            info: data.serverRole ? `角色: ${data.serverRole} | 版本: ${data.version}` : `版本: ${data.version || '未知'}`,
          });
        } else {
          setSecondaryStatus({ online: false, info: '无法连接' });
        }
      } catch {
        setSecondaryStatus({ online: false, info: '无法连接' });
      }
    } else {
      setSecondaryStatus({ online: null, info: '请添加次服务器' });
    }
  };

  // ==================== 服务器列表操作 ====================
  const addServer = async () => {
    const v = await addForm.validateFields().catch(() => null);
    if (!v) return;
    updateServers([...getServers(), {
      id: Date.now().toString(), name: v.name.trim(), ip: v.ip.trim(), port: 8765, role: v.role,
    }]);
    setAddOpen(false);
    addForm.resetFields();
    checkServerStatus();
  };

  const removeFromList = (id: string) => {
    updateServers(getServers().filter(s => s.id !== id));
    checkServerStatus();
  };

  const testServer = async (ip: string) => {
    deployLog(`测试连接 ${ip}...`);
    try {
      const res = await fetch(`http://${ip}:8765/api/status`, { signal: AbortSignal.timeout(5000) });
      if (res.ok) {
        const data = await res.json();
        deployLog(`✅ ${ip} 在线 | 角色: ${data.serverRole} | 用户: ${data.onlineUsers}`, 'success');
      } else {
        deployLog(`❌ ${ip} 返回错误: ${res.status}`, 'error');
      }
    } catch (e: any) {
      deployLog(`❌ ${ip} 连接失败: ${e?.message || ''}`, 'error');
    }
  };

  // ==================== 清除服务器（带进度步骤） ====================
  const watchNukeLogs = (taskId: string) => {
    const es = new EventSource(`/api/deploy/logs?id=${taskId}`);
    const applyMsg = (m: string) => {
      if (m.includes('PM2 进程已终止') || m.includes('PM2 停止')) setNukeSteps(s => { const n = [...s]; n[0] = 'done'; return n; });
      if (m.includes('开机自启已移除')) setNukeSteps(s => { const n = [...s]; n[1] = 'done'; return n; });
      if (m.includes('应用目录已删除')) setNukeSteps(s => { const n = [...s]; n[2] = 'done'; return n; });
      if (m.includes('临时文件已清理')) setNukeSteps(s => { const n = [...s]; n[3] = 'done'; return n; });
      if (m.includes('残留进程已终止')) setNukeSteps(s => { const n = [...s]; n[4] = 'done'; return n; });
      if (m.includes('清除完成') || m.includes('被核打击')) {
        setNukeSteps(['done', 'done', 'done', 'done', 'done']);
        setNukeDone(true);
        es.close();
      }
    };
    es.addEventListener('log', (e: MessageEvent) => {
      try { applyMsg(JSON.parse(e.data).message || ''); } catch { /* ignore */ }
    });
    es.addEventListener('connected', (e: MessageEvent) => {
      try {
        const d = JSON.parse((e as MessageEvent).data);
        (d.logs || []).forEach((l: any) => applyMsg(l.message || ''));
      } catch { /* ignore */ }
    });
    es.onerror = () => es.close();
  };

  const startNuke = (targetIP: string, sshUser: string, sshPassword: string, label: string) => {
    setNukeTarget(`${label} — ${sshUser}@${targetIP}`);
    setNukeSteps(['wait', 'wait', 'wait', 'wait', 'wait']);
    setNukeDone(false);
    (async () => {
      try {
        const res = await fetch('/api/deploy/nuke', {
          method: 'POST', credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ targetIP, sshUser, password: sshPassword, name: label }),
        });
        const data = await res.json();
        if (!data.success) {
          message.error(`清除请求失败: ${data.error || res.status}`);
          setNukeTarget(null);
          return;
        }
        watchNukeLogs(data.taskId);
      } catch (e: any) {
        message.error(`网络错误: ${e?.message || ''}`);
        setNukeTarget(null);
      }
    })();
  };

  const nukeServer = (s: DeployServer) => {
    const sshUser = s.sshUser || 'we';
    const pwd = s.password || '';
    if (!pwd) {
      Modal.confirm({
        title: 'SSH 密码',
        content: <Input.Password id="nuke-pwd-input" placeholder="we用户密码" />,
        okText: '开始清除', okButtonProps: { danger: true },
        onOk: () => {
          const el = document.getElementById('nuke-pwd-input') as HTMLInputElement | null;
          const p = el?.value || '';
          if (!p) return Promise.reject(new Error('请输入密码'));
          const list = getServers();
          const target = list.find(x => x.id === s.id);
          if (target) { target.password = p; saveServers(list); }
          startNuke(s.ip, sshUser, p, s.name);
          return Promise.resolve();
        },
      });
      return;
    }
    startNuke(s.ip, sshUser, pwd, s.name);
  };

  // ==================== 部署次服务器 ====================
  const connectDeployLogs = (taskId: string) => {
    const es = new EventSource(`/api/deploy/logs?id=${taskId}`);
    es.addEventListener('connected', (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data);
        (data.logs || []).forEach((log: any) => deployLog(log.message || '', log.type || 'info'));
      } catch { /* ignore */ }
      deployLog('✅ 实时日志已连接', 'success');
    });
    es.addEventListener('log', (e: MessageEvent) => {
      try {
        const log = JSON.parse(e.data);
        deployLog(log.message || '', log.type || 'info');
      } catch { /* ignore */ }
    });
    es.addEventListener('done', (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data);
        if (data.success) deployLog('🎉 部署任务完成！', 'success');
        else deployLog('❌ 部署任务失败', 'error');
      } catch { /* ignore */ }
      es.close();
      setDeploying(false);
    });
    es.onerror = () => { es.close(); setDeploying(false); };
  };

  const deployServer = async () => {
    const v = await deployForm.validateFields().catch(() => null);
    if (!v) return;
    const dbConfig = getDbConfig();
    setDeploying(true);
    setTab('logs');
    deployLog(`🚀 启动部署任务: ${v.targetIP}`);
    try {
      const startData: any = await post('/api/deploy/start', {
        targetIP: v.targetIP,
        sshUser: v.sshUser || 'we',
        password: v.sshPassword,
        dbHost: v.dbIP || '10.5.50.30',
        dbPort: 3306,
        dbUser: dbConfig.user || 'gms_user',
        dbPassword: dbConfig.password || 'gms_password_2024',
        dbName: dbConfig.database || 'gms',
        redisHost: v.redisIP || '10.5.50.30',
        role: 'secondary',
      }, 60000);
      if (!startData?.success) throw new Error(startData?.error || '启动部署失败');
      deployLog(`✅ 部署任务已创建: ${startData.taskId}`, 'success');
      connectDeployLogs(startData.taskId);
      // 保存服务器配置
      const list = getServers();
      const idx = list.findIndex(s => s.ip === v.targetIP);
      const cfg: DeployServer = { id: idx >= 0 ? list[idx].id : Date.now().toString(), name: '次服务器', ip: v.targetIP, port: 8765, role: 'secondary' };
      if (idx >= 0) list[idx] = cfg; else list.push(cfg);
      saveServers(list);
      setServersState([...list]);
      checkServerStatus();
    } catch (e: any) {
      deployLog(`❌ 部署失败: ${e?.message || ''}`, 'error');
      setDeploying(false);
    }
  };

  // ==================== 数据库配置 ====================
  const saveDbConfig = () => {
    const v = dbForm.getFieldsValue();
    localStorage.setItem(DB_KEY, JSON.stringify({
      host: v.host || '', port: v.port || '3306', database: v.database || 'gms',
      user: v.user || '', password: v.password || '', redis: v.redis || '',
    }));
    message.success('数据库配置已保存到本地');
    deployLog('💾 数据库配置已保存', 'success');
  };

  const canAccess = user && (user.username === 'Yunwei' || isAdmin(user));

  return (
    <>
      <Modal title="🚀 部署管理" open={open} onCancel={onClose} footer={null} width={900} destroyOnClose>
        {!verified ? (
          <div style={{ textAlign: 'center', padding: '40px 0' }}>
            {!canAccess && <Alert type="warning" message="仅管理员可用此功能" style={{ marginBottom: 16 }} />}
            <div style={{ marginBottom: 12, opacity: 0.7 }}>此面板受密码保护，仅限运维管理员使用</div>
            <Flex gap={8} justify="center">
              <Input.Password placeholder="部署管理密码" style={{ width: 240 }} value={password}
                onChange={e => setPassword(e.target.value)} onPressEnter={verifyPassword} />
              <Button type="primary" onClick={verifyPassword}>验证</Button>
            </Flex>
            {pwdError && <div style={{ color: '#ef4444', marginTop: 12 }}>{pwdError}</div>}
          </div>
        ) : (
          <Tabs activeKey={tab} onChange={setTab} items={[
            {
              key: 'servers', label: '服务器',
              children: (
                <div>
                  <Flex gap={12} style={{ marginBottom: 16 }}>
                    <Card size="small" style={{ flex: 1 }}>
                      <Flex justify="space-between" align="center">
                        <div>
                          <strong>主服务器</strong>
                          <div style={{ fontSize: 12, opacity: 0.6 }}>{primaryStatus.info}</div>
                        </div>
                        <Tag color={primaryStatus.online ? 'green' : 'red'}>{primaryStatus.online ? '在线' : '离线'}</Tag>
                      </Flex>
                      {primaryStatus.online && (
                        <div style={{ fontSize: 12, marginTop: 8, opacity: 0.7 }}>
                          数据库: {primaryStatus.db ? '已连接' : '断开'} | 在线用户: {primaryStatus.users ?? 0}
                        </div>
                      )}
                    </Card>
                    <Card size="small" style={{ flex: 1 }}>
                      <Flex justify="space-between" align="center">
                        <div>
                          <strong>次服务器</strong>
                          <div style={{ fontSize: 12, opacity: 0.6 }}>{secondaryStatus.info}</div>
                        </div>
                        <Tag color={secondaryStatus.online === true ? 'green' : secondaryStatus.online === false ? 'red' : 'orange'}>
                          {secondaryStatus.online === true ? '在线' : secondaryStatus.online === false ? '离线' : '未配置'}
                        </Tag>
                      </Flex>
                    </Card>
                    <Button onClick={checkServerStatus}>刷新状态</Button>
                  </Flex>
                  <Flex gap={8} style={{ marginBottom: 12 }}>
                    <Button type="primary" onClick={() => setAddOpen(true)}>+ 添加服务器</Button>
                    <Button danger onClick={() => { quickForm.setFieldsValue({ user: 'we' }); setQuickNukeOpen(true); }}>⚡ 快速清除服务器</Button>
                  </Flex>
                  {servers.length === 0 ? (
                    <div style={{ opacity: 0.5, padding: 16 }}>暂无服务器，点击上方添加</div>
                  ) : servers.map(s => (
                    <Flex key={s.id} justify="space-between" align="center" style={{
                      padding: 12, borderRadius: 8, marginBottom: 8, background: 'rgba(128,128,128,.06)',
                    }}>
                      <div>
                        <strong>{s.name}</strong>
                        <div style={{ fontSize: 12, opacity: 0.6 }}>{s.ip}:{s.port} | 角色: {s.role}</div>
                      </div>
                      <Space>
                        <Button size="small" onClick={() => testServer(s.ip)}>测试</Button>
                        <Button size="small" onClick={() => { setDeploying(false); deployForm.setFieldsValue({ targetIP: s.ip }); setTab('deploy'); }}>部署</Button>
                        <Popconfirm title="彻底清除该服务器？" description="将停止服务并删除应用目录，不可恢复！"
                          onConfirm={() => nukeServer(s)} okText="清除" cancelText="取消" okButtonProps={{ danger: true }}>
                          <Button size="small" danger>清除</Button>
                        </Popconfirm>
                        <Button size="small" type="text" onClick={() => removeFromList(s.id)}>移除</Button>
                      </Space>
                    </Flex>
                  ))}
                </div>
              ),
            },
            {
              key: 'database', label: '数据库',
              children: (
                <Form form={dbForm} layout="vertical" style={{ maxWidth: 420 }}
                  initialValues={{ port: '3306', database: 'gms', ...getDbConfig() }}>
                  <Form.Item name="host" label="数据库主机"><Input placeholder="10.5.50.30" /></Form.Item>
                  <Form.Item name="port" label="端口"><Input /></Form.Item>
                  <Form.Item name="database" label="数据库名"><Input /></Form.Item>
                  <Form.Item name="user" label="用户名"><Input /></Form.Item>
                  <Form.Item name="password" label="密码"><Input.Password /></Form.Item>
                  <Form.Item name="redis" label="Redis 主机"><Input placeholder="10.5.50.30" /></Form.Item>
                  <Button type="primary" onClick={saveDbConfig}>保存配置</Button>
                </Form>
              ),
            },
            {
              key: 'deploy', label: '部署',
              children: (
                <Form form={deployForm} layout="vertical" style={{ maxWidth: 420 }}>
                  <Form.Item name="targetIP" label="目标服务器 IP" rules={[{ required: true, message: '请填写服务器 IP' }]}>
                    <Input placeholder="10.5.50.33" />
                  </Form.Item>
                  <Form.Item name="sshUser" label="SSH 用户" initialValue="we"><Input /></Form.Item>
                  <Form.Item name="sshPassword" label="SSH 密码" rules={[{ required: true, message: '请填写SSH密码' }]}>
                    <Input.Password />
                  </Form.Item>
                  <Form.Item name="dbIP" label="主数据库 IP" initialValue="10.5.50.30"><Input /></Form.Item>
                  <Form.Item name="redisIP" label="Redis IP" initialValue="10.5.50.30"><Input /></Form.Item>
                  <Button type="primary" loading={deploying} onClick={deployServer}>🚀 开始部署次服务器</Button>
                </Form>
              ),
            },
            {
              key: 'logs', label: '日志',
              children: (
                <div ref={logRef} style={{
                  height: 360, overflowY: 'auto', background: '#0f172a', borderRadius: 8,
                  padding: 12, fontFamily: 'monospace', fontSize: 12,
                }}>
                  {logs.length === 0 && <div style={{ color: '#64748b' }}>暂无日志</div>}
                  {logs.map((l, i) => (
                    <div key={i} style={{ color: LOG_COLOR[l.type] }}>
                      [{l.time}] {l.msg}
                    </div>
                  ))}
                </div>
              ),
            },
          ]} />
        )}
      </Modal>

      {/* 添加服务器 */}
      <Modal title="添加服务器" open={addOpen} onCancel={() => setAddOpen(false)} onOk={addServer} okText="添加" destroyOnClose>
        <Form form={addForm} layout="vertical" initialValues={{ role: 'secondary' }}>
          <Form.Item name="name" label="服务器名称" rules={[{ required: true, message: '请输入名称' }]}><Input /></Form.Item>
          <Form.Item name="ip" label="服务器 IP" rules={[{ required: true, message: '请输入 IP' }]}><Input placeholder="10.5.50.33" /></Form.Item>
          <Form.Item name="role" label="角色">
            <select style={{ width: '100%', padding: 8, borderRadius: 6 }}>
              <option value="secondary">次服务器</option>
              <option value="primary">主服务器</option>
            </select>
          </Form.Item>
        </Form>
      </Modal>

      {/* 快速清除 */}
      <Modal title="⚡ 快速清除服务器" open={quickNukeOpen} onCancel={() => setQuickNukeOpen(false)}
        okText="开始清除" okButtonProps={{ danger: true }}
        onOk={async () => {
          const v = await quickForm.validateFields().catch(() => null);
          if (!v) return;
          setQuickNukeOpen(false);
          startNuke(v.ip.trim(), (v.user || 'we').trim(), v.pass, v.ip.trim());
        }} destroyOnClose>
        <Form form={quickForm} layout="vertical" initialValues={{ user: 'we' }}>
          <Form.Item name="ip" label="目标 IP" rules={[{ required: true, message: '请输入目标 IP' }]}>
            <Input placeholder="10.5.50.33" />
          </Form.Item>
          <Form.Item name="user" label="SSH 用户"><Input /></Form.Item>
          <Form.Item name="pass" label="SSH 密码" rules={[{ required: true, message: '请输入SSH密码' }]}>
            <Input.Password />
          </Form.Item>
        </Form>
      </Modal>

      {/* 清除进度 */}
      <Modal title="🔥 彻底清除服务器" open={!!nukeTarget} closable={nukeDone}
        onCancel={() => { if (nukeDone) setNukeTarget(null); }}
        footer={nukeDone ? <Button onClick={() => setNukeTarget(null)}>关闭</Button> : null}>
        <div style={{ opacity: 0.6, marginBottom: 16, fontSize: 13 }}>{nukeTarget}</div>
        <Steps direction="vertical" size="small"
          current={nukeSteps.indexOf('done') === -1 ? 0 : nukeSteps.filter(s => s === 'done').length}
          items={NUKE_STEPS.map((s, i) => ({
            title: s.label,
            status: nukeSteps[i] === 'done' ? 'finish' : nukeSteps[i] === 'running' ? 'process' : 'wait',
          }))} />
      </Modal>
    </>
  );
}
