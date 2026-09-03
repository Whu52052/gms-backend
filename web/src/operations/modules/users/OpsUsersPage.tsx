// 账户管理（移植 OpsApp.renderUserManagement，运营端精简版）：
// 仅运营系统管理员可见；创建运营账户（中文名+用户名+密码）、晋升/降级、重置密码、删除
import { useState } from 'react';
import { App as AntApp, Button, Card, Form, Input, Modal, Popconfirm, Select, Table, Tag } from 'antd';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { PageContainer } from '@common/components/PageContainer';
import { useAuthStore, isAdmin, isSuperAdmin } from '@common/stores/auth';
import * as api from '@common/api';

const ROLE_LABEL: Record<string, string> = { superadmin: '超级管理员', admin: '管理员', user: '普通用户' };
const SYS_LABEL: Record<string, string> = { maintenance: '运维', operations: '运营' };

export default function OpsUsersPage() {
  const user = useAuthStore(s => s.user);
  const { message } = AntApp.useApp();
  const queryClient = useQueryClient();
  const [statusFilter, setStatusFilter] = useState<'all' | 'online' | 'offline'>('all');
  const [addOpen, setAddOpen] = useState(false);
  const [addForm] = Form.useForm();
  const [addLoading, setAddLoading] = useState(false);
  const [resetTarget, setResetTarget] = useState<any>(null);
  const [resetForm] = Form.useForm();

  const usersQuery = useQuery({ queryKey: ['users'], queryFn: () => api.getUsers().catch(() => [] as any[]), enabled: isAdmin(user) });

  if (!isAdmin(user)) {
    return (
      <PageContainer title="👤 账户管理">
        <Card><div style={{ opacity: 0.6 }}>无权限访问</div></Card>
      </PageContainer>
    );
  }

  const users = (usersQuery.data || []) as any[];
  const isSuper = isSuperAdmin(user);
  const onlineCount = users.filter(u => u.online).length;
  const offlineCount = users.length - onlineCount;

  const filtered = users.filter(u =>
    statusFilter === 'all' ? true : statusFilter === 'online' ? u.online : !u.online);

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['users'] });

  const addUser = async () => {
    const v = await addForm.validateFields().catch(() => null);
    if (!v) return;
    if (v.password.length < 4) { message.warning('密码至少4个字符'); return; }
    setAddLoading(true);
    try {
      const r: any = await api.addUser({
        username: v.username.trim(), password: v.password, role: 'user', system: 'operations',
        displayName: v.displayName.trim(),
      });
      if (r?.success === false) { message.error(r?.error || r?.message || '创建失败'); return; }
      message.success(`${v.displayName.trim()} 账户创建成功`);
      setAddOpen(false);
      addForm.resetFields();
      refresh();
    } catch (e: any) {
      message.error(e?.message || '创建失败');
    } finally {
      setAddLoading(false);
    }
  };

  const doPromote = async (u: any) => {
    const action = u.role === 'admin' ? '降级为普通用户' : '晋升为管理员';
    Modal.confirm({
      title: `确认将 ${u.username} ${action}？`,
      onOk: async () => {
        try {
          const r: any = await api.promoteUser(u.id);
          if (r?.success === false) { message.error(r?.error || r?.message || '操作失败'); return; }
          message.success(r?.message || '操作成功');
          refresh();
        } catch (e: any) { message.error(e?.message || '操作失败'); }
      },
    });
  };

  const doDelete = async (u: any) => {
    try {
      const r: any = await api.deleteUser(u.id);
      if (r?.success === false) { message.error(r?.error || r?.message || '删除失败'); return; }
      message.success('用户已删除');
      refresh();
    } catch (e: any) { message.error(e?.message || '删除失败'); }
  };

  const doReset = async () => {
    const v = await resetForm.validateFields().catch(() => null);
    if (!v) return;
    if (v.newPassword !== v.confirm) { message.warning('两次输入的新密码不一致'); return; }
    if (v.newPassword.length < 4) { message.warning('新密码至少4个字符'); return; }
    try {
      const r: any = await api.resetPassword(resetTarget.id, v.newPassword);
      if (r?.success === false) { message.error(r?.error || r?.message || '重置失败'); return; }
      message.success(`${resetTarget.displayName || resetTarget.username} 的密码已重置`);
      setResetTarget(null);
      resetForm.resetFields();
    } catch (e: any) { message.error(e?.message || '重置失败'); }
  };

  return (
    <PageContainer
      title="👤 账户管理"
      extra={
        <>
          <Select value={statusFilter} onChange={setStatusFilter} style={{ width: 130 }} options={[
            { value: 'all', label: `全部 (${users.length})` },
            { value: 'online', label: `🟢 在线 (${onlineCount})` },
            { value: 'offline', label: `⚪ 离线 (${offlineCount})` },
          ]} />
          <Button type="primary" onClick={() => setAddOpen(true)}>+ 创建账户</Button>
        </>
      }
    >
      <Card size="small">
        <Table
          size="small"
          rowKey="id"
          loading={usersQuery.isLoading}
          dataSource={filtered}
          columns={[
            {
              title: '用户名', render: (_: any, u: any) => (
                <strong>{u.displayName || u.username}{String(u.id) === String(user?.id) && <span style={{ opacity: 0.5, fontSize: 11 }}> (我)</span>}</strong>
              ),
            },
            { title: '账号', dataIndex: 'username', render: (v: string) => <span style={{ fontSize: 12, opacity: 0.7 }}>{v || '-'}</span> },
            { title: '系统', dataIndex: 'system', render: (v: string) => <Tag color={v === 'operations' ? 'purple' : 'blue'}>{SYS_LABEL[v] || v || '运维'}</Tag> },
            { title: '角色', dataIndex: 'role', render: (v: string) => <Tag color={v === 'superadmin' ? 'red' : v === 'admin' ? 'gold' : 'default'}>{ROLE_LABEL[v] || v}</Tag> },
            {
              title: '状态', dataIndex: 'online', render: (v: boolean) => (
                <span>{v ? '🟢 在线' : '⚪ 离线'}</span>
              ),
            },
            { title: '创建时间', dataIndex: 'createdAt', render: (v: string) => <span style={{ fontSize: 12, opacity: 0.7 }}>{v ? new Date(v).toLocaleDateString('zh-CN') : '-'}</span> },
            {
              title: '操作', render: (_: any, u: any) => {
                const isSelf = String(u.id) === String(user?.id);
                return (
                  <div style={{ display: 'flex', gap: 6 }}>
                    {isSuper && u.role !== 'superadmin' && (
                      <Button size="small" onClick={() => doPromote(u)}>{u.role === 'admin' ? '降级为用户' : '晋升为管理员'}</Button>
                    )}
                    {!isSelf && u.role !== 'superadmin' && (isSuper || u.role === 'user') && (
                      <Button size="small" onClick={() => { setResetTarget(u); resetForm.resetFields(); }}>🔑 密码</Button>
                    )}
                    {/* 删除权限与后端一致：仅超管可删管理员；管理员只能删除自己组内的普通用户 */}
                    {!isSelf && u.role !== 'superadmin' && (isSuper || u.role === 'user') && (
                      <Popconfirm title={`确认删除用户 ${u.username}？`} description="此操作不可撤销。"
                        onConfirm={() => doDelete(u)} okText="删除" cancelText="取消" okButtonProps={{ danger: true }}>
                        <Button size="small" danger>删除</Button>
                      </Popconfirm>
                    )}
                  </div>
                );
              },
            },
          ]}
        />
      </Card>

      {/* 创建账户 */}
      <Modal title="创建新账户" open={addOpen} onCancel={() => setAddOpen(false)} onOk={addUser}
        confirmLoading={addLoading} okText="创建" destroyOnClose>
        <Form form={addForm} layout="vertical" style={{ marginTop: 12 }}>
          <Form.Item name="displayName" label="中文名" rules={[{ required: true, message: '请输入中文名' }]}>
            <Input placeholder="输入中文姓名（用于显示）" />
          </Form.Item>
          <Form.Item name="username" label="用户名" rules={[{ required: true, message: '请输入用户名' }]}>
            <Input placeholder="输入登录用户名" />
          </Form.Item>
          <Form.Item name="password" label="密码" rules={[{ required: true, message: '请输入密码' }]}>
            <Input.Password placeholder="输入密码" />
          </Form.Item>
        </Form>
      </Modal>

      {/* 重置密码 */}
      <Modal title={`🔑 重置密码 — ${resetTarget?.displayName || resetTarget?.username || ''}`}
        open={!!resetTarget} onCancel={() => setResetTarget(null)} onOk={doReset} okText="重置" destroyOnClose>
        <Form form={resetForm} layout="vertical" style={{ marginTop: 12 }}>
          <Form.Item label="目标用户">
            <Input value={resetTarget?.displayName || resetTarget?.username || ''} disabled />
          </Form.Item>
          <Form.Item name="newPassword" label="新密码" rules={[{ required: true, message: '请输入新密码' }]}>
            <Input.Password placeholder="输入新密码（至少4个字符）" />
          </Form.Item>
          <Form.Item name="confirm" label="确认新密码" rules={[{ required: true, message: '请再次输入新密码' }]}>
            <Input.Password placeholder="再次输入新密码" />
          </Form.Item>
          <div style={{ fontSize: 12, opacity: 0.6 }}>ℹ 重置后该用户需使用新密码重新登录</div>
        </Form>
      </Modal>
    </PageContainer>
  );
}
