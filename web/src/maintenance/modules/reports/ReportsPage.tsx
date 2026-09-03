// 报表统计页（移植 js/ui/reports.js）：日期筛选 + 周期统计卡片 + 图表 + 导出/打印
// 多品类：统计维度（内置三类型 + 自定义库存品类）由库存类型配置驱动
import { useMemo, useState } from 'react';
import { Button, Card, Col, DatePicker, Flex, Row, Space, message } from 'antd';
import { DownloadOutlined, PrinterOutlined } from '@ant-design/icons';
import ReactECharts from 'echarts-for-react';
import dayjs, { Dayjs } from 'dayjs';
import { PageContainer } from '@common/components/PageContainer';
import { useUIStore } from '@common/stores/ui';
import { useTransactions, useInventory, useMachines, useInventoryConfig } from '@common/hooks/useData';
import { latestMachineByNumber } from '@common/utils/domain';

const { RangePicker } = DatePicker;

interface Category { key: string; label: string }

function calcStats(txs: any[], categories: Category[]) {
  const byCat: Record<string, { in: number; out: number }> = {};
  for (const c of categories) {
    byCat[c.key] = {
      in: txs.filter(t => t.equipmentType === c.key && t.direction === 'in').reduce((s, t) => s + (Number(t.quantity) || 0), 0),
      out: txs.filter(t => t.equipmentType === c.key && t.direction === 'out').reduce((s, t) => s + (Number(t.quantity) || 0), 0),
    };
  }
  return { byCat, total: txs.length };
}

function ReportCard({ title, stats, categories }: { title: string; stats: ReturnType<typeof calcStats>; categories: Category[] }) {
  const rows: [string, number][] = categories.flatMap(c => ([
    [`${c.label}入库`, stats.byCat[c.key].in],
    [`${c.label}出库`, stats.byCat[c.key].out],
  ] as [string, number][]));
  rows.push(['总操作次数', stats.total]);
  return (
    <Card size="small" title={title}>
      {rows.map(([label, value]) => (
        <Flex key={label} justify="space-between" style={{ padding: '3px 0', fontSize: 13 }}>
          <span>{label}</span>
          <strong>{value}</strong>
        </Flex>
      ))}
    </Card>
  );
}

export default function ReportsPage() {
  const dark = useUIStore(s => s.theme === 'dark');
  const { data: allTxs = [] } = useTransactions();
  const { data: inventory = [] } = useInventory();
  const { data: machines = [] } = useMachines();
  const inventoryConfig = useInventoryConfig();
  const [range, setRange] = useState<[Dayjs | null, Dayjs | null] | null>(null);

  // 统计品类：内置三类型（equipmentType 口径）+ 自定义库存品类
  const categories = useMemo<Category[]>(() => {
    const builtin: Category[] = [
      { key: 'glove', label: '手套' },
      { key: 'dexterous_hand', label: '灵巧手' },
      { key: 'gripper', label: 'Pika夹爪' },
    ];
    const defaultIds = ['left_glove', 'right_glove', 'left_dexterous_hand', 'right_dexterous_hand', 'gripper'];
    const custom = ((inventoryConfig.data || []) as any[])
      .filter(c => c && c.id && !defaultIds.includes(c.id))
      .map(c => ({ key: c.id, label: c.name || c.id }));
    return [...builtin, ...custom];
  }, [inventoryConfig.data]);

  // 日期筛选（含当天）
  const transactions = useMemo(() => {
    let list = allTxs;
    if (range && range[0]) {
      const from = range[0].startOf('day').valueOf();
      list = list.filter(t => new Date(t.timestamp).getTime() >= from);
    }
    if (range && range[1]) {
      const to = range[1].endOf('day').valueOf();
      list = list.filter(t => new Date(t.timestamp).getTime() <= to);
    }
    return list;
  }, [allTxs, range]);

  const allStats = useMemo(() => calcStats(transactions, categories), [transactions, categories]);

  const periodStats = useMemo(() => {
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    const weekStart = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    return {
      today: calcStats(transactions.filter(t => t.timestamp >= todayStart), categories),
      week: calcStats(transactions.filter(t => t.timestamp >= weekStart), categories),
      month: calcStats(transactions.filter(t => t.timestamp >= monthStart), categories),
    };
  }, [transactions, categories]);

  const barOption = useMemo(() => ({
    tooltip: { trigger: 'axis' },
    grid: { left: 40, right: 16, top: 24, bottom: 40 },
    xAxis: { type: 'category', data: categories.flatMap(c => [`${c.label}入库`, `${c.label}出库`]), axisLabel: { fontSize: 11 } },
    yAxis: { type: 'value' },
    series: [{
      name: '数量', type: 'bar', itemStyle: { color: dark ? '#fafafa' : '#0a0a0a', borderRadius: [4, 4, 0, 0] },
      data: categories.flatMap(c => [allStats.byCat[c.key].in, allStats.byCat[c.key].out]),
    }],
  }), [allStats, categories, dark]);

  const lineOption = useMemo(() => {
    const days: string[] = [];
    const now = new Date();
    for (let i = 29; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      days.push(d.toISOString().slice(0, 10));
    }
    const data = days.map(day => transactions.filter(t => String(t.timestamp).startsWith(day)).length);
    return {
      tooltip: { trigger: 'axis' },
      grid: { left: 40, right: 16, top: 24, bottom: 40 },
      xAxis: { type: 'category', data: days.map(d => d.slice(5)), axisLabel: { fontSize: 10 } },
      yAxis: { type: 'value' },
      series: [{ name: '操作次数', type: 'line', smooth: true, data, lineStyle: { color: '#0891b2' }, itemStyle: { color: '#0891b2' }, areaStyle: { opacity: 0.08 } }],
    };
  }, [transactions]);

  const setQuickRange = (kind: 'today' | 'week' | 'month' | 'all') => {
    if (kind === 'all') { setRange(null); return; }
    if (kind === 'today') setRange([dayjs().startOf('day'), dayjs()]);
    else if (kind === 'week') setRange([dayjs().subtract(7, 'day'), dayjs()]);
    else setRange([dayjs().startOf('month'), dayjs()]);
  };

  const exportCSV = () => {
    const rows = [
      '指标,数量',
      ...categories.flatMap(c => [
        `${c.label}入库,${allStats.byCat[c.key].in}`,
        `${c.label}出库,${allStats.byCat[c.key].out}`,
      ]),
      `总操作次数,${allStats.total}`,
    ];
    const blob = new Blob([`\uFEFF${rows.join('\n')}`], { type: 'text/csv;charset=utf-8;' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `报表统计-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
    message.success('报表CSV导出成功');
  };

  // 打印（移植 printReports：新窗口输出库存 + 操作统计表；品类维度配置驱动）
  const printReports = () => {
    const invOf = (type: string) => inventory.find(i => i.type === type)?.quantity ?? 0;
    const latestMap = latestMachineByNumber(machines);
    const totalMachines = Object.keys(latestMap).length;
    const onlineCount = Object.values(latestMap).filter((m: any) => m.status === 'online').length;
    const s = { today: periodStats.today, week: periodStats.week, month: periodStats.month, all: allStats };
    // 库存列：内置5类型 + 自定义品类（区分左右手的拆两列）
    const builtinIds = ['left_glove', 'right_glove', 'left_dexterous_hand', 'right_dexterous_hand', 'gripper'];
    const builtinInvCols: [string, string][] = [
      ['left_glove', '左手手套'], ['right_glove', '右手手套'],
      ['left_dexterous_hand', '左手灵巧手'], ['right_dexterous_hand', '右手灵巧手'], ['gripper', '夹爪(Pika)'],
    ];
    const customInvCols: [string, string][] = ((inventoryConfig.data || []) as any[])
      .filter(c => c && c.id && !builtinIds.includes(c.id))
      .flatMap(c => c.hasLeftRight
        ? ([[`${c.id}_left`, `${c.name}左手`], [`${c.id}_right`, `${c.name}右手`]] as [string, string][])
        : ([[c.id, c.name || c.id]] as [string, string][]));
    const invCols = [...builtinInvCols, ...customInvCols];
    const metricRow = (label: string, catKey: string, dir: 'in' | 'out') =>
      `<tr><td>${label}</td><td>${s.today.byCat[catKey][dir]}</td><td>${s.week.byCat[catKey][dir]}</td><td>${s.month.byCat[catKey][dir]}</td><td>${s.all.byCat[catKey][dir]}</td></tr>`;
    const printHtml = `
      <html><head><meta charset="utf-8"><title>报表统计</title>
      <style>
        body { font-family: "Microsoft YaHei", sans-serif; padding: 20px 30px; color: #1a1a1a; font-size: 13px; }
        h1 { text-align: center; font-size: 20px; margin-bottom: 4px; }
        .subtitle { text-align: center; font-size: 11px; color: #888; margin-bottom: 20px; }
        table { border-collapse: collapse; width: 100%; margin-bottom: 16px; }
        th, td { border: 1px solid #ccc; padding: 6px 8px; font-size: 11px; }
        th { background: #f0f0f0; font-weight: 600; }
        .section { margin-bottom: 20px; }
        .section h3 { font-size: 14px; border-bottom: 2px solid #333; padding-bottom: 4px; margin-bottom: 8px; }
        @media print { body { padding: 0; } }
      </style></head>
      <body>
        <h1>运维系统 · 报表统计</h1>
        <p class="subtitle">打印时间: ${new Date().toLocaleString()}</p>
        <div class="section"><h3>当前库存</h3>
          <table><tr>${invCols.map(([, l]) => `<th>${l}</th>`).join('')}<th>在线机器</th><th>总机器数</th></tr>
            <tr>${invCols.map(([t]) => `<td>${invOf(t)}</td>`).join('')}<td>${onlineCount}</td><td>${totalMachines}</td></tr>
          </table>
        </div>
        <div class="section"><h3>操作统计</h3>
          <table>
            <tr><th>指标</th><th>今日</th><th>近7天</th><th>本月</th><th>总计</th></tr>
            ${categories.flatMap(c => [metricRow(`${c.label}入库`, c.key, 'in'), metricRow(`${c.label}出库`, c.key, 'out')]).join('\n')}
            <tr><th>总操作次数</th><th>${s.today.total}</th><th>${s.week.total}</th><th>${s.month.total}</th><th>${s.all.total}</th></tr>
          </table>
        </div>
      </body></html>`;
    const w = window.open('', '_blank', 'width=900,height=700');
    if (!w) { message.error('弹窗被拦截，无法打印'); return; }
    w.document.write(printHtml);
    w.document.close();
    setTimeout(() => w.print(), 500);
  };

  return (
    <PageContainer
      title="📊 报表统计"
      subtitle="设备出入库统计与操作趋势"
      extra={
        <>
          <Button icon={<PrinterOutlined />} onClick={printReports}>打印</Button>
          <Button type="primary" icon={<DownloadOutlined />} onClick={exportCSV}>导出CSV</Button>
        </>
      }
    >
      {/* 日期筛选 */}
      <Flex wrap gap={8} align="center" style={{ marginBottom: 12 }}>
        <RangePicker value={range as any} onChange={(v: any) => setRange(v)} allowClear />
        <Space size={4}>
          <Button size="small" onClick={() => setQuickRange('today')}>今天</Button>
          <Button size="small" onClick={() => setQuickRange('week')}>本周</Button>
          <Button size="small" onClick={() => setQuickRange('month')}>本月</Button>
          <Button size="small" onClick={() => setQuickRange('all')}>全部</Button>
        </Space>
      </Flex>

      {/* 周期统计卡片 */}
      <Row gutter={[12, 12]} style={{ marginBottom: 12 }}>
        <Col xs={24} sm={12} lg={6}><ReportCard title="今日" stats={periodStats.today} categories={categories} /></Col>
        <Col xs={24} sm={12} lg={6}><ReportCard title="近7天" stats={periodStats.week} categories={categories} /></Col>
        <Col xs={24} sm={12} lg={6}><ReportCard title="本月" stats={periodStats.month} categories={categories} /></Col>
        <Col xs={24} sm={12} lg={6}><ReportCard title="总计 (筛选范围内)" stats={allStats} categories={categories} /></Col>
      </Row>

      {/* 图表 */}
      <Row gutter={[12, 12]}>
        <Col xs={24} lg={12}>
          <Card size="small" title="各设备出入库统计">
            <ReactECharts option={barOption} style={{ height: 300 }} />
          </Card>
        </Col>
        <Col xs={24} lg={12}>
          <Card size="small" title="每日操作趋势（近30天）">
            <ReactECharts option={lineOption} style={{ height: 300 }} />
          </Card>
        </Col>
      </Row>
    </PageContainer>
  );
}
