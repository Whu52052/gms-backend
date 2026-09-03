// 库存审计页（Phase 1 企业级基座）：结构化库存操作流水（调整/盘点/仓库变更）
import { useState } from 'react';
import { Button, Card, Flex, Input, Select, Table, Tag } from 'antd';
import { SearchOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import { PageContainer } from '@common/components/PageContainer';
import { useWarehouses, useInventoryConfig } from '@common/hooks/useData';
import { typeLabelOf } from '@common/utils/domain';
import { formatTime } from '@common/utils/format';
import * as api from '@common/api';

const ACTION_META: Record<string, { label: string; color: string }> = {
  adjust: { label: '库存调整', color: 'blue' },
  stocktake_adjust: { label: '盘点调整', color: 'purple' },
  warehouse_create: { label: '创建仓库', color: 'green' },
  warehouse_update: { label: '更新仓库', color: 'orange' },
  warehouse_delete: { label: '删除仓库', color: 'red' },
};

interface Filters {
  action?: string;
  warehouseId?: string;
  invType?: string;
  operator?: string;
}

export default function InventoryAuditPage() {
  const { data: warehouses = [] } = useWarehouses();
  const inventoryConfig = useInventoryConfig();

  const [input, setInput] = useState<Filters>({});
  const [applied, setApplied] = useState<Filters>({});

  // 查询参数：limit=200 + 已应用的筛选条件
  const queryString = (() => {
    const params = new URLSearchParams();
    params.set('limit', '200');
    if (applied.action) params.set('action', applied.action);
    if (applied.warehouseId) params.set('warehouseId', applied.warehouseId);
    if (applied.invType) params.set('invType', applied.invType.trim());
    if (applied.operator) params.set('operator', applied.operator.trim());
    return params.toString();
  })();

  const { data: logs = [], isLoading } = useQuery({
    queryKey: ['inventory-audit', applied],
    queryFn: () => api.getInventoryAudit(queryString),
  });

  const whName = (id: string) => {
    if (!id) return '-';
    const wh = warehouses.find((w: any) => w.id === id);
    return wh ? `${wh.name}（${wh.id}）` : id;
  };

  const doSearch = () => setApplied({
    action: input.action,
    warehouseId: input.warehouseId,
    invType: (input.invType || '').trim() || undefined,
    operator: (input.operator || '').trim() || undefined,
  });

  const columns: any[] = [
    { title: '时间', dataIndex: 'ts', width: 165, render: (v: string) => formatTime(v) },
    { title: '操作人', dataIndex: 'operator', width: 110, render: (v: string) => v || '-' },
    {
      title: '动作', dataIndex: 'action', width: 110,
      render: (v: string) => {
        const meta = ACTION_META[v];
        return meta ? <Tag color={meta.color}>{meta.label}</Tag> : (v || '-');
      },
    },
    { title: '仓库', key: 'warehouse', width: 160, render: (_: any, r: any) => whName(r.warehouseId) },
    {
      title: '品类', dataIndex: 'invType', width: 120,
      render: (v: string) => (v ? (typeLabelOf(v, inventoryConfig.data) || v) : '-'),
    },
    {
      title: '变动', key: 'detail', width: 110,
      render: (_: any, r: any) => {
        const d = r.detail;
        if (d && d.before != null && d.after != null) {
          return (
            <span style={{ fontFamily: 'monospace' }}>
              <span style={{ opacity: 0.6 }}>{d.before}</span>
              <span style={{ margin: '0 4px', color: d.after >= d.before ? '#22c55e' : '#ef4444' }}>→</span>
              <b>{d.after}</b>
            </span>
          );
        }
        return '-';
      },
    },
    { title: '备注', dataIndex: 'note', ellipsis: true, render: (v: string) => v || '-' },
  ];

  return (
    <PageContainer
      title="📋 库存审计"
      subtitle={`最近 ${logs.length} 条记录`}
    >
      <Card style={{ marginBottom: 16 }}>
        <Flex gap={8} wrap="wrap" align="center">
          <Select
            style={{ width: 150 }}
            placeholder="动作"
            allowClear
            value={input.action}
            onChange={v => setInput(prev => ({ ...prev, action: v }))}
            options={Object.entries(ACTION_META).map(([value, meta]) => ({ value, label: meta.label }))}
          />
          <Select
            style={{ width: 160 }}
            placeholder="仓库"
            allowClear
            value={input.warehouseId}
            onChange={v => setInput(prev => ({ ...prev, warehouseId: v }))}
            options={warehouses.map((w: any) => ({ value: w.id, label: w.name }))}
          />
          <Input
            style={{ width: 160 }}
            placeholder="品类"
            allowClear
            value={input.invType}
            onChange={e => setInput(prev => ({ ...prev, invType: e.target.value }))}
          />
          <Input
            style={{ width: 140 }}
            placeholder="操作人"
            allowClear
            value={input.operator}
            onChange={e => setInput(prev => ({ ...prev, operator: e.target.value }))}
          />
          <Button type="primary" icon={<SearchOutlined />} onClick={doSearch}>查询</Button>
        </Flex>
      </Card>
      <Card>
        <Table
          rowKey="id"
          size="small"
          loading={isLoading}
          columns={columns}
          dataSource={logs}
          pagination={{ pageSize: 20, showTotal: t => `共 ${t} 条` }}
        />
      </Card>
    </PageContainer>
  );
}
