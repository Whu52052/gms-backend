// 仓库调拨管理页（Phase 2）：发起调拨 + 调拨审批
import { useMemo, useState } from 'react';
import { Button, Card, Form, Input, InputNumber, Modal, Select, Space, Table, Tag, message, theme } from 'antd';
import { ArrowRightOutlined, PlusOutlined } from '@ant-design/icons';
import { useQueryClient } from '@tanstack/react-query';
import { PageContainer } from '@common/components/PageContainer';
import { useInventoryConfig, useWarehouseTransfers, useWarehouses } from '@common/hooks/useData';
import { trackingModeOf, typeLabelOf } from '@common/utils/domain';
import { formatTime } from '@common/utils/format';
import * as api from '@common/api';

const STATUS_META: Record<string, { label: string; color: string }> = {
  pending: { label: '待审批', color: 'orange' },
  approved: { label: '已通过', color: 'green' },
  rejected: { label: '已拒绝', color: 'red' },
};

// 内置五类库存类型（自定义品类按 hasLeftRight 展开为 _left/_right）
const BUILTIN_INV_TYPES = ['left_glove', 'right_glove', 'left_dexterous_hand', 'right_dexterous_hand', 'gripper'];

function TransferFormModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [form] = Form.useForm();
  const [saving, setSaving] = useState(false);
  const qc = useQueryClient();
  const { data: warehouses = [] } = useWarehouses();
  const inventoryConfig = useInventoryConfig();

  const fromWarehouse = Form.useWatch('fromWarehouse', form);
  const toWarehouse = Form.useWatch('toWarehouse', form);
  const sameWarehouse = !!fromWarehouse && !!toWarehouse && fromWarehouse === toWarehouse;

  // 仅数量跟踪（trackingMode=quantity）品类支持分仓调拨
  const invTypeOptions = useMemo(() => {
    const types = [...BUILTIN_INV_TYPES];
    (inventoryConfig.data || []).forEach((c: any) => {
      if (BUILTIN_INV_TYPES.includes(c.id)) return;
      if (c.hasLeftRight) types.push(c.id + '_left', c.id + '_right');
      else types.push(c.id);
    });
    return types
      .filter(t => trackingModeOf(t, inventoryConfig.data) === 'quantity')
      .map(t => ({ value: t, label: typeLabelOf(t, inventoryConfig.data) }));
  }, [inventoryConfig.data]);

  const whOptions = warehouses.map((w: any) => ({ value: w.id, label: w.name }));

  const submit = async () => {
    const values = await form.validateFields().catch(() => null);
    if (!values) return;
    setSaving(true);
    try {
      await api.createWarehouseTransfer({
        invType: values.invType,
        fromWarehouse: values.fromWarehouse,
        toWarehouse: values.toWarehouse,
        quantity: values.quantity,
        note: (values.note || '').trim(),
      });
      message.success('调拨单已创建');
      qc.invalidateQueries({ queryKey: ['warehouse-transfers'] });
      onClose();
    } catch (e: any) {
      message.error(e?.message || '创建失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title="发起调拨"
      open={open}
      onCancel={onClose}
      onOk={submit}
      confirmLoading={saving}
      okText="提交"
      cancelText="取消"
      okButtonProps={{ disabled: sameWarehouse }}
      destroyOnClose
      afterOpenChange={vis => { if (vis) form.resetFields(); }}
    >
      <Form form={form} layout="vertical">
        <Form.Item name="invType" label="品类" rules={[{ required: true, message: '请选择品类' }]}>
          <Select placeholder="请选择品类" options={invTypeOptions} />
        </Form.Item>
        <Form.Item name="fromWarehouse" label="源仓库" rules={[{ required: true, message: '请选择源仓库' }]}>
          <Select placeholder="请选择源仓库" options={whOptions} />
        </Form.Item>
        <Form.Item
          name="toWarehouse"
          label="目标仓库"
          rules={[
            { required: true, message: '请选择目标仓库' },
            {
              validator: (_: any, v: string) => (v && v === form.getFieldValue('fromWarehouse')
                ? Promise.reject(new Error('源仓库和目标仓库不能相同'))
                : Promise.resolve()),
            },
          ]}
        >
          <Select placeholder="请选择目标仓库" options={whOptions} />
        </Form.Item>
        <Form.Item name="quantity" label="数量" rules={[{ required: true, message: '请输入数量' }]}>
          <InputNumber min={1} precision={0} style={{ width: '100%' }} placeholder="请输入数量" />
        </Form.Item>
        <Form.Item name="note" label="备注">
          <Input.TextArea rows={2} placeholder="备注" />
        </Form.Item>
      </Form>
    </Modal>
  );
}

export default function WarehouseTransfersPage() {
  const { token } = theme.useToken();
  const qc = useQueryClient();
  const { data: warehouses = [] } = useWarehouses();
  const inventoryConfig = useInventoryConfig();
  const { data: transfers = [], isLoading } = useWarehouseTransfers();

  const [createOpen, setCreateOpen] = useState(false);
  const [rejecting, setRejecting] = useState<any>(null);
  const [rejectNote, setRejectNote] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);

  const refresh = () => qc.invalidateQueries({ queryKey: ['warehouse-transfers'] });

  const whName = (id?: string) => {
    if (!id) return '-';
    const wh = warehouses.find((w: any) => w.id === id);
    return wh ? wh.name : id;
  };

  const doApprove = async (r: any) => {
    setBusyId(r.id);
    try {
      await api.approveWarehouseTransfer(r.id);
      message.success('调拨单 ' + r.id + ' 已通过');
      refresh();
    } catch (e: any) {
      message.error(e?.message || '操作失败');
    } finally {
      setBusyId(null);
    }
  };

  const doReject = async () => {
    if (!rejecting) return;
    setBusyId(rejecting.id);
    try {
      await api.rejectWarehouseTransfer(rejecting.id, rejectNote.trim() || undefined);
      message.success('调拨单 ' + rejecting.id + ' 已驳回');
      setRejecting(null);
      refresh();
    } catch (e: any) {
      message.error(e?.message || '操作失败');
    } finally {
      setBusyId(null);
    }
  };

  const columns: any[] = [
    {
      title: '单号', dataIndex: 'id', width: 190,
      render: (v: string) => <span style={{ fontFamily: 'monospace', fontWeight: 600 }}>{v}</span>,
    },
    {
      title: '品类', dataIndex: 'invType', width: 130,
      render: (v: string) => (v ? typeLabelOf(v, inventoryConfig.data) : '-'),
    },
    {
      title: '源仓库 → 目标仓库', key: 'route', width: 250,
      render: (_: any, r: any) => (
        <Space size={8}>
          <span>{whName(r.fromWarehouse)}</span>
          <ArrowRightOutlined style={{ color: token.colorPrimary }} />
          <span style={{ fontWeight: 600 }}>{whName(r.toWarehouse)}</span>
        </Space>
      ),
    },
    { title: '数量', dataIndex: 'quantity', width: 80, align: 'right' },
    {
      title: '状态', dataIndex: 'status', width: 90,
      render: (v: string) => {
        const m = STATUS_META[v];
        return m ? <Tag color={m.color}>{m.label}</Tag> : (v || '-');
      },
    },
    { title: '发起人', dataIndex: 'requestedBy', width: 100, render: (v: string) => v || '-' },
    { title: '发起时间', dataIndex: 'requestedAt', width: 165, render: (v: string) => formatTime(v) },
    { title: '审批人', dataIndex: 'reviewedBy', width: 100, render: (v: string) => v || '-' },
    {
      title: '备注', key: 'note', ellipsis: true,
      render: (_: any, r: any) => {
        if (!r.note && !r.reviewNote) return '-';
        return (
          <Space direction="vertical" size={0}>
            {r.note && <span>{r.note}</span>}
            {r.reviewNote && <span style={{ fontSize: 12, color: token.colorTextTertiary }}>驳回原因：{r.reviewNote}</span>}
          </Space>
        );
      },
    },
    {
      title: '操作', key: 'actions', width: 150,
      render: (_: any, r: any) => r.status !== 'pending' ? '-' : (
        <Space size={4}>
          <Button size="small" type="primary" loading={busyId === r.id} onClick={() => doApprove(r)}>通过</Button>
          <Button size="small" danger loading={busyId === r.id} onClick={() => { setRejectNote(''); setRejecting(r); }}>驳回</Button>
        </Space>
      ),
    },
  ];

  return (
    <PageContainer
      title="🔄 仓库调拨"
      subtitle={'共 ' + transfers.length + ' 条调拨单'}
      extra={
        <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>
          发起调拨
        </Button>
      }
    >
      <Card>
        <Table
          rowKey="id"
          size="small"
          loading={isLoading}
          columns={columns}
          dataSource={transfers}
          pagination={{ pageSize: 20, showTotal: (t: number) => '共 ' + t + ' 条' }}
        />
      </Card>
      <TransferFormModal open={createOpen} onClose={() => setCreateOpen(false)} />
      <Modal
        title={rejecting ? '驳回调拨单 ' + rejecting.id : '驳回调拨单'}
        open={!!rejecting}
        onCancel={() => setRejecting(null)}
        onOk={doReject}
        confirmLoading={!!rejecting && busyId === rejecting.id}
        okText="驳回"
        okButtonProps={{ danger: true }}
        cancelText="取消"
        destroyOnClose
      >
        <Input.TextArea
          rows={3}
          maxLength={200}
          placeholder="驳回原因"
          value={rejectNote}
          onChange={e => setRejectNote(e.target.value)}
        />
      </Modal>
    </PageContainer>
  );
}
