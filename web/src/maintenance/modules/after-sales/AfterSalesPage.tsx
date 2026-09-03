// 售后管理页：损坏待送售后 + 售后维修中（移植 mobile.js _renderAfterSales 逻辑，
// 桌面版改用服务端原子接口 shipSN / repairCompleteSN）
import { useMemo, useState } from 'react';
import {
  Button, Card, Col, Empty, Flex, Input, Modal, Row, Space, Statistic, Table, Typography, message,
} from 'antd';
import { CheckCircleOutlined, SendOutlined } from '@ant-design/icons';
import { useQueryClient } from '@tanstack/react-query';
import { PageContainer } from '@common/components/PageContainer';
import { useSNRegistry } from '@common/hooks/useData';
import { equipmentLabel, formatTime } from '@common/utils/format';
import * as api from '@common/api';

export default function AfterSalesPage() {
  const { data: registry = [], isLoading } = useSNRegistry();
  const qc = useQueryClient();

  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [tracking, setTracking] = useState('');
  const [shipping, setShipping] = useState(false);

  const damaged = useMemo(() => registry.filter(s => s.status === 'damaged'), [registry]);
  const inRepair = useMemo(() => registry.filter(s => s.status === 'in_repair' || s.status === 'inRepair'), [registry]);

  const matchSearch = (s: any) => {
    const q = search.trim().toLowerCase();
    if (!q) return true;
    return String(s.snCode || '').toLowerCase().includes(q) ||
      String(s.trackingNumber || '').toLowerCase().includes(q) ||
      String(s.damageReason || '').toLowerCase().includes(q);
  };
  const damagedList = damaged.filter(matchSearch);
  const repairList = inRepair.filter(matchSearch);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['sn-registry'] });
    qc.invalidateQueries({ queryKey: ['inventory'] });
    qc.invalidateQueries({ queryKey: ['transactions'] });
  };

  // 批量送售后：逐个 shipSN（状态 → in_repair + 快递单号），成功后自动生成维修发货单
  const batchShip = () => {
    if (selected.length === 0) { message.warning('请先选择要送售后的 SN'); return; }
    Modal.confirm({
      title: `确认将 ${selected.length} 个损坏 SN 送售后（发货给厂家维修）？`,
      content: tracking ? `快递单号：${tracking}` : '未填写快递单号',
      onOk: async () => {
        setShipping(true);
        let ok = 0; let fail = 0; let firstErr = '';
        for (const sn of selected) {
          try {
            const r = await api.shipSN(sn, tracking.trim());
            if (r && r.success !== false) ok++;
            else { fail++; if (!firstErr) firstErr = r?.error || '操作失败'; }
          } catch (e: any) { fail++; if (!firstErr) firstErr = e?.message || '网络错误'; }
        }
        if (ok > 0) {
          message.success(`已送售后 ${ok} 个 SN`);
          // 自动保存维修发货单（与移动端一致）
          try {
            const all = await api.getSNRegistry();
            const items = selected.map(sn => {
              const row = (all || []).find((x: any) => x.snCode === sn);
              return {
                snCode: sn,
                eqLabel: equipmentLabel(row?.equipmentType, row?.handType),
                handLabel: row?.handType === 'right' ? '右手' : '左手',
                equipmentType: row?.equipmentType || 'glove',
                handType: row?.handType || 'left',
                reason: row?.damageReason || '',
              };
            });
            await api.saveDeliveryNote({ type: 'repair', items, trackingNumber: tracking.trim() });
          } catch { /* 发货单保存失败不影响主流程 */ }
        }
        if (fail > 0) message.error(`${fail} 个失败${firstErr ? `：${firstErr}` : ''}`);
        setSelected([]);
        setShipping(false);
        invalidate();
      },
    });
  };

  const repairComplete = (snCode: string) => {
    Modal.confirm({
      title: `确认 ${snCode} 维修完成？`,
      content: '维修完成后 SN 恢复为可用状态并归还库存。',
      onOk: async () => {
        try {
          const r = await api.repairCompleteSN(snCode);
          if (r && r.success === false) { message.error(r.error || '操作失败'); return; }
          message.success(`${snCode} 维修完成，已归还库存`);
          invalidate();
        } catch (e: any) {
          message.error(e?.message || '操作失败');
        }
      },
    });
  };

  return (
    <PageContainer title="售后管理" subtitle="损坏设备送售后维修与回库跟踪">
      {/* 统计卡片 */}
      <Row gutter={12} style={{ marginBottom: 12 }}>
        <Col span={8}><Card size="small"><Statistic title="损坏待送售后" value={damaged.length} valueStyle={{ color: '#ef4444' }} /></Card></Col>
        <Col span={8}><Card size="small"><Statistic title="售后维修中" value={inRepair.length} valueStyle={{ color: '#f59e0b' }} /></Card></Col>
        <Col span={8}><Card size="small"><Statistic title="合计" value={damaged.length + inRepair.length} /></Card></Col>
      </Row>

      <Flex wrap gap={8} align="center" style={{ marginBottom: 12 }}>
        <Input.Search
          placeholder="搜索SN码/快递单号/损坏原因..."
          allowClear
          style={{ width: 260 }}
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
      </Flex>

      {/* 待送售后 */}
      <Card
        size="small"
        title={<span><SendOutlined /> 待送售后（损坏）</span>}
        extra={
          <Space>
            <Input
              placeholder="快递单号（可选，多个SN共用）"
              size="small"
              style={{ width: 220 }}
              value={tracking}
              onChange={e => setTracking(e.target.value)}
            />
            <Button size="small" type="primary" loading={shipping} disabled={selected.length === 0} onClick={batchShip}>
              批量送售后 ({selected.length})
            </Button>
          </Space>
        }
        style={{ marginBottom: 12 }}
      >
        <Table
          rowKey="snCode"
          size="small"
          loading={isLoading}
          dataSource={damagedList}
          locale={{ emptyText: <Empty description="暂无待送售后的损坏设备" /> }}
          pagination={{ pageSize: 10, showTotal: t => `共 ${t} 条` }}
          rowSelection={{
            selectedRowKeys: selected,
            onChange: keys => setSelected(keys as string[]),
          }}
          columns={[
            { title: 'SN码', dataIndex: 'snCode', render: (v: string) => <Typography.Text code>{v}</Typography.Text> },
            { title: '设备', render: (_: any, s: any) => equipmentLabel(s.equipmentType, s.handType) },
            { title: '损坏原因', dataIndex: 'damageReason', ellipsis: true, render: (v: string) => v || '-' },
            { title: '更新时间', dataIndex: 'updatedAt', width: 170, render: (v: string) => formatTime(v) },
          ]}
        />
      </Card>

      {/* 售后维修中 */}
      <Card size="small" title={<span><CheckCircleOutlined /> 售后维修中</span>}>
        <Table
          rowKey="snCode"
          size="small"
          loading={isLoading}
          dataSource={repairList}
          locale={{ emptyText: <Empty description="暂无售后维修中的设备" /> }}
          pagination={{ pageSize: 10, showTotal: t => `共 ${t} 条` }}
          columns={[
            { title: 'SN码', dataIndex: 'snCode', render: (v: string) => <Typography.Text code>{v}</Typography.Text> },
            { title: '设备', render: (_: any, s: any) => equipmentLabel(s.equipmentType, s.handType) },
            { title: '快递单号', dataIndex: 'trackingNumber', render: (v: string) => v || '-' },
            { title: '损坏原因', dataIndex: 'damageReason', ellipsis: true, render: (v: string) => v || '-' },
            { title: '送修时间', dataIndex: 'updatedAt', width: 170, render: (v: string) => formatTime(v) },
            {
              title: '操作', width: 110,
              render: (_: any, s: any) => (
                <Button size="small" type="primary" onClick={() => repairComplete(s.snCode)}>维修完成</Button>
              ),
            },
          ]}
        />
      </Card>
    </PageContainer>
  );
}
