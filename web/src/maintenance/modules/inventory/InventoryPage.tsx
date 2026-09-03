// 动态库存页（移植 js/ui/inventory.js 全部视图：手套/灵巧手/夹爪/自定义类型，由侧边栏设备下拉驱动）
// Phase 1 多仓库改造：按仓库筛选，数据来自 /api/inventory?groupBy=warehouse（品类×仓库一行）
import { useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Button, Card, Col, Empty, Flex, List, Modal, Row, Select, Space, Statistic, Table, Tag, Typography, message } from 'antd';
import { PlusOutlined, InboxOutlined, EditOutlined, PaperClipOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import { PageContainer } from '@common/components/PageContainer';
import { useTransactions, useSNRegistry, useInventoryConfig, useWarehouses } from '@common/hooks/useData';
import { statusCountsFor } from '@common/hooks/useInventoryStats';
import { useAuthStore, isSuperAdmin, isAdmin } from '@common/stores/auth';
import { typeLabelOf, trackingModeOf } from '@common/utils/domain';
import { formatTime } from '@common/utils/format';
import * as api from '@common/api';
import { QuickInOutModal, SetInventoryModal, BatchOperationModal } from './inventoryModals';
import { useDeleteTransaction } from '../transactions/txActions';

// 内置类型组 → 页面定义
const BUILTIN_GROUPS: Record<string, { name: string; icon: string; types: string[]; txEq: string }> = {
  glove: { name: '手套库存管理', icon: '🧤', types: ['left_glove', 'right_glove'], txEq: 'glove' },
  dexterous: { name: '灵巧手管理', icon: '🤖', types: ['left_dexterous_hand', 'right_dexterous_hand'], txEq: 'dexterous_hand' },
  gripper: { name: '夹爪 (Pika) 管理', icon: '🔧', types: ['gripper'], txEq: 'gripper' },
};

export default function InventoryPage() {
  const { type: routeType = 'glove' } = useParams();
  const inventory = useQuery({ queryKey: ['inventory', 'by-warehouse'], queryFn: api.getInventoryByWarehouse });
  const transactions = useTransactions();
  const snRegistry = useSNRegistry();
  const inventoryConfig = useInventoryConfig();
  const { data: warehouses = [] } = useWarehouses();
  const user = useAuthStore(s => s.user);
  const deleteTx = useDeleteTransaction();
  const superAdmin = isSuperAdmin(user);
  const admin = isAdmin(user);

  const [wh, setWh] = useState<string>('all');   // 仓库筛选：'all' = 全部仓库
  const [quickOpen, setQuickOpen] = useState<{ type: string; direction: 'in' | 'out'; warehouseId: string } | null>(null);
  const [setOpen, setSetOpen] = useState<{ type: string; current: number; warehouseId: string } | null>(null);
  const [batchOpen, setBatchOpen] = useState(false);
  const [breakdown, setBreakdown] = useState<{ type: string; warehouseId: string; quantity: number; updatedAt?: string; updatedBy?: string } | null>(null);

  // 解析当前页面定义
  const page = useMemo(() => {
    if (BUILTIN_GROUPS[routeType]) return { ...BUILTIN_GROUPS[routeType], batchKind: routeType as 'glove' | 'dexterous' | undefined, hasHand: routeType !== 'gripper' };
    // 自定义类型：路由可能是 baseId 或 baseId_left/right
    const base = routeType.replace(/_left$|_right$/, '');
    const cfg = (inventoryConfig.data || []).find((c: any) => c.id === base);
    if (!cfg) return null;
    const types = cfg.hasLeftRight ? [`${base}_left`, `${base}_right`] : [base];
    return {
      name: `${cfg.name}管理`, icon: cfg.icon || '📦', types, txEq: base,
      batchKind: undefined as 'glove' | 'dexterous' | undefined, hasHand: !!cfg.hasLeftRight,
    };
  }, [routeType, inventoryConfig.data]);

  // 页面级跟踪模式：页面所有类型均为纯数量模式时走简化 UI（无 SN 状态/批量操作）
  const pageMode = useMemo(
    () => (page && page.types.every(t => trackingModeOf(t, inventoryConfig.data) === 'quantity') ? 'quantity' : 'sn'),
    [page, inventoryConfig.data]
  );

  // 分仓行数据（每行 = 品类 × 仓库），按当前仓库筛选过滤
  const invRows = useMemo(() => {
    const all = (inventory.data || []).filter((r: any) => page && page.types.includes(r.type));
    return wh === 'all' ? all : all.filter((r: any) => r.warehouseId === wh);
  }, [inventory.data, page, wh]);

  const txs = useMemo(() => {
    if (!page) return [];
    return (transactions.data || []).filter((t: any) => {
      // 兼容新旧格式：equipmentType=基础类型 或 带 _left/_right 后缀
      return t.equipmentType === page.txEq
        || t.equipmentType === `${page.txEq}_left`
        || t.equipmentType === `${page.txEq}_right`;
    });
  }, [transactions.data, page]);

  if (!page) {
    return (
      <PageContainer title="库存管理">
        <Empty description={`未找到库存类型：${routeType}`} style={{ marginTop: 60 }} />
      </PageContainer>
    );
  }

  const labelOf = (t: string) => typeLabelOf(t, inventoryConfig.data);
  const whName = (id?: string) => (warehouses.find((w: any) => w.id === id)?.name) || id || '-';

  const txColumns: any[] = [
    { title: '时间', dataIndex: 'timestamp', width: 165, render: (v: string) => formatTime(v) },
    ...(page.hasHand ? [{
      title: '左右手', dataIndex: 'handType', width: 80,
      render: (v: string, t: any) => (v === 'left' || String(t.equipmentType || '').endsWith('_left')) ? '左手' : (v === 'right' || String(t.equipmentType || '').endsWith('_right')) ? '右手' : '-',
    }] : []),
    { title: '操作', dataIndex: 'direction', width: 80, render: (v: string) => <Tag color={v === 'in' ? 'green' : 'red'}>{v === 'in' ? '入库' : '出库'}</Tag> },
    { title: '数量', dataIndex: 'quantity', width: 70 },
    {
      title: 'SN码', dataIndex: 'snCode', render: (v: string, t: any) => (
        <Space size={4}>
          <span style={{ fontFamily: 'monospace', fontSize: 12 }}>{v || '-'}</span>
          {t.attachment && <a href={t.attachment} target="_blank" rel="noreferrer"><PaperClipOutlined /></a>}
        </Space>
      ),
    },
    { title: '机器编号', dataIndex: 'machineNumber', width: 90, render: (v: string) => v || '-' },
    { title: '更新人', dataIndex: 'updatedBy', width: 100, render: (v: string) => v || '-' },
    { title: '备注', dataIndex: 'note', ellipsis: true, render: (v: string) => v || '-' },
    ...(admin ? [{
      title: '操作', dataIndex: 'id', width: 70,
      render: (_: any, t: any) => <Button type="link" danger size="small" onClick={() => deleteTx(t, inventoryConfig.data)}>清除</Button>,
    }] : []),
  ];

  const renderInvCard = (row: any) => {
    const invType = row.type;
    const isQty = trackingModeOf(invType, inventoryConfig.data) === 'quantity';
    const counts = statusCountsFor(invType, snRegistry.data || []);
    return (
      <Card
        key={`${invType}__${row.warehouseId}`}
        size="small"
        hoverable
        onClick={() => setBreakdown({ type: invType, warehouseId: row.warehouseId, quantity: row.quantity ?? 0, updatedAt: row.updatedAt, updatedBy: row.updatedBy })}
        title={<Space>{wh === 'all' ? `${labelOf(invType)} · ${whName(row.warehouseId)}` : labelOf(invType)}<Tag color={isQty ? 'geekblue' : 'cyan'}>{isQty ? '数量跟踪' : '库存'}</Tag></Space>}
        extra={superAdmin && (
          <Button size="small" icon={<EditOutlined />} onClick={e => { e.stopPropagation(); setSetOpen({ type: invType, current: row.quantity ?? 0, warehouseId: row.warehouseId }); }}>
            直接设置
          </Button>
        )}
      >
        <Statistic value={row.quantity ?? 0} suffix={isQty ? '件' : '总数'} />
        {!isQty && (
          <Row gutter={8} style={{ marginTop: 12, textAlign: 'center' }}>
            <Col span={6}><div style={{ fontWeight: 700, color: '#22c55e' }}>{counts.available}</div><div style={{ fontSize: 12, opacity: 0.6 }}>可用</div></Col>
            <Col span={6}><div style={{ fontWeight: 700, color: '#3b82f6' }}>{counts.inUse}</div><div style={{ fontSize: 12, opacity: 0.6 }}>使用中</div></Col>
            <Col span={6}><div style={{ fontWeight: 700, color: '#ef4444' }}>{counts.damaged}</div><div style={{ fontSize: 12, opacity: 0.6 }}>损坏</div></Col>
            <Col span={6}><div style={{ fontWeight: 700, color: '#f59e0b' }}>{counts.inRepair}</div><div style={{ fontSize: 12, opacity: 0.6 }}>维修中</div></Col>
          </Row>
        )}
        <div style={{ fontSize: 12, opacity: 0.55, marginTop: 10 }}>
          更新：{formatTime(row.updatedAt)} · {row.updatedBy || '暂无记录'}
        </div>
      </Card>
    );
  };

  const breakdownCounts = breakdown ? statusCountsFor(breakdown.type, snRegistry.data || []) : null;
  const breakdownTxs = breakdown
    ? (transactions.data || []).filter((t: any) => {
      const { equipmentType: eq, handType: ht } = (() => {
        const m = breakdown.type.match(/^(.+)_(left|right)$/);
        if (breakdown.type === 'left_glove' || breakdown.type === 'right_glove') return { equipmentType: 'glove', handType: breakdown.type.startsWith('left') ? 'left' : 'right' };
        if (breakdown.type === 'left_dexterous_hand' || breakdown.type === 'right_dexterous_hand') return { equipmentType: 'dexterous_hand', handType: breakdown.type.startsWith('left') ? 'left' : 'right' };
        if (m) return { equipmentType: m[1], handType: m[2] };
        return { equipmentType: breakdown.type, handType: null };
      })();
      return t.equipmentType === eq && (ht === null || t.handType === ht || t.equipmentType === breakdown.type);
    }).slice(0, 10)
    : [];

  const selectedWh = wh === 'all' ? 'main' : wh;

  return (
    <PageContainer
      title={<span>{page.icon} {page.name}</span>}
      extra={
        <>
          <Select
            style={{ width: 170 }}
            value={wh}
            onChange={setWh}
            options={[
              { value: 'all', label: '全部仓库' },
              ...warehouses.map((w: any) => ({ value: w.id, label: w.name })),
            ]}
          />
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setQuickOpen({ type: page.types[0], direction: 'in', warehouseId: selectedWh })}>
            新增出入库记录
          </Button>
          {page.batchKind && (
            <Button icon={<InboxOutlined />} onClick={() => setBatchOpen(true)}>批量操作</Button>
          )}
        </>
      }
    >
      {invRows.length === 0 ? (
        <Card size="small" style={{ marginBottom: 16 }}>
          <Empty description="该仓库暂无此品类库存" style={{ margin: '32px 0' }} />
        </Card>
      ) : (
        <Row gutter={[12, 12]} style={{ marginBottom: 16 }}>
          {invRows.map(r => <Col key={`${r.type}__${r.warehouseId}`} flex={1} style={{ minWidth: 220 }}>{renderInvCard(r)}</Col>)}
        </Row>
      )}

      <Typography.Title level={5}>{page.name.replace('管理', '')}流水记录</Typography.Title>
      <Table rowKey="id" size="small" loading={transactions.isLoading} columns={txColumns}
        dataSource={txs} pagination={{ pageSize: 20, showTotal: t => `共 ${t} 条` }} />

      {/* 快速出入库 */}
      <QuickInOutModal
        open={!!quickOpen}
        type={quickOpen?.type || page.types[0]}
        initialDirection={quickOpen?.direction || 'in'}
        inventoryConfig={inventoryConfig.data}
        warehouseId={quickOpen?.warehouseId || selectedWh}
        onClose={() => setQuickOpen(null)}
      />
      {/* 直接设置库存 */}
      <SetInventoryModal
        open={!!setOpen}
        type={setOpen?.type || ''}
        current={setOpen?.current || 0}
        inventoryConfig={inventoryConfig.data}
        warehouseId={setOpen?.warehouseId || selectedWh}
        onClose={() => setSetOpen(null)}
      />
      {/* 批量操作 */}
      <BatchOperationModal open={batchOpen} kind={page.batchKind || 'glove'} warehouseId={selectedWh} onClose={() => setBatchOpen(false)} />

      {/* 库存详情弹窗 */}
      <Modal
        title={`${breakdown ? `${labelOf(breakdown.type)} · ${whName(breakdown.warehouseId)}` : ''} 库存详情`}
        open={!!breakdown}
        onCancel={() => setBreakdown(null)}
        footer={null}
        width={620}
      >
        {breakdown && (
          <div>
            <Flex align="center" justify="center" gap={24} style={{ margin: '8px 0 16px' }}>
              <Statistic title={`${labelOf(breakdown.type)} · ${whName(breakdown.warehouseId)}`} value={breakdown.quantity ?? 0} suffix="个" />
              {breakdownCounts && trackingModeOf(breakdown.type, inventoryConfig.data) !== 'quantity' && (
                <Space size={16} style={{ fontSize: 12 }}>
                  <span>可用 <b style={{ color: '#22c55e' }}>{breakdownCounts.available}</b></span>
                  <span>使用中 <b style={{ color: '#3b82f6' }}>{breakdownCounts.inUse}</b></span>
                  <span>损坏 <b style={{ color: '#ef4444' }}>{breakdownCounts.damaged}</b></span>
                  <span>维修中 <b style={{ color: '#f59e0b' }}>{breakdownCounts.inRepair}</b></span>
                </Space>
              )}
            </Flex>
            <div style={{ fontSize: 12, opacity: 0.6, textAlign: 'center', marginBottom: 12 }}>
              最后更新: {formatTime(breakdown.updatedAt)} · 更新人: {breakdown.updatedBy || '无'}
            </div>
            <Flex justify="center" gap={8} style={{ marginBottom: 16 }}>
              <Button type="primary" onClick={() => { setQuickOpen({ type: breakdown.type, direction: 'in', warehouseId: breakdown.warehouseId }); setBreakdown(null); }}>+ 入库</Button>
              <Button color="danger" variant="solid" onClick={() => { setQuickOpen({ type: breakdown.type, direction: 'out', warehouseId: breakdown.warehouseId }); setBreakdown(null); }}>- 出库</Button>
            </Flex>
            <Typography.Title level={5} style={{ fontSize: 13 }}>最近10条流水</Typography.Title>
            <List
              size="small"
              dataSource={breakdownTxs}
              locale={{ emptyText: '暂无记录' }}
              renderItem={(t: any) => (
                <List.Item style={{ padding: '6px 0' }}>
                  <Space size={8} style={{ width: '100%', justifyContent: 'space-between' }}>
                    <span style={{ fontSize: 12, opacity: 0.65 }}>{formatTime(t.timestamp)}</span>
                    <Tag color={t.direction === 'in' ? 'green' : 'red'}>{t.direction === 'in' ? '入库' : '出库'} {t.quantity}</Tag>
                    <span style={{ fontFamily: 'monospace', fontSize: 12 }}>{t.snCode || '-'}</span>
                    <span style={{ fontSize: 12 }}>{t.updatedBy || '-'}</span>
                  </Space>
                </List.Item>
              )}
            />
          </div>
        )}
      </Modal>
    </PageContainer>
  );
}

export { InventoryPage };

// message 用于后续扩展提示
void message;
