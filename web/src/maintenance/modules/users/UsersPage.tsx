// 用户管理页（移植 js/ui/users.js）：筛选/增删改/密码查看与重置/SN删除授权
import { useMemo, useState } from 'react';
import {
  Badge, Button, Card, Flex, Form, Input, Modal, Popconfirm, Select, Space, Table, Tag, message,
} from 'antd';
import { PlusOutlined, SearchOutlined } from '@ant-design/icons';
import { useQueryClient } from '@tanstack/react-query';
import { PageContainer } from '@common/components/PageContainer';
import { useUsers } from '@common/hooks/useData';
import { useAuthStore, isAdmin, isSuperAdmin } from '@common/stores/auth';
import { formatTime } from '@common/utils/format';
import * as api from '@common/api';

// SN 删除权限存本地（移植旧版 Storage.getUsers().permissions.canDeleteSN）
const PERMS_KEY = 'gms_user_perms';
function getPerms(): Record<string, { canDeleteSN?: boolean }> {
  try { return JSON.parse(localStorage.getItem(PERMS_KEY) || '{}'); } catch { return {}; }
}
function setPerms(p: Record<string, { canDeleteSN?: boolean }>) {
  localStorage.setItem(PERMS_KEY, JSON.stringify(p));
}

const ROLE_LABEL: Record<string, string> = { superadmin: '超级管理员', admin: '管理员', user: '普通用户' };
const ROLE_COLOR: Record<string, string> = { superadmin: 'volcano', admin: 'purple', user: 'blue' };

export default function UsersPage() {
  const { data: users = [], isLoading } = useUsers();
  const currentUser = useAuthStore(s => s.user);
  const qc = useQueryClient();

  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('all');
  const [role, setRole] = useState('all');
  const [system, setSystem] = useState('all');
  const [perms, setPermsState] = useState(getPerms);

  const [addOpen, setAddOpen] = useState(false);
  const [editUser, setEditUser] = useState<any | null>(null);
  const [pwdUser, setPwdUser] = useState<any | null>(null);   // 账户安全弹窗
  const [pwdInfo, setPwdInfo] = useState<any>(null);
  const [resetUser, setResetUser] = useState<any | null>(null); // 重置密码弹窗
  const [form] = Form.useForm();
  const [editForm] = Form.useForm();
  const [resetForm] = Form.useForm();

  const meSuper = isSuperAdmin(currentUser);
  const meAdmin = currentUser && (currentUser.role === 'admin' || currentUser.role === 'superadmin');

  // 页面级权限拦截：用户管理仅管理员可用（后端 GET /api/users 亦要求管理员）
  if (!isAdmin(currentUser)) {
    return (
      <PageContainer title="👥 用户管理">
        <Card><div style={{ opacity: 0.6 }}>无权限访问</div></Card>
      </PageContainer>
    );
  }

  // 权限逻辑（移植 canDelete/canEdit/_canViewPassword）
  const canDelete = (u: any) => {
    if (!currentUser) return false;
    if (u.id === currentUser.id) return false;
    if (u.role === 'superadmin') return false;
    if (meSuper) return true;
    if (meAdmin && u.role === 'user') return true;
    return false;
  };
  const canEdit = (u: any) => {
    if (!currentUser) return false;
    if (u.id === currentUser.id) return true;
    if (meSuper) {
      if (u.system !== currentUser.system) return false;
      if (u.role === 'superadmin' && u.id !== currentUser.id) return false;
      return true;
    }
    if (meAdmin && u.role === 'user') {
      return u.parentId === currentUser.id || u.createdBy === currentUser.id;
    }
    return false;
  };
  const canViewPassword = (u: any) => {
    if (!currentUser) return false;
    if (u.id === currentUser.id) return true;
    if (currentUser.role === 'superadmin') return u.role !== 'superadmin';
    if (currentUser.role === 'admin') {
      if (u.role === 'admin' || u.role === 'superadmin') return false;
      return u.parentId === currentUser.id || u.createdBy === currentUser.id;
    }
    return false;
  };

  const filtered = useMemo(() => {
    const kw = search.trim().toLowerCase();
    return users.filter(u => {
      const uSystem = u.system || 'maintenance';
      if (status !== 'all' && (status === 'online') !== !!u.online) return false;
      if (role !== 'all' && u.role !== role) return false;
      if (system !== 'all' && uSystem !== system) return false;
      if (kw && !`${u.displayName || ''}`.toLowerCase().includes(kw) && !`${u.username || ''}`.toLowerCase().includes(kw)) return false;
      return true;
    });
  }, [users, search, status, role, system]);

  const onCount = users.filter(u => u.online).length;

  const refresh = () => qc.invalidateQueries({ queryKey: ['users'] });

  // ==================== 添加用户 ====================
  const doAdd = async () => {
    const v = await form.validateFields().catch(() => null);
    if (!v) return;
    const body: any = { username: v.username.trim(), password: v.password.trim(), role: v.role, displayName: v.displayName.trim() };
    if (meSuper && v.system) body.system = v.system;
    try {
      await api.addUser(body);
      message.success(`用户 ${body.displayName}(${body.username}) 创建成功`);
      setAddOpen(false);
      form.resetFields();
      refresh();
    } catch (e: any) {
      message.error(e?.message || '创建失败');
    }
  };

  // ==================== 修改账户 ====================
  const openEdit = (u: any) => {
    setEditUser(u);
    editForm.setFieldsValue({ username: u.username, password: '', password2: '' });
  };
  const doEdit = async () => {
    if (!editUser) return;
    const v = await editForm.validateFields().catch(() => null);
    if (!v) return;
    if (v.password && v.password !== v.password2) { message.error('两次密码不一致'); return; }
    try {
      await api.updateUser(editUser.id, { username: v.username.trim(), password: v.password || undefined });
      message.success('账户已修改');
      // 改的是自己时同步当前会话用户信息
      if (editUser.id === currentUser?.id) {
        useAuthStore.getState().setUser({ ...currentUser!, username: v.username.trim() } as any);
      }
      setEditUser(null);
      refresh();
    } catch (e: any) {
      message.error(e?.message || '修改失败');
    }
  };

  // ==================== 密码查看/重置 ====================
  const viewPassword = async (u: any) => {
    try {
      const info = await api.getUserPasswordInfo(u.id);
      if (info && info.success === false) { message.error(info.error || '获取信息失败'); return; }
      setPwdInfo(info);
      setPwdUser(u);
    } catch (e: any) {
      message.error(`获取信息失败: ${e?.message || ''}`);
    }
  };
  const doReset = async () => {
    if (!resetUser) return;
    const v = await resetForm.validateFields().catch(() => null);
    if (!v) return;
    if (v.newPassword.length < 6) { message.warning('密码至少6个字符'); return; }
    if (!/[A-Za-z]/.test(v.newPassword) || !/[0-9]/.test(v.newPassword)) { message.warning('密码需包含字母和数字'); return; }
    if (v.newPassword !== v.confirm) { message.warning('两次输入不一致'); return; }
    try {
      const res: any = await api.resetPassword(resetUser.id, v.newPassword);
      if (res && res.success === false) { message.error(res.error || '重置失败'); return; }
      message.success(`${resetUser.displayName || resetUser.username} 密码已重置`);
      setResetUser(null);
      resetForm.resetFields();
      setPwdUser(null);
    } catch (e: any) {
      message.error(e?.message || '重置失败');
    }
  };

  // ==================== 删除用户 ====================
  const doDelete = async (u: any) => {
    try {
      const res: any = await api.deleteUser(u.id);
      if (res && res.success === false) { message.error(res.message || res.error || '删除失败'); return; }
      const p = getPerms();
      delete p[u.username];
      setPerms(p); setPermsState({ ...p });
      message.success(`用户 ${u.username} 已删除`);
      refresh();
    } catch (e: any) {
      message.error(e?.message || '删除失败');
    }
  };

  // ==================== SN 删除授权 ====================
  const toggleSNDeletePerm = (u: any) => {
    if (u.role === 'superadmin') return;
    const p = getPerms();
    const cur = p[u.username] || {};
    p[u.username] = { ...cur, canDeleteSN: !cur.canDeleteSN };
    setPerms(p);
    setPermsState({ ...p });
    message.success(`${u.username} SN码删除权限已${p[u.username].canDeleteSN ? '授予' : '撤销'}`);
  };

  const columns: any[] = [
    {
      title: '在线', dataIndex: 'online', width: 60,
      render: (v: boolean) => <Badge status={v ? 'success' : 'default'} text={v ? '在线' : '离线'} />,
    },
    {
      title: '用户名', dataIndex: 'displayName',
      render: (_: any, u: any) => (
        <Space size={6}>
          <strong>{u.displayName || u.username}</strong>
          {currentUser && u.id === currentUser.id && <Tag color="blue">当前</Tag>}
        </Space>
      ),
    },
    {
      title: '角色', dataIndex: 'role', width: 110,
      render: (r: string) => <Tag color={ROLE_COLOR[r] || 'default'}>{ROLE_LABEL[r] || r}</Tag>,
    },
    {
      title: '权限', key: 'perm', width: 110,
      render: (_: any, u: any) => {
        const canDelSN = !!perms[u.username]?.canDeleteSN;
        if (meSuper && u.role !== 'superadmin') {
          return (
            <Button size="small" type={canDelSN ? 'primary' : 'default'}
              onClick={() => toggleSNDeletePerm(u)}
              title={canDelSN ? '点击取消SN码删除权限' : '点击授予SN码删除权限'}>
              {canDelSN ? '已授权' : '未授权'}
            </Button>
          );
        }
        return canDelSN ? <Tag color="blue">SN删除</Tag> : <span style={{ opacity: 0.4 }}>-</span>;
      },
    },
    {
      title: '所属系统', dataIndex: 'system', width: 100,
      render: (s: string) => (s === 'operations' ? '运营系统' : '运维系统'),
    },
    {
      title: '创建时间', dataIndex: 'createdAt', width: 150,
      render: (t: string) => formatTime(t),
    },
    {
      title: '操作', key: 'actions', width: 190,
      render: (_: any, u: any) => (
        <Space size={4}>
          {canEdit(u) && <Button size="small" onClick={() => openEdit(u)}>修改</Button>}
          {canViewPassword(u) && <Button size="small" type="link" onClick={() => viewPassword(u)}>密码</Button>}
          {canDelete(u) ? (
            <Popconfirm title="删除用户" description={`确定删除用户 "${u.username}"？此操作不可恢复。`}
              onConfirm={() => doDelete(u)} okText="删除" cancelText="取消" okButtonProps={{ danger: true }}>
              <Button size="small" danger>清除</Button>
            </Popconfirm>
          ) : (!canEdit(u) && <span style={{ fontSize: 12, opacity: 0.45 }}>受保护</span>)}
        </Space>
      ),
    },
  ];

  return (
    <PageContainer
      title="👥 用户管理"
      subtitle={`共 ${users.length} 人，在线 ${onCount} 人`}
      extra={
        <Flex wrap gap={8} align="center">
          <Input prefix={<SearchOutlined />} placeholder="搜索用户名/账号..." allowClear
            style={{ width: 180 }} value={search} onChange={e => setSearch(e.target.value)} />
          <Select style={{ width: 130 }} value={status} onChange={setStatus} options={[
            { value: 'all', label: `全部状态 (${users.length})` },
            { value: 'online', label: `在线 (${onCount})` },
            { value: 'offline', label: `离线 (${users.length - onCount})` },
          ]} />
          <Select style={{ width: 130 }} value={role} onChange={setRole} options={[
            { value: 'all', label: '全部角色' },
            { value: 'superadmin', label: '超级管理员' },
            { value: 'admin', label: '管理员' },
            { value: 'user', label: '普通用户' },
          ]} />
          <Select style={{ width: 130 }} value={system} onChange={setSystem} options={[
            { value: 'all', label: '全部系统' },
            { value: 'maintenance', label: '运维系统' },
            { value: 'operations', label: '运营系统' },
          ]} />
          <Button onClick={() => { setSearch(''); setStatus('all'); setRole('all'); setSystem('all'); }}>重置</Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setAddOpen(true)}>添加用户</Button>
        </Flex>
      }
    >
      <Table rowKey="id" size="middle" loading={isLoading} columns={columns} dataSource={filtered}
        pagination={{ pageSize: 20, showTotal: t => `共 ${t} 个用户` }} />

      {/* 添加用户 */}
      <Modal title="添加用户" open={addOpen} onCancel={() => setAddOpen(false)} onOk={doAdd} okText="创建" destroyOnClose>
        <Form form={form} layout="vertical" initialValues={{ role: 'user' }}>
          <Form.Item name="displayName" label="中文名" rules={[{ required: true, message: '请输入中文名' }]}>
            <Input placeholder="输入中文姓名（用于显示）" />
          </Form.Item>
          <Form.Item name="username" label="用户名" rules={[
            { required: true, message: '请输入用户名' },
            { min: 2, message: '用户名至少2个字符' },
          ]}>
            <Input placeholder="输入登录用户名" />
          </Form.Item>
          <Form.Item name="password" label="密码" rules={[
            { required: true, message: '请输入密码' },
            { min: 4, message: '密码至少4个字符' },
          ]}>
            <Input.Password placeholder="输入密码" />
          </Form.Item>
          <Form.Item name="role" label="角色" extra={meSuper ? '超级管理员可创建管理员或普通用户' : '管理员只能创建普通用户'}>
            <Select options={[
              { value: 'user', label: '普通用户' },
              ...(meSuper ? [{ value: 'admin', label: '管理员' }] : []),
            ]} />
          </Form.Item>
          {meSuper && (
            <Form.Item name="system" label="所属系统" initialValue="maintenance">
              <Select options={[
                { value: 'maintenance', label: '运维系统' },
                { value: 'operations', label: '运营系统' },
              ]} />
            </Form.Item>
          )}
        </Form>
      </Modal>

      {/* 修改账户 */}
      <Modal title="修改账户" open={!!editUser} onCancel={() => setEditUser(null)} onOk={doEdit} okText="保存" destroyOnClose>
        <Form form={editForm} layout="vertical">
          <Form.Item name="username" label="用户名" rules={[{ required: true, message: '用户名不能为空' }]}>
            <Input />
          </Form.Item>
          <Form.Item name="password" label="新密码">
            <Input.Password placeholder="留空则不修改密码" />
          </Form.Item>
          <Form.Item name="password2" label="确认新密码">
            <Input.Password placeholder="再次输入新密码" />
          </Form.Item>
        </Form>
      </Modal>

      {/* 账户安全（密码状态） */}
      <Modal title={`账户安全 — ${pwdUser?.displayName || pwdUser?.username || ''}`} open={!!pwdUser}
        onCancel={() => setPwdUser(null)}
        footer={[
          <Button key="close" onClick={() => setPwdUser(null)}>关闭</Button>,
          <Button key="reset" type="primary" onClick={() => { setResetUser(pwdUser); }}>重置密码</Button>,
        ]} destroyOnClose>
        <div style={{ textAlign: 'center', padding: '8px 0' }}>
          <div style={{ marginBottom: 4 }}>用户：{pwdInfo?.username || pwdUser?.displayName}</div>
          <div style={{ opacity: 0.6, marginBottom: 16 }}>账号：{pwdInfo?.username || pwdUser?.username}</div>
          <div style={{ border: '2px dashed #cbd5e1', borderRadius: 12, padding: 20 }}>
            {pwdInfo?.hasPassword
              ? <div style={{ color: '#10b981', fontSize: 18, marginBottom: 8 }}>密码已设置</div>
              : <div style={{ color: '#f59e0b', fontSize: 18, marginBottom: 8 }}>未设置密码</div>}
            <div style={{ fontSize: 12, opacity: 0.6 }}>为安全起见，系统不再显示明文密码。</div>
          </div>
        </div>
      </Modal>

      {/* 重置密码 */}
      <Modal title={`重置密码 — ${resetUser?.displayName || resetUser?.username || ''}`} open={!!resetUser}
        onCancel={() => setResetUser(null)} onOk={doReset} okText="确认重置" destroyOnClose>
        <Form form={resetForm} layout="vertical">
          <Form.Item name="newPassword" label="新密码" rules={[{ required: true, message: '请输入新密码' }]}>
            <Input.Password placeholder="至少6位，含字母和数字" />
          </Form.Item>
          <Form.Item name="confirm" label="确认新密码" rules={[{ required: true, message: '请再次输入新密码' }]}>
            <Input.Password placeholder="再次输入新密码" />
          </Form.Item>
        </Form>
      </Modal>
    </PageContainer>
  );
}
