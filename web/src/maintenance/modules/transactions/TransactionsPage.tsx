// 流水记录页（移植 js/ui/transactions.js）：筛选/排序/双视图/导出/删除冲正
import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Button, Card, Col, DatePicker, Empty, Flex, Input, Pagination, Radio, Row,
  Select, Space, Statistic, Table, Tag, Tooltip, Typography, message,
} from 'antd';
import {
  AppstoreOutlined, DeleteOutlined, DownloadOutlined, PaperClipOutlined, TableOutlined,
} from '@ant-design/icons';
import dayjs, { Dayjs } from 'dayjs';
import { PageContainer } from '@common/components/PageContainer';
import { useTransactions, useInventoryConfig } from '@common/hooks/useData';
import { useAuthStore, isAdmin } from '@common/stores/auth';
import { equipmentLabel, formatTime } from '@common/utils/format';
import { useDeleteTransaction, exportTransactionsCSV } from './txActions';

const { RangePicker } = DatePicker;

export default function TransactionsPage() {
  const [searchParams] = useSearchParams();
  const { data: transactions = [], isLoading } = useTransactions();
  const inventoryConfig = useInventoryConfig();
  const user = useAuthStore(s => s.user);
  const deleteTx = useDeleteTransaction();
  const admin = isAdmin(user);

  const [equipmentType, setEquipmentType] = useState('all');
  const [direction, setDirection] = useState('all');
  const [search, setSearch] = useState(searchParams.get('q') || '');
  const [range, setRange] = useState<[Dayjs | null, Dayjs | null] | null>(null);
  const [viewMode, setViewMode] = useState<'table' | 'card'>('table');
  const [cardPage, setCardPage] = useState(1);
  const pageSize = 20;

  const filtered = useMemo(() => {
    let list = transactions;
    if (equipmentType !== 'all') list = list.filter(t => t.equipmentType === equipmentType);
    if (direction !== 'all') list = list.filter(t => t.direction === direction);
    if (range && range[0]) {
      const from = range[0].startOf('day').valueOf();
      const to = range[1] ? range[1].endOf('day').valueOf() : Infinity;
      list = list.filter(t => {
        const ts = new Date(t.timestamp).getTime();
        return ts >= from && ts <= to;
      });
    }
    if (search.trim()) {
      const s = search.trim().toLowerCase();
      list = list.filter(t => {
        if (t.snCode && t.snCode.toLowerCase().includes(s)) return true;
        if (t.updatedBy && t.updatedBy.toLowerCase().includes(s)) return true;
        if (t.machineNumber && t.machineNumber.toLowerCase().includes(s)) return true;
        if (t.note && t.note.toLowerCase().includes(s)) return true;
        if (equipmentLabel(t.equipmentType, t.handType).toLowerCase().includes(s)) return true;
        if ((t.direction === 'in' ? '入库' : '出库').includes(s)) return true;
        if (t.handType === 'left' && '左手'.includes(s)) return true;
        if (t.handType === 'right' && '右手'.includes(s)) return true;
        return false;
      });
    }
    return list;
  }, [transactions, equipmentType, direction, search, range]);

  const inCount = filtered.filter(t => t.direction === 'in').length;
  const outCount = filtered.length - inCount;

  // 设备筛选选项：内置三类型 + 自定义库存品类（配置驱动，多品类扩展）
  const typeOptions = useMemo(() => {
    const builtin = [
      { value: 'glove', label: 'wuji手套' },
      { value: 'dexterous_hand', label: '灵巧手' },
      { value: 'gripper', label: '夹爪' },
    ];
    const defaultIds = ['left_glove', 'right_glove', 'left_dexterous_hand', 'right_dexterous_hand', 'gripper'];
    const custom = (inventoryConfig.data || [])
      .filter((c: any) => c && c.id && !defaultIds.includes(c.id))
      .map((c: any) => ({ value: c.id, label: `${c.icon || ''} ${c.name}`.trim() }));
    return [...builtin, ...custom];
  }, [inventoryConfig.data]);

  const setQuickRange = (kind: 'today' | 'week' | 'month') => {
    if (kind === 'today') setRange([dayjs().startOf('day'), dayjs()]);
    else if (kind === 'week') setRange([dayjs().startOf('week'), dayjs()]);
    else setRange([dayjs().startOf('month'), dayjs()]);
  };

  const columns: any[] = [
    { title: '时间', dataIndex: 'timestamp', width: 170, render: (v: string) => formatTime(v), sorter: (a: any, b: any) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(), defaultSortOrder: 'descend' },
    { title: '设备', dataIndex: 'equipmentType', render: (_: any, t: any) => <strong>{equipmentLabel(t.equipmentType, t.handType)}</strong>, sorter: (a: any, b: any) => String(a.equipmentType).localeCompare(String(b.equipmentType)) },
    { title: '操作', dataIndex: 'direction', width: 80, render: (v: string) => <Tag color={v === 'in' ? 'green' : 'red'}>{v === 'in' ? '入库' : '出库'}</Tag>, sorter: (a: any, b: any) => a.direction.localeCompare(b.direction) },
    {
      title: '数量', dataIndex: 'quantity', width: 80, sorter: (a: any, b: any) => (a.quantity || 0) - (b.quantity || 0),
      render: (v: number, t: any) => <strong style={{ color: t.direction === 'in' ? '#22c55e' : '#ef4444' }}>{t.direction === 'in' ? '+' : '-'}{v}</strong>,
    },
    {
      title: 'SN码', dataIndex: 'snCode', render: (v: string, t: any) => (
        <Space size={4}>
          <Typography.Text code style={{ fontSize: 12 }}>{v || '-'}</Typography.Text>
          {t.attachment && <a href={t.attachment} target="_blank" rel="noreferrer"><PaperClipOutlined /></a>}
        </Space>
      ),
    },
    { title: '机器', dataIndex: 'machineNumber', width: 90, render: (v: string) => v || '-' },
    { title: '操作人', dataIndex: 'updatedBy', width: 100, render: (v: string) => v || '-', sorter: (a: any, b: any) => String(a.updatedBy || '').localeCompare(String(b.updatedBy || '')) },
    { title: '备注', dataIndex: 'note', ellipsis: true, render: (v: string) => v || '-' },
    ...(admin ? [{
      title: '', dataIndex: 'id', width: 60,
      render: (_: any, t: any) => (
        <Tooltip title="删除并冲正库存">
          <Button type="text" danger size="small" icon={<DeleteOutlined />} onClick={() => deleteTx(t, inventoryConfig.data)} />
        </Tooltip>
      ),
    }] : []),
  ];

  const pagedCards = filtered.slice((cardPage - 1) * pageSize, cardPage * pageSize);

  return (
    <PageContainer
      title="流水记录"
      subtitle={`库存操作全量追踪 · 共 ${filtered.length} 条记录`}
      extra={
        <>
          <Button
            icon={viewMode === 'card' ? <TableOutlined /> : <AppstoreOutlined />}
            onClick={() => setViewMode(viewMode === 'card' ? 'table' : 'card')}
          >
            {viewMode === 'card' ? '表格' : '卡片'}
          </Button>
          <Button type="primary" icon={<DownloadOutlined />} onClick={() => { exportTransactionsCSV(filtered); message.success('CSV 已导出'); }}>
            导出
          </Button>
        </>
      }
    >
      {/* 统计卡片 */}
      <Row gutter={12} style={{ marginBottom: 12 }}>
        <Col span={8}><Card size="small"><Statistic title="全部记录" value={filtered.length} /></Card></Col>
        <Col span={8}><Card size="small"><Statistic title="入库记录" value={inCount} valueStyle={{ color: '#22c55e' }} /></Card></Col>
        <Col span={8}><Card size="small"><Statistic title="出库记录" value={outCount} valueStyle={{ color: '#ef4444' }} /></Card></Col>
      </Row>

      {/* 筛选栏 */}
      <Flex wrap gap={8} align="center" style={{ marginBottom: 12 }}>
        <Radio.Group value={equipmentType} onChange={e => setEquipmentType(e.target.value)} optionType="button" buttonStyle="solid">
          <Radio.Button value="all">全部设备</Radio.Button>
          {typeOptions.map(o => <Radio.Button key={o.value} value={o.value}>{o.label}</Radio.Button>)}
        </Radio.Group>
        <Select value={direction} onChange={setDirection} style={{ width: 110 }}
          options={[{ value: 'all', label: '全部操作' }, { value: 'in', label: '入库' }, { value: 'out', label: '出库' }]} />
        <Input.Search
          placeholder="搜索SN码/操作人/机器"
          allowClear
          style={{ width: 240 }}
          defaultValue={search}
          onSearch={setSearch}
          onChange={e => { if (!e.target.value) setSearch(''); }}
        />
        <RangePicker value={range as any} onChange={(v: any) => setRange(v)} allowEmpty={[false, false]} />
        <Space size={4}>
          <Button size="small" onClick={() => setQuickRange('today')}>今天</Button>
          <Button size="small" onClick={() => setQuickRange('week')}>本周</Button>
          <Button size="small" onClick={() => setQuickRange('month')}>本月</Button>
          {(search || range || equipmentType !== 'all' || direction !== 'all') && (
            <Button size="small" type="link" onClick={() => { setEquipmentType('all'); setDirection('all'); setSearch(''); setRange(null); }}>清除</Button>
          )}
        </Space>
      </Flex>

      {filtered.length === 0 && !isLoading ? (
        <Empty description="暂无流水记录" style={{ marginTop: 60 }} />
      ) : viewMode === 'table' ? (
        <Table
          rowKey="id"
          size="small"
          loading={isLoading}
          columns={columns}
          dataSource={filtered}
          pagination={{ pageSize: 20, showSizeChanger: true, showTotal: t => `共 ${t} 条` }}
        />
      ) : (
        <>
          <Row gutter={[12, 12]}>
            {pagedCards.map(t => (
              <Col key={t.id} xs={24} sm={12} md={8} lg={6}>
                <Card
                  size="small"
                  style={{ borderLeft: `3px solid ${t.direction === 'in' ? '#22c55e' : '#ef4444'}` }}
                  actions={admin ? [<Button key="del" type="link" danger size="small" onClick={() => deleteTx(t, inventoryConfig.data)}>清除</Button>] : undefined}
                >
                  <div style={{ fontWeight: 600 }}>{equipmentLabel(t.equipmentType, t.handType)}</div>
                  <div style={{ fontSize: 12, opacity: 0.75, margin: '4px 0' }}>
                    {t.snCode ? <Typography.Text code style={{ fontSize: 11 }}>{t.snCode}</Typography.Text> : '无SN码'}
                    {t.machineNumber ? ` · ${t.machineNumber}` : ''}
                  </div>
                  <Space size={12}>
                    <Tag color={t.direction === 'in' ? 'green' : 'red'}>{t.direction === 'in' ? '+' : '-'}{t.quantity}</Tag>
                    <span style={{ fontSize: 12, opacity: 0.65 }}>{formatTime(t.timestamp)}</span>
                  </Space>
                  {t.note && <div style={{ fontSize: 12, opacity: 0.7, marginTop: 8, borderTop: '1px dashed #e5e7eb', paddingTop: 8 }}>{t.note}</div>}
                  <div style={{ fontSize: 12, opacity: 0.65, marginTop: 6 }}>{t.updatedBy || '-'}</div>
                </Card>
              </Col>
            ))}
          </Row>
          <Flex justify="flex-end" style={{ marginTop: 16 }}>
            <Pagination current={cardPage} pageSize={pageSize} total={filtered.length} onChange={setCardPage} showTotal={t => `共 ${t} 条`} />
          </Flex>
        </>
      )}
    </PageContainer>
  );
}

// 路由懒加载要求默认导出（命名导出保持与其他模块一致）
export { TransactionsPage };
