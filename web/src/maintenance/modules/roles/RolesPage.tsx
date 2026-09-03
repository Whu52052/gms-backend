// 角色权限管理页（Phase 1 企业级基座，仅超管可用）：角色 CRUD + 权限矩阵 + 仓库范围
import { useEffect, useMemo, useState } from 'react';
import { Button, Card, Checkbox, Form, Input, Modal, Popconfirm, Radio, Space, Table, Tag, message } from 'antd';
import { DeleteOutlined, EditOutlined, PlusOutlined } from '@ant-design/icons';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { PageContainer } from '@common/components/PageContainer';
import { useWarehouses } from '@common/hooks/useData';
import { useAuthStore, isSuperAdmin } from '@common/stores/auth';
import * as api from '@common/api';

const ACTION_LABEL: Record<string, string> = {
  view: '查看', adjust: '调整', transfer: '调拨', manage: '管理', submit: '提交', respond: '回复', export: '导出',
};

/** 统计角色权限数（值为 true 的动作数） */
function permCount(perms: Record<string, Record<string, boolean>> | undefined): number {
  if (!perms) return 0;
  return Object.values(perms).reduce((s, acts) => s + Object.values(acts || {}).filter(Boolean).length, 0);
}

function RoleFormModal({ open, existing, onClose }: { open: boolean; existing?: any; onClose: () => void }) {
  const [form] = Form.useForm();
  const [saving, setSaving] = useState(false);
  const qc = useQueryClient();

  // 权限矩阵（模块key → 动作 → bool）与仓库范围（受控状态，随表单一起提交）
  const { data: permissionModules = {} } = useQuery({ queryKey: ['permissions'], queryFn: api.getPermissions });
  const { data: warehouses = [] } = useWarehouses();
  const [perms, setPerms] = useState<Record<string, Record<string, boolean>>>({});
  const [scopeMode, setScopeMode] = useState<'all' | 'custom'>('all');
  const [scopeWhs, setScopeWhs] = useState<string[]>([]);

  useEffect(() => {
    if (open) {
      form.resetFields();
      form.setFieldsValue(existing ? { id: existing.id, name: existing.name } : { id: '', name: '' });
      // 初始化权限矩阵（缺失的动作补 false）
      const init: Record<string, Record<string, boolean>> = {};
      for (const [mod, meta] of Object.entries<any>(permissionModules)) {
        init[mod] = {};
        for (const a of meta.actions || []) {
          init[mod][a] = !!(existing?.permissions?.[mod]?.[a]);
        }
      }
      setPerms(init);
      const scope = existing?.warehouseScope;
      setScopeMode(scope === 'all' || !scope ? 'all' : 'custom');
      setScopeWhs(Array.isArray(scope) ? scope : []);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, existing]);

  // 动作列 = 所有模块动作的并集（保持注册表顺序）
  const allActions = useMemo(() => {
    const set: string[] = [];
    for (const meta of Object.values<any>(permissionModules)) {
      for (const a of meta.actions || []) if (!set.includes(a)) set.push(a);
    }
    return set;
  }, [permissionModules]);

  const togglePerm = (mod: string, action: string, checked: boolean) => {
    setPerms(prev => ({ ...prev, [mod]: { ...(prev[mod] || {}), [action]: checked } }));
  };

  const save = async () => {
    const values = await form.validateFields().catch(() => null);
    if (!values) return;
    if (Object.keys(perms).length > 0 && permCount(perms) === 0) {
      message.error('请至少勾选一项权限');
      return;
    }
    if (scopeMode === 'custom' && scopeWhs.length === 0) {
      message.error('请选择指定仓库');
      return;
    }
    setSaving(true);
    try {
      const payload: any = {
        name: (values.name || '').trim(),
        permissions: perms,
        warehouseScope: scopeMode === 'all' ? 'all' : scopeWhs,
      };
      if (existing) {
        await api.updateRole(existing.id, payload);
      } else {
        await api.createRole({ id: (values.id || '').trim(), ...payload });
      }
      message.success(existing ? '角色已更新' : '角色已创建');
      qc.invalidateQueries({ queryKey: ['roles'] });
      onClose();
    } catch (e: any) {
      message.error(e?.message || '保存失败');
    } finally {
      setSaving(false);
    }
  };

  const matrixColumns: any[] = [
    { title: '模块', dataIndex: 'label', width: 110, onCell: () => ({ style: { fontWeight: 600 } }) },
    ...allActions.map(a => ({
      title: ACTION_LABEL[a] || a, key: a, width: 72, align: 'center' as const,
      render: (_: any, row: any) => row.actions.includes(a)
        ? <Checkbox checked={!!perms[row.key]?.[a]} onChange={e => togglePerm(row.key, a, e.target.checked)} />
        : <span style={{ opacity: 0.25 }}>-</span>,
    })),
  ];
  const matrixRows = Object.entries<any>(permissionModules).map(([key, meta]) => ({
    key, label: meta.label || key, actions: meta.actions || [],
  }));

  return (
    <Modal
      title={existing ? `编辑角色 - ${existing.name}` : '新建角色'}
      open={open}
      onCancel={onClose}
      onOk={save}
      confirmLoading={saving}
      okText="保存"
      cancelText="取消"
      destroyOnClose
      width={820}
    >
      <Form form={form} layout="vertical">
        <Form.Item name="id" label="角色ID" rules={[
          { required: true, message: '角色ID不能为空' },
          { pattern: /^[a-zA-Z0-9_-]{1,32}$/, message: '仅字母、数字、下划线和短横线，最长32字符' },
        ]}>
          <Input placeholder="如 warehouse_keeper" readOnly={!!existing} style={{ fontFamily: 'monospace' }} />
        </Form.Item>
        <Form.Item name="name" label="角色名称" rules={[{ required: true, message: '角色名称不能为空' }]}>
          <Input placeholder="如 仓库管理员" />
        </Form.Item>
      </Form>
      <div style={{ fontWeight: 600, margin: '4px 0 8px' }}>权限矩阵</div>
      <Table
        size="small"
        bordered
        rowKey="key"
        columns={matrixColumns}
        dataSource={matrixRows}
        pagination={false}
        scroll={{ x: 'max-content' }}
      />
      <div style={{ fontWeight: 600, margin: '16px 0 8px' }}>仓库范围</div>
      <Space direction="vertical" size={12}>
        <Radio.Group value={scopeMode} onChange={e => setScopeMode(e.target.value)}>
          <Radio value="all">全部仓库</Radio>
          <Radio value="custom">指定仓库</Radio>
        </Radio.Group>
        {scopeMode === 'custom' && (
          <Checkbox.Group
            value={scopeWhs}
            onChange={vals => setScopeWhs(vals as string[])}
            options={warehouses.map((w: any) => ({ label: w.name, value: w.id }))}
          />
        )}
      </Space>
    </Modal>
  );
}

export default function RolesPage() {
  const user = useAuthStore(s => s.user);
  const qc = useQueryClient();
  const { data: roles = [], isLoading } = useQuery({ queryKey: ['roles'], queryFn: api.getRoles });
  const { data: warehouses = [] } = useWarehouses();

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<any>(null);

  const whName = (id: string) => (warehouses.find((w: any) => w.id === id)?.name) || id;

  // 页面级权限拦截：角色权限管理仅超级管理员可用（后端接口亦要求超管）
  if (!isSuperAdmin(user)) {
    return (
      <PageContainer title="🛡️ 角色权限">
        <Card><div style={{ opacity: 0.6 }}>无权限访问</div></Card>
      </PageContainer>
    );
  }

  const doDelete = async (role: any) => {
    try {
      await api.deleteRole(role.id);
      message.success(`角色 ${role.name} 已删除`);
      qc.invalidateQueries({ queryKey: ['roles'] });
    } catch (e: any) {
      message.error(e?.message || '删除失败');
    }
  };

  const columns: any[] = [
    { title: 'ID', dataIndex: 'id', width: 140, render: (v: string) => <span style={{ fontFamily: 'monospace' }}>{v}</span> },
    { title: '名称', dataIndex: 'name', width: 130 },
    {
      title: '类型', dataIndex: 'isBuiltIn', width: 90,
      render: (v: boolean) => (v ? <Tag color="purple">内置</Tag> : <Tag color="geekblue">自定义</Tag>),
    },
    { title: '权限数', key: 'permCount', width: 90, align: 'right', render: (_: any, r: any) => permCount(r.permissions) },
    {
      title: '仓库范围', key: 'scope', width: 200,
      render: (_: any, r: any) => {
        const scope = r.warehouseScope;
        if (scope === 'all' || !scope) return <Tag color="green">全部仓库</Tag>;
        if (Array.isArray(scope)) {
          return (
            <Space size={4} wrap>
              {scope.slice(0, 3).map(id => <Tag key={id}>{whName(id)}</Tag>)}
              {scope.length > 3 && <Tag>+{scope.length - 3}</Tag>}
            </Space>
          );
        }
        return String(scope);
      },
    },
    { title: '使用人数', dataIndex: 'userCount', width: 90, align: 'right', render: (v: number) => v ?? '-' },
    {
      title: '操作', key: 'actions', width: 170,
      render: (_: any, r: any) => {
        const locked = !!r.isBuiltIn;
        const inUse = (r.userCount ?? 0) > 0;
        return (
          <Space size={4}>
            <Button size="small" icon={<EditOutlined />} disabled={locked} onClick={() => { setEditing(r); setFormOpen(true); }}>
              编辑
            </Button>
            <Popconfirm
              title="删除角色"
              description={`确定删除角色 "${r.name}"？`}
              onConfirm={() => doDelete(r)}
              okText="删除"
              cancelText="取消"
              okButtonProps={{ danger: true }}
              disabled={locked || inUse}
            >
              <Button size="small" danger icon={<DeleteOutlined />} disabled={locked || inUse}>
                删除
              </Button>
            </Popconfirm>
          </Space>
        );
      },
    },
  ];

  return (
    <PageContainer
      title="🛡️ 角色权限"
      subtitle={`共 ${roles.length} 个角色`}
      extra={
        <Button type="primary" icon={<PlusOutlined />} onClick={() => { setEditing(null); setFormOpen(true); }}>
          新建角色
        </Button>
      }
    >
      <Card>
        <Table
          rowKey="id"
          size="middle"
          loading={isLoading}
          columns={columns}
          dataSource={roles}
          pagination={false}
        />
      </Card>
      <RoleFormModal
        open={formOpen}
        existing={editing}
        onClose={() => { setFormOpen(false); setEditing(null); }}
      />
    </PageContainer>
  );
}
