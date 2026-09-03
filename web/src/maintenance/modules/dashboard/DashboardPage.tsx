// 系统总览页（移植 js/ui/dashboard.js）：可拖拽统计卡片 + 利用率 + 图表 + 最近流水 + 快捷操作
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Card, Col, Flex, Input, List, Modal, Progress, Row, Space, Statistic, Table, Tag, Typography, message } from 'antd';
import { ReloadOutlined, FileTextOutlined, HolderOutlined, DownloadOutlined, InboxOutlined } from '@ant-design/icons';
import ReactECharts from 'echarts-for-react';
import { useQueryClient } from '@tanstack/react-query';
import dayjs from 'dayjs';
import { PageContainer } from '@common/components/PageContainer';
import { useInventory, useMachines, useTransactions, useSNRegistry, useSettings, useInventoryConfig } from '@common/hooks/useData';
import { statusCountsFor } from '@common/hooks/useInventoryStats';
import { useAuthStore } from '@common/stores/auth';
import { useUIStore } from '@common/stores/ui';
import * as api from '@common/api';
import { latestMachineByNumber, buildEffectiveStatusMap, typeLabelOf, trackingModeOf } from '@common/utils/domain';
import { equipmentLabel, formatTime, cumulativeSum } from '@common/utils/format';
import { QuickInOutModal } from '../inventory/inventoryModals';

const DEFAULT_CARDS = ['totalGloves', 'totalDexterous', 'left_glove', 'right_glove', 'left_dexterous_hand', 'right_dexterous_hand', 'gripper', 'onlineMachines', 'todayTransactions', 'transferredGloves'];
const SPECIAL_CARDS = new Set(['totalGloves', 'totalDexterous', 'damagedGloves', 'inRepairGloves', 'onlineMachines', 'todayTransactions', 'transferredGloves']);

export default function DashboardPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const inventory = useInventory();
  const machines = useMachines();
  const transactions = useTransactions();
  const snRegistry = useSNRegistry();
  const settings = useSettings();
  const inventoryConfig = useInventoryConfig();
  const user = useAuthStore(s => s.user);
  const dark = useUIStore(s => s.theme === 'dark');

  const [quickOpen, setQuickOpen] = useState<{ type: string; direction: 'in' | 'out' } | null>(null);
  const [todayOpen, setTodayOpen] = useState(false);
  const [onlineOpen, setOnlineOpen] = useState(false);
  const [transferOpen, setTransferOpen] = useState(false);
  const [allInvOpen, setAllInvOpen] = useState(false);
  const [quickLRText, setQuickLRText] = useState('');
  const [breakdownType, setBreakdownType] = useState<string | null>(null);
  const [dragCard, setDragCard] = useState<string | null>(null);

  const txs = transactions.data || [];
  const registry = snRegistry.data || [];
  const invMap = useMemo(() => {
    const map: Record<string, any> = {};
    (inventory.data || []).forEach((it: any) => { map[it.type] = it; });
    return map;
  }, [inventory.data]);

  // 卡片配置（确保 transferredGloves 始终存在）
  const cards = useMemo(() => {
    const list = [...((settings.data as any)?.dashboardCards || DEFAULT_CARDS)];
    if (!list.includes('transferredGloves')) list.push('transferredGloves');
    return list;
  }, [settings.data]);

  // ===== 库存汇总统计 =====
  const stats = useMemo(() => {
    const builtinLeftRight = ['left_glove', 'right_glove', 'left_dexterous_hand', 'right_dexterous_hand'];
    const sum = (types: string[]) => {
      let left = 0, right = 0, damaged = 0, repair = 0;
      types.forEach(t => {
        const c = statusCountsFor(t, registry);
        const total = c.available + c.inUse + c.damaged;
        if (t.startsWith('left')) left += total; else right += total;
        damaged += c.damaged;
        repair += c.inRepair;
      });
      return { left, right, damaged, repair };
    };
    const glove = sum(['left_glove', 'right_glove']);
    const dex = sum(['left_dexterous_hand', 'right_dexterous_hand']);
    // 自定义左右手类型
    let leftTotal = glove.left + dex.left, rightTotal = glove.right + dex.right;
    let damagedAll = glove.damaged + dex.damaged, repairAll = glove.repair + dex.repair;
    (inventoryConfig.data || []).filter((c: any) => c.hasLeftRight && !builtinLeftRight.includes(c.id)).forEach((c: any) => {
      const lc = statusCountsFor(`${c.id}_left`, registry);
      const rc = statusCountsFor(`${c.id}_right`, registry);
      leftTotal += lc.available + lc.inUse + lc.damaged;
      rightTotal += rc.available + rc.inUse + rc.damaged;
      damagedAll += lc.damaged + rc.damaged;
      repairAll += lc.inRepair + rc.inRepair;
    });
    const transferred = registry.filter(s => s.status === 'transferred').length;
    return { glove, dex, leftTotal, rightTotal, damagedAll, repairAll, transferred };
  }, [registry, inventoryConfig.data]);

  // ===== 机器统计 =====
  const latestMap = useMemo(() => latestMachineByNumber(machines.data || []), [machines.data]);
  const totalMachines = Object.keys(latestMap).length;
  const effectiveMap = useMemo(() => buildEffectiveStatusMap(Object.values(latestMap), registry), [latestMap, registry]);
  const onlineCount = Object.values(effectiveMap).filter(s => s === 'online').length;
  const todayTx = useMemo(() => {
    const start = dayjs().startOf('day').valueOf();
    return txs.filter(t => new Date(t.timestamp).getTime() >= start);
  }, [txs]);

  const utilPct = totalMachines > 0 ? Math.round((onlineCount / totalMachines) * 100) : 0;
  const utilColor = utilPct >= 60 ? '#10b981' : utilPct >= 30 ? '#f59e0b' : '#ef4444';

  // ===== 图表配置 =====
  const trendOption = useMemo(() => {
    const days: string[] = [];
    for (let i = 6; i >= 0; i--) days.push(dayjs().subtract(i, 'day').format('YYYY-MM-DD'));
    const series = (hand: 'left' | 'right') => cumulativeSum(days.map(day =>
      txs.filter(t => t.equipmentType === 'glove' && t.handType === hand && String(t.timestamp).startsWith(day))
        .reduce((s, t) => s + (t.direction === 'in' ? t.quantity : -t.quantity), 0)));
    return {
      tooltip: { trigger: 'axis' },
      legend: { data: ['左手手套', '右手手套'] },
      grid: { left: 40, right: 16, top: 36, bottom: 24 },
      xAxis: { type: 'category', data: days.map(d => d.slice(5)) },
      yAxis: { type: 'value' },
      series: [
        { name: '左手手套', type: 'line', smooth: true, data: series('left'), itemStyle: { color: dark ? '#fafafa' : '#0a0a0a' } },
        { name: '右手手套', type: 'line', smooth: true, data: series('right'), itemStyle: { color: '#a3a3a3' } },
      ],
    };
  }, [txs, dark]);

  const pieOption = useMemo(() => ({
    tooltip: { trigger: 'item' },
    legend: { bottom: 0 },
    series: [{
      type: 'pie', radius: ['40%', '65%'],
      data: [
        { name: '在线', value: onlineCount, itemStyle: { color: '#22c55e' } },
        { name: '离线', value: Math.max(0, totalMachines - onlineCount), itemStyle: { color: '#ef4444' } },
      ],
      label: { formatter: '{b}: {c}' },
    }],
  }), [onlineCount, totalMachines]);

  // ===== 卡片拖拽排序 =====
  const onDropCard = async (targetType: string) => {
    if (!dragCard || dragCard === targetType) return;
    const next = [...cards];
    const from = next.indexOf(dragCard), to = next.indexOf(targetType);
    if (from < 0 || to < 0) return;
    next.splice(from, 1);
    next.splice(to, 0, dragCard);
    setDragCard(null);
    await api.saveSettings({ ...(settings.data || {}), dashboardCards: next }).catch(() => {});
    qc.invalidateQueries({ queryKey: ['settings'] });
  };

  // ===== 卡片渲染 =====
  const renderCard = (cardType: string) => {
    let content: React.ReactNode = null;
    let onClick: (() => void) | undefined;
    let title = '';

    if (cardType === 'totalGloves') {
      title = '手套总数';
      content = <Statistic value={stats.glove.left + stats.glove.right} suffix="只" />;
      onClick = () => setAllInvOpen(true);
    } else if (cardType === 'totalDexterous') {
      title = '灵巧手总数';
      content = <Statistic value={stats.dex.left + stats.dex.right} suffix="只" />;
      onClick = () => setAllInvOpen(true);
    } else if (cardType === 'damagedGloves') {
      title = '损坏设备';
      content = <Statistic value={stats.damagedAll} valueStyle={{ color: '#f59e0b' }} />;
      onClick = () => navigate('/after-sales');
    } else if (cardType === 'inRepairGloves') {
      title = '售后中设备';
      content = <Statistic value={stats.repairAll} valueStyle={{ color: '#f59e0b' }} />;
      onClick = () => navigate('/after-sales');
    } else if (cardType === 'onlineMachines') {
      title = '在线机器数量';
      content = <Statistic value={onlineCount} suffix="台" />;
      onClick = () => setOnlineOpen(true);
    } else if (cardType === 'todayTransactions') {
      title = '今日操作记录';
      content = <Statistic value={todayTx.length} suffix="条" />;
      onClick = () => setTodayOpen(true);
    } else if (cardType === 'transferredGloves') {
      title = '调出手套';
      content = <Statistic value={stats.transferred} suffix="只" />;
      onClick = () => setTransferOpen(true);
    } else {
      // 库存类型卡片：SN 类型显示空闲数量，纯数量类型直接显示库存量
      const isQty = trackingModeOf(cardType, inventoryConfig.data) === 'quantity';
      const counts = statusCountsFor(cardType, registry);
      const inv = invMap[cardType] || {};
      title = isQty ? `${typeLabelOf(cardType, inventoryConfig.data)}库存` : `${typeLabelOf(cardType, inventoryConfig.data)}库存 (空闲)`;
      content = <Statistic value={isQty ? (inv.quantity ?? 0) : counts.available} suffix={isQty ? '件' : undefined} />;
      onClick = () => setBreakdownType(cardType);
      return (
        <Card key={cardType} size="small" hoverable draggable
          onDragStart={() => setDragCard(cardType)} onDragEnd={() => setDragCard(null)}
          onDragOver={e => e.preventDefault()} onDrop={() => onDropCard(cardType)}
          onClick={onClick} style={{ opacity: dragCard === cardType ? 0.4 : 1 }}
        >
          <Card.Meta
            title={<Space size={4}>{title}<HolderOutlined style={{ opacity: 0.35, fontSize: 12 }} /></Space>}
            description={
              <div>
                {content}
                <div style={{ fontSize: 12, opacity: 0.6, marginTop: 6 }}>
                  {inv.updatedBy ? `更新人: ${inv.updatedBy}` : '暂无记录'}
                  {!isQty && (counts.damaged > 0 || counts.inRepair > 0) ? ` | 损坏:${counts.damaged} 售后:${counts.inRepair}` : ''}
                  {isQty ? ' | 数量跟踪' : ''}
                </div>
              </div>
            }
          />
        </Card>
      );
    }

    let footer = '';
    if (cardType === 'totalGloves') footer = `左手${stats.glove.left}只 · 右手${stats.glove.right}只`;
    else if (cardType === 'totalDexterous') footer = `左手${stats.dex.left}只 · 右手${stats.dex.right}只`;
    else if (cardType === 'damagedGloves') footer = `手套${stats.glove.damaged}只 · 灵巧手${stats.dex.damaged}只 | 待售后处理`;
    else if (cardType === 'inRepairGloves') footer = `手套${stats.glove.repair}只 · 灵巧手${stats.dex.repair}只 | 已发回厂家维修`;
    else if (cardType === 'onlineMachines') footer = '点击查看详情';
    else if (cardType === 'todayTransactions') footer = `共 ${txs.length} 条历史记录`;
    else if (cardType === 'transferredGloves') footer = '外部场地使用中';

    return (
      <Card key={cardType} size="small" hoverable draggable
        onDragStart={() => setDragCard(cardType)} onDragEnd={() => setDragCard(null)}
        onDragOver={e => e.preventDefault()} onDrop={() => onDropCard(cardType)}
        onClick={onClick} style={{ opacity: dragCard === cardType ? 0.4 : 1 }}
      >
        <Card.Meta
          title={<Space size={4}>{title}<HolderOutlined style={{ opacity: 0.35, fontSize: 12 }} /></Space>}
          description={
            <div>
              {content}
              <div style={{ fontSize: 12, opacity: 0.6, marginTop: 6 }}>{footer}</div>
            </div>
          }
        />
      </Card>
    );
  };

  // ===== 快捷操作按钮 =====
  const quickActions = cards.filter(c => !SPECIAL_CARDS.has(c));

  // 最近流水小表
  const recentColumns: any[] = [
    { title: '时间', dataIndex: 'timestamp', width: 150, render: (v: string) => <span style={{ fontSize: 12 }}>{formatTime(v)}</span> },
    { title: '设备', dataIndex: 'equipmentType', render: (_: any, t: any) => <span style={{ fontSize: 12 }}>{equipmentLabel(t.equipmentType, t.handType)}</span> },
    { title: '操作', dataIndex: 'direction', width: 64, render: (v: string) => <Tag color={v === 'in' ? 'green' : 'red'}>{v === 'in' ? '入库' : '出库'}</Tag> },
    { title: '数量', dataIndex: 'quantity', width: 56 },
    { title: 'SN码', dataIndex: 'snCode', ellipsis: true, render: (v: string) => <Typography.Text code style={{ fontSize: 11 }}>{v || '-'}</Typography.Text> },
    { title: '操作人', dataIndex: 'updatedBy', width: 90, render: (v: string) => v || '-' },
  ];

  const breakdownCounts = breakdownType ? statusCountsFor(breakdownType, registry) : null;
  const breakdownInv = breakdownType ? invMap[breakdownType] || {} : {};

  // 快速左/右手入库：L/R 前缀=手套，QL/QR 前缀=灵巧手（移植 _quickLRInbound）
  const quickLRInbound = async () => {
    const lines = quickLRText.split(/[\n\r\s,;]+/).filter(Boolean);
    if (lines.length === 0) { message.error('请输入SN码'); return; }
    const username = user?.username || '系统';
    const existingSns = new Set(registry.map(r => r.snCode));
    let count = 0; let dupCount = 0;
    const errors: string[] = [];
    for (const raw of lines) {
      const code = raw.trim().toUpperCase();
      if (code.length < 2) continue;
      let hand: string, eqType: string;
      if (code.startsWith('QL')) { hand = 'left'; eqType = 'dexterous_hand'; }
      else if (code.startsWith('QR')) { hand = 'right'; eqType = 'dexterous_hand'; }
      else if (code[0] === 'L' || code[0] === 'R') { hand = code[0] === 'L' ? 'left' : 'right'; eqType = 'glove'; }
      else { errors.push(`${code}(无效格式)`); continue; }
      if (existingSns.has(code)) { errors.push(`${code}(SN重复)`); dupCount++; continue; }
      try {
        // 库存由服务端 upsertSNRegistry 后从注册表自动重算；
        // 前端不可再调 adjustInventory(+1)（它会额外创建一只 ADJ- 占位 SN，导致库存双计）
        await api.addTransaction({ equipmentType: eqType, handType: hand, direction: 'in', quantity: 1, snCode: code, updatedBy: username, note: '快速入库' });
        await api.upsertSNRegistry({ snCode: code, equipmentType: eqType, handType: hand, status: 'available', machineNumber: '', damageReason: '' }).catch(() => {});
        existingSns.add(code);
        count++;
      } catch (e) {
        errors.push(`${code}(${(e as Error).message})`);
      }
    }
    qc.invalidateQueries({ queryKey: ['inventory'] });
    qc.invalidateQueries({ queryKey: ['transactions'] });
    qc.invalidateQueries({ queryKey: ['sn-registry'] });
    if (count > 0) {
      message.success(`成功入库 ${count} 只${dupCount > 0 ? `，跳过${dupCount}条重复` : ''}${errors.length ? `，${errors.join(', ')}` : ''}`);
      setQuickLRText('');
    } else {
      message.error(errors.join(', ') || '入库失败');
    }
  };

  // 导出全部库存 CSV（移植 _exportAllSNExcel）
  const exportAllSNCSV = () => {
    const eqLabels: Record<string, string> = { glove: '手套', dexterous_hand: '灵巧手', gripper: '夹爪' };
    const rows = registry.filter(r => r.status !== '_deleted').map(r => {
      const handLabel = r.handType === 'left' ? '左手' : r.handType === 'right' ? '右手' : '';
      let eqLabel = eqLabels[r.equipmentType] || r.equipmentType || '-';
      if (handLabel) eqLabel = handLabel + eqLabel;
      const statusLabel: Record<string, string> = { available: '可用', in_use: '使用中', damaged: '损坏', in_repair: '售后维修中', transferred: '已调出' };
      return [formatTime(r.updatedAt), eqLabel, r.snCode, statusLabel[r.status] || r.status || '-', r.machineNumber || '', r.updatedBy || ''];
    });
    const header = ['时间', '设备类型', 'SN码', '状态', '机器编号', '更新人'];
    const csv = '\ufeff' + [header, ...rows].map(row => row.map(c => `"${String(c || '').replace(/"/g, '""')}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `全部库存-${dayjs().format('YYYY-MM-DD')}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    message.success('CSV 已导出');
  };

  return (
    <PageContainer
      title="系统总览"
      subtitle={`实时数据概览 · 更新于 ${dayjs().format('HH:mm:ss')}`}
      extra={
        <>
          <Button icon={<ReloadOutlined />} onClick={() => { qc.invalidateQueries(); }}>刷新</Button>
          <Button type="primary" icon={<FileTextOutlined />} onClick={() => setTodayOpen(true)}>今日操作</Button>
        </>
      }
    >
      {/* 可拖拽统计卡片 */}
      <Row gutter={[12, 12]} style={{ marginBottom: 8 }}>
        {cards.map(c => <Col key={c} xs={12} sm={8} md={6} style={{ minWidth: 0 }}>{renderCard(c)}</Col>)}
      </Row>
      <div style={{ fontSize: 12, opacity: 0.5, marginBottom: 12 }}>⋮⋮ 提示：卡片可拖动调整位置</div>

      {/* 机器利用率 */}
      <Card size="small" style={{ marginBottom: 12 }}>
        <Flex justify="space-between" style={{ marginBottom: 4 }}>
          <span>机器利用率</span>
          <span>{onlineCount}/{totalMachines} 台在线 · <b style={{ color: utilColor }}>{utilPct}%</b></span>
        </Flex>
        <Progress percent={utilPct} showInfo={false} strokeColor={utilColor} />
      </Card>

      <Row gutter={[12, 12]}>
        <Col xs={24} lg={12}>
          <Card size="small" title="库存趋势" extra={<span style={{ fontSize: 12, opacity: 0.6 }}>近7天</span>}>
            <ReactECharts option={trendOption} style={{ height: 240 }} />
          </Card>
        </Col>
        <Col xs={24} lg={12}>
          <Card size="small" title="机器状态分布" extra={<span style={{ fontSize: 12, opacity: 0.6 }}>实时</span>}>
            <ReactECharts option={pieOption} style={{ height: 240 }} />
          </Card>
        </Col>
        <Col xs={24} lg={12}>
          <Card size="small" title="最近操作记录" extra={<span style={{ fontSize: 12, opacity: 0.6 }}>最新 8 条</span>}>
            <Table rowKey="id" size="small" columns={recentColumns} dataSource={txs.slice(0, 8)} pagination={false} />
          </Card>
        </Col>
        <Col xs={24} lg={12}>
          <Card size="small" title="快捷操作" extra={<span style={{ fontSize: 12, opacity: 0.6 }}>常用功能</span>}>
            <Flex wrap gap={8}>
              {quickActions.map(c => (
                <Space.Compact key={c}>
                  <Button size="small" type="primary" onClick={() => setQuickOpen({ type: c, direction: 'in' })}>
                    {typeLabelOf(c, inventoryConfig.data)} +入库
                  </Button>
                  <Button size="small" type="primary" onClick={() => setQuickOpen({ type: c, direction: 'out' })}>
                    -出库
                  </Button>
                </Space.Compact>
              ))}
              <Button size="small" color="orange" variant="solid" onClick={() => navigate('/machines')}>机器管理 →</Button>
              <Button size="small" onClick={() => navigate('/transactions')}>流水记录 →</Button>
            </Flex>
          </Card>
        </Col>
      </Row>

      {/* 快速出入库 */}
      <QuickInOutModal
        open={!!quickOpen}
        type={quickOpen?.type || 'left_glove'}
        initialDirection={quickOpen?.direction || 'in'}
        inventoryConfig={inventoryConfig.data}
        mode={quickOpen ? trackingModeOf(quickOpen.type, inventoryConfig.data) : 'sn'}
        onClose={() => setQuickOpen(null)}
      />

      {/* 今日操作 */}
      <Modal title="今日操作记录" open={todayOpen} onCancel={() => setTodayOpen(false)} footer={null} width={640}>
        <Row gutter={12} style={{ marginBottom: 12 }}>
          <Col span={8}><Statistic title="今日操作" value={todayTx.length} suffix="条" /></Col>
          <Col span={8}><Statistic title="入库" value={todayTx.filter(t => t.direction === 'in').length} valueStyle={{ color: '#22c55e' }} /></Col>
          <Col span={8}><Statistic title="出库" value={todayTx.filter(t => t.direction === 'out').length} valueStyle={{ color: '#ef4444' }} /></Col>
        </Row>
        <Table rowKey="id" size="small" columns={recentColumns} dataSource={todayTx.slice(0, 15)} pagination={false} />
        <Flex justify="flex-end" style={{ marginTop: 12 }}>
          <Button onClick={() => { setTodayOpen(false); navigate('/transactions'); }}>查看全部流水 →</Button>
        </Flex>
      </Modal>

      {/* 在线机器详情 */}
      <Modal title="在线机器详情" open={onlineOpen} onCancel={() => setOnlineOpen(false)} footer={null}>
        {(() => {
          const online = Object.entries(latestMap).filter(([, m]) => m.status === 'online');
          const byType: Record<string, string[]> = {};
          online.forEach(([num, m]) => { (byType[m.deviceType || 'glove'] = byType[m.deviceType || 'glove'] || []).push(num); });
          return (
            <div>
              <div style={{ marginBottom: 12 }}>在线机器共 <b>{online.length}</b> 台</div>
              <List
                size="small" bordered
                dataSource={Object.entries(byType)}
                renderItem={([type, nums]) => (
                  <List.Item>
                    <span>{(inventoryConfig.data || []).find((c: any) => c.id === type)?.name || type}</span>
                    <span><b>{nums.length}</b> 台 · {nums.join(', ')}</span>
                  </List.Item>
                )}
                locale={{ emptyText: '暂无在线机器' }}
              />
              <div style={{ marginTop: 12, fontSize: 12, opacity: 0.6 }}>
                总机器数: {totalMachines} 台 | 利用率: {utilPct}%
              </div>
            </div>
          );
        })()}
      </Modal>

      {/* 调出手套 */}
      <Modal title="调出手套详情" open={transferOpen} onCancel={() => setTransferOpen(false)} footer={null} width={640}>
        <Table
          rowKey="snCode" size="small"
          dataSource={registry.filter(r => r.status === 'transferred')}
          pagination={{ pageSize: 15 }}
          columns={[
            { title: 'SN码', dataIndex: 'snCode', render: (v: string) => <Typography.Text code>{v}</Typography.Text> },
            { title: '设备', dataIndex: 'equipmentType', render: (_: any, r: any) => equipmentLabel(r.equipmentType, r.handType) },
            { title: '去向', dataIndex: 'trackingNumber', render: (v: string, r: any) => v || r.damageReason || '-' },
            { title: '时间', dataIndex: 'updatedAt', render: (v: string) => formatTime(v) },
          ]}
        />
      </Modal>

      {/* 全部库存明细 */}
      <Modal title="全部库存明细" open={allInvOpen} onCancel={() => setAllInvOpen(false)} footer={null} width={560}>
        <Row gutter={12} style={{ marginBottom: 12 }}>
          <Col span={12}>
            <Card size="small" style={{ textAlign: 'center' }}>
              <div style={{ fontSize: 24 }}>🧤</div>
              <b style={{ fontSize: 18 }}>手套 {stats.glove.left + stats.glove.right} 只</b>
              <div style={{ fontSize: 12, opacity: 0.6 }}>{Math.min(stats.glove.left, stats.glove.right)} 对 · 左{stats.glove.left} · 右{stats.glove.right}</div>
            </Card>
          </Col>
          <Col span={12}>
            <Card size="small" style={{ textAlign: 'center' }}>
              <div style={{ fontSize: 24 }}>🤖</div>
              <b style={{ fontSize: 18 }}>灵巧手 {stats.dex.left + stats.dex.right} 只</b>
              <div style={{ fontSize: 12, opacity: 0.6 }}>左{stats.dex.left} · 右{stats.dex.right}</div>
            </Card>
          </Col>
        </Row>
        <List
          size="small" bordered
          dataSource={['left_glove', 'right_glove', 'left_dexterous_hand', 'right_dexterous_hand',
            ...(inventoryConfig.data || []).filter((c: any) => !['left_glove', 'right_glove', 'left_dexterous_hand', 'right_dexterous_hand', 'gripper'].includes(c.id))
              .flatMap((c: any) => (c.hasLeftRight ? [`${c.id}_left`, `${c.id}_right`] : [c.id]))]}
          renderItem={(t: string) => {
            const c = statusCountsFor(t, registry);
            const isQty = trackingModeOf(t, inventoryConfig.data) === 'quantity';
            return (
              <List.Item>
                <span>{typeLabelOf(t, inventoryConfig.data)}</span>
                <span style={{ fontSize: 12 }}>
                  {isQty
                    ? `数量:${invMap[t]?.quantity ?? 0}件 · 数量跟踪`
                    : `总${c.available + c.inUse + c.damaged}只 · 空闲:${c.available} 使用:${c.inUse} 损坏:${c.damaged}${c.inRepair > 0 ? ` 售后:${c.inRepair}` : ''}`}
                </span>
              </List.Item>
            );
          }}
        />
        <Flex justify="space-between" style={{ marginTop: 12 }}>
          <Button icon={<DownloadOutlined />} onClick={exportAllSNCSV}>导出全部库存CSV</Button>
        </Flex>
        <div style={{ marginTop: 16, borderTop: '1px solid rgba(128,128,128,0.15)', paddingTop: 12 }}>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>⚡ 快速左/右手入库</div>
          <div style={{ fontSize: 12, opacity: 0.65, marginBottom: 8 }}>
            手套: <Typography.Text code>L/R+SN码</Typography.Text> · 灵巧手: <Typography.Text code>QL/QR+SN码</Typography.Text> · 支持换行/空格批量输入
          </div>
          <Input.TextArea rows={3} value={quickLRText} onChange={e => setQuickLRText(e.target.value)}
            placeholder={'RWG1K01260321284\nLWG1JA02260403004'} style={{ fontFamily: 'monospace' }} />
          <Button type="primary" size="small" icon={<InboxOutlined />} style={{ marginTop: 8 }} onClick={quickLRInbound}>快速入库</Button>
        </div>
      </Modal>

      {/* 单类型库存详情 */}
      <Modal
        title={`${breakdownType ? typeLabelOf(breakdownType, inventoryConfig.data) : ''} 库存详情`}
        open={!!breakdownType} onCancel={() => setBreakdownType(null)} footer={null} width={520}
      >
        {breakdownType && breakdownCounts && (
          <div>
            {trackingModeOf(breakdownType, inventoryConfig.data) !== 'quantity' && (
              <Flex align="center" justify="center" gap={24} style={{ margin: '8px 0 16px' }}>
                <Statistic title="空闲" value={breakdownCounts.available} valueStyle={{ color: '#22c55e' }} />
                <Statistic title="使用中" value={breakdownCounts.inUse} valueStyle={{ color: '#3b82f6' }} />
                <Statistic title="损坏" value={breakdownCounts.damaged} valueStyle={{ color: '#ef4444' }} />
                <Statistic title="售后中" value={breakdownCounts.inRepair} valueStyle={{ color: '#f59e0b' }} />
              </Flex>
            )}
            <div style={{ fontSize: 12, opacity: 0.6, textAlign: 'center', marginBottom: 12 }}>
              库存量: {breakdownInv.quantity ?? 0} · 最后更新: {formatTime(breakdownInv.updatedAt)} · 更新人: {breakdownInv.updatedBy || '无'}
            </div>
            <Flex justify="center" gap={8}>
              <Button type="primary" onClick={() => { setQuickOpen({ type: breakdownType, direction: 'in' }); setBreakdownType(null); }}>+ 入库</Button>
              <Button color="danger" variant="solid" onClick={() => { setQuickOpen({ type: breakdownType, direction: 'out' }); setBreakdownType(null); }}>- 出库</Button>
            </Flex>
          </div>
        )}
      </Modal>
    </PageContainer>
  );
}

// 路由懒加载要求默认导出
export { DashboardPage };
