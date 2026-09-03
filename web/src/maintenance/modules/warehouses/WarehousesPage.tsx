// 仓库管理页（Phase 1 企业级基座）：仓库 CRUD + 启用/停用
import { useState } from 'react';
import { Button, Card, Form, Input, Modal, Popconfirm, Space, Table, Tag, message } from 'antd';
import { EditOutlined, PlusOutlined } from '@ant-design/icons';
import { useQueryClient } from '@tanstack/react-query';
import { PageContainer } from '@common/components/PageContainer';
import { useWarehouses } from '@common/hooks/useData';
import { formatTime } from '@common/utils/format';
import * as api from '@common/api';

function WarehouseFormModal({ open, existing, onClose }: { open: boolean; existing?: any; onClose: () => void }) {
  const [form] = Form.useForm();
  const [saving, setSaving] = useState(false);
  const qc = useQueryClient();

  const save = async () => {
    const values = await form.validateFields().catch(() => null);
    if (!values) return;
    setSaving(true);
    try {
      const payload = {
        name: (values.name || '').trim(),
        location: (values.location || '').trim(),
        remark: (values.remark || '').trim(),
      };
      if (existing) {
        await api.updateWarehouse(existing.id, payload);
      } else {
        await api.createWarehouse({ id: (values.id || '').trim(), ...payload });
      }
      message.success(existing ? '仓库已更新' : '仓库已创建');
      qc.invalidateQueries({ queryKey: ['warehouses'] });
      onClose();
    } catch (e: any) {
      message.error(e?.message || '保存失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title={existing ? `编辑仓库 - ${existing.id}` : '新建仓库'}
      open={open}
      onCancel={onClose}
      onOk={save}
      confirmLoading={saving}
      okText="保存"
      cancelText="取消"
      destroyOnClose
      afterOpenChange={vis => {
        if (vis) {
          form.setFieldsValue(existing
            ? { id: existing.id, name: existing.name, location: existing.location || '', remark: existing.remark || '' }
            : { id: '', name: '', location: '', remark: '' });
        }
      }}
    >
      <Form form={form} layout="vertical">
        <Form.Item name="id" label="仓库编码" rules={[
          { required: true, message: '仓库编码不能为空' },
          { pattern: /^[a-zA-Z0-9_-]{1,32}$/, message: '仅字母、数字、下划线和短横线，最长32字符' },
        ]}>
          <Input placeholder="如 wh-beijing" readOnly={!!existing} style={{ fontFamily: 'monospace' }} />
        </Form.Item>
        <Form.Item name="name" label="仓库名称" rules={[{ required: true, message: '仓库名称不能为空' }]}>
          <Input placeholder="如 北京主仓" />
        </Form.Item>
        <Form.Item name="location" label="位置">
          <Input placeholder="如 北京市海淀区" />
        </Form.Item>
        <Form.Item name="remark" label="备注">
          <Input.TextArea rows={2} />
        </Form.Item>
      </Form>
    </Modal>
  );
}

export default function WarehousesPage() {
  const { data: warehouses = [], isLoading } = useWarehouses();
  const qc = useQueryClient();

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<any>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const refresh = () => qc.invalidateQueries({ queryKey: ['warehouses'] });

  const toggleStatus = async (wh: any) => {
    const next = wh.status === 'active' ? 'disabled' : 'active';
    setBusyId(wh.id);
    try {
      await api.updateWarehouse(wh.id, { status: next });
      message.success(`仓库 ${wh.name} 已${next === 'active' ? '启用' : '停用'}`);
      refresh();
    } catch (e: any) {
      message.error(e?.message || '操作失败');
    } finally {
      setBusyId(null);
    }
  };

  const doDelete = async (wh: any) => {
    setBusyId(wh.id);
    try {
      await api.deleteWarehouse(wh.id);
      message.success(`仓库 ${wh.name} 已删除`);
      refresh();
    } catch (e: any) {
      message.error(e?.message || '删除失败');
    } finally {
      setBusyId(null);
    }
  };

  const columns: any[] = [
    {
      title: '仓库编码', dataIndex: 'id', width: 140,
      render: (v: string, r: any) => (
        <Space size={6}>
          <span style={{ fontFamily: 'monospace', fontWeight: 600 }}>{v}</span>
          {r.isDefault && <Tag color="blue">默认</Tag>}
        </Space>
      ),
    },
    { title: '名称', dataIndex: 'name', width: 160 },
    {
      title: '状态', dataIndex: 'status', width: 90,
      render: (v: string) => v === 'active'
        ? <Tag color="green">启用</Tag>
        : <Tag color="red">停用</Tag>,
    },
    { title: '位置', dataIndex: 'location', ellipsis: true, render: (v: string) => v || '-' },
    { title: 'SKU数', dataIndex: 'skuCount', width: 90, align: 'right' },
    { title: '库存总量', dataIndex: 'totalQty', width: 100, align: 'right' },
    {
      title: '是否默认', dataIndex: 'isDefault', width: 90,
      render: (v: boolean) => (v ? <Tag color="blue">默认仓库</Tag> : '-'),
    },
    { title: '更新时间', dataIndex: 'updatedAt', width: 165, render: (v: string) => formatTime(v) },
    {
      title: '操作', key: 'actions', width: 200,
      render: (_: any, r: any) => (
        <Space size={4}>
          <Button size="small" icon={<EditOutlined />} onClick={() => { setEditing(r); setFormOpen(true); }}>
            编辑
          </Button>
          {!r.isDefault && (
            <Button size="small" loading={busyId === r.id}
              danger={r.status === 'active'} onClick={() => toggleStatus(r)}>
              {r.status === 'active' ? '停用' : '启用'}
            </Button>
          )}
          {!r.isDefault && (
            <Popconfirm
              title="删除仓库"
              description={`确定删除仓库 "${r.name}"？删除后不可恢复。`}
              onConfirm={() => doDelete(r)}
              okText="删除"
              cancelText="取消"
              okButtonProps={{ danger: true }}
            >
              <Button size="small" danger>删除</Button>
            </Popconfirm>
          )}
        </Space>
      ),
    },
  ];

  return (
    <PageContainer
      title="🏪 仓库管理"
      subtitle={`共 ${warehouses.length} 个仓库`}
      extra={
        <Button type="primary" icon={<PlusOutlined />} onClick={() => { setEditing(null); setFormOpen(true); }}>
          新建仓库
        </Button>
      }
    >
      <Card>
        <Table
          rowKey="id"
          size="middle"
          loading={isLoading}
          columns={columns}
          dataSource={warehouses}
          pagination={{ pageSize: 20, showTotal: t => `共 ${t} 个仓库` }}
        />
      </Card>
      <WarehouseFormModal
        open={formOpen}
        existing={editing}
        onClose={() => { setFormOpen(false); setEditing(null); }}
      />
    </PageContainer>
  );
}
