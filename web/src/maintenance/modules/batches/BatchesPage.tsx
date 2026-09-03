// 批次管理页（Phase 2）：批次效期追踪（临期/过期/耗尽）
import { useMemo, useState } from 'react';
import { Card, Col, Flex, Row, Select, Statistic, Table, Tag, theme } from 'antd';
import { PageContainer } from '@common/components/PageContainer';
import { useBatches, useInventoryConfig, useWarehouses } from '@common/hooks/useData';
import { typeLabelOf } from '@common/utils/domain';
import { formatTime } from '@common/utils/format';

const STATUS_META: Record<string, { label: string; color: string }> = {
  normal: { label: '正常', color: 'green' },
  expiring: { label: '临期', color: 'orange' },
  expired: { label: '已过期', color: 'red' },
  depleted: { label: '已耗尽', color: 'default' },
};

// 内置五类库存类型（自定义品类按 hasLeftRight 展开为 _left/_right）
const BUILTIN_INV_TYPES = ['left_glove', 'right_glove', 'left_dexterous_hand', 'right_dexterous_hand', 'gripper'];

export default function BatchesPage() {
  const { token } = theme.useToken();
  const { data: warehouses = [] } = useWarehouses();
  const inventoryConfig = useInventoryConfig();

  const [invType, setInvType] = useState('');
  const [warehouseId, setWarehouseId] = useState('');
  const [status, setStatus] = useState('');

  const { data: batches = [], isLoading } = useBatches({
    invType: invType || undefined,
    warehouseId: warehouseId || undefined,
    status: status || undefined,
  });

  // 品类下拉选项：内置五类 + 自定义配置（左右手展开）
  const invTypeOptions = useMemo(() => {
    const types = [...BUILTIN_INV_TYPES];
    (inventoryConfig.data || []).forEach((c: any) => {
      if (BUILTIN_INV_TYPES.includes(c.id)) return;
      if (c.hasLeftRight) types.push(c.id + '_left', c.id + '_right');
      else types.push(c.id);
    });
    return types.map(t => ({ value: t, label: typeLabelOf(t, inventoryConfig.data) }));
  }, [inventoryConfig.data]);

  const stats = useMemo(() => {
    const s = { total: batches.length, expiring: 0, expired: 0, depleted: 0 };
    batches.forEach((b: any) => {
      if (b.status === 'expiring') s.expiring++;
      else if (b.status === 'expired') s.expired++;
      else if (b.status === 'depleted') s.depleted++;
    });
    return s;
  }, [batches]);

  const whName = (id?: string) => {
    if (!id) return '-';
    const wh = warehouses.find((w: any) => w.id === id);
    return wh ? wh.name : id;
  };

  const columns: any[] = [
    {
      title: '批次编码', dataIndex: 'id', width: 175,
      render: (v: string) => <span style={{ fontFamily: 'monospace', fontWeight: 600 }}>{v}</span>,
    },
    {
      title: '品类', dataIndex: 'invType', width: 130,
      render: (v: string) => (v ? typeLabelOf(v, inventoryConfig.data) : '-'),
    },
    { title: '仓库', dataIndex: 'warehouseId', width: 130, render: (v: string) => whName(v) },
    { title: '当前数量', dataIndex: 'quantity', width: 95, align: 'right' },
    { title: '入库数量', dataIndex: 'initialQty', width: 95, align: 'right' },
    {
      title: '入库时间', dataIndex: 'receivedAt', width: 145,
      render: (v: string) => (v ? formatTime(v).slice(0, 16) : '-'),
    },
    {
      title: '效期', dataIndex: 'expiryDate', width: 115,
      render: (v: string) => (v ? <span style={{ fontFamily: 'monospace' }}>{v}</span> : '-'),
    },
    {
      title: '状态', dataIndex: 'status', width: 90,
      render: (v: string) => {
        const m = STATUS_META[v];
        return m ? <Tag color={m.color}>{m.label}</Tag> : (v || '-');
      },
    },
    { title: '备注', dataIndex: 'note', ellipsis: true, render: (v: string) => v || '-' },
    { title: '创建人', dataIndex: 'createdBy', width: 100, render: (v: string) => v || '-' },
  ];

  return (
    <PageContainer title="📦 批次管理" subtitle={'共 ' + batches.length + ' 个批次'}>
      <Row gutter={12} style={{ marginBottom: 16 }}>
        <Col xs={12} md={6}>
          <Card size="small">
            <Statistic title="批次总数" value={stats.total} />
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card size="small">
            <Statistic title="临期批次" value={stats.expiring} valueStyle={{ color: token.colorWarning }} />
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card size="small">
            <Statistic title="已过期批次" value={stats.expired} valueStyle={{ color: token.colorError }} />
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card size="small">
            <Statistic title="耗尽批次" value={stats.depleted} valueStyle={{ color: token.colorTextTertiary }} />
          </Card>
        </Col>
      </Row>
      <Card style={{ marginBottom: 16 }}>
        <Flex gap={8} wrap="wrap" align="center">
          <Select
            style={{ width: 170 }}
            value={invType}
            onChange={setInvType}
            options={[{ value: '', label: '全部品类' }, ...invTypeOptions]}
          />
          <Select
            style={{ width: 170 }}
            value={warehouseId}
            onChange={setWarehouseId}
            options={[{ value: '', label: '全部仓库' }, ...warehouses.map((w: any) => ({ value: w.id, label: w.name }))]}
          />
          <Select
            style={{ width: 130 }}
            value={status}
            onChange={setStatus}
            options={[{ value: '', label: '全部状态' }, ...Object.entries(STATUS_META).map(([value, m]) => ({ value, label: m.label }))]}
          />
        </Flex>
      </Card>
      <Card>
        <Table
          rowKey="id"
          size="small"
          loading={isLoading}
          columns={columns}
          dataSource={batches}
          rowClassName={(r: any) => (r.status === 'expired' ? 'batch-row-expired' : r.status === 'expiring' ? 'batch-row-expiring' : '')}
          pagination={{ pageSize: 20, showTotal: (t: number) => '共 ' + t + ' 个批次' }}
        />
      </Card>
    </PageContainer>
  );
}
