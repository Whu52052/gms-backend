// SN 链接管理页（移植 js/ui/sn-qr.js）：SN 状态链接生成/筛选/导出
import { useMemo, useState } from 'react';
import {
  Button, Card, Col, DatePicker, Empty, Flex, Input, Pagination, Radio, Row, Space,
  Statistic, Tag, Typography, message,
} from 'antd';
import { CopyOutlined, DownloadOutlined, LinkOutlined } from '@ant-design/icons';
import dayjs, { Dayjs } from 'dayjs';
import { PageContainer } from '@common/components/PageContainer';
import { useSNRegistry } from '@common/hooks/useData';
import { formatTime } from '@common/utils/format';
import { copyText } from '../machine-links/MachineLinksPage';

const PAGE_SIZE = 24;

const SM: Record<string, { label: string; color: string }> = {
  available: { label: '库存可用', color: 'green' },
  in_use: { label: '使用中', color: 'blue' },
  damaged: { label: '已损坏', color: 'red' },
  in_repair: { label: '售后维修中', color: 'orange' },
  transferred: { label: '已转出', color: 'purple' },
};

const statusUrl = (sn: string) => `${window.location.origin}/sn-status.html?sn=${encodeURIComponent(sn)}`;

export default function SNQRCodesPage() {
  const { data: items = [], isLoading } = useSNRegistry();
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [inboundStart, setInboundStart] = useState<Dayjs | null>(null);
  const [inboundEnd, setInboundEnd] = useState<Dayjs | null>(null);
  const [page, setPage] = useState(1);

  const filtered = useMemo(() => {
    let list = items;
    if (filter !== 'all') list = list.filter(i => i.status === filter);
    const q = search.trim().toLowerCase();
    if (q) {
      list = list.filter(i =>
        (i.snCode && i.snCode.toLowerCase().includes(q)) ||
        (i.machineNumber && i.machineNumber.toLowerCase().includes(q)) ||
        (i.handType && i.handType.toLowerCase().includes(q)) ||
        (i.equipmentType && i.equipmentType.toLowerCase().includes(q)),
      );
    }
    // 入库时间范围筛选（闭区间，含当天）。无 inboundTime 的旧数据在指定任一端时排除
    if (inboundStart || inboundEnd) {
      const startMs = inboundStart ? inboundStart.startOf('day').valueOf() : -Infinity;
      const endMs = inboundEnd ? inboundEnd.endOf('day').valueOf() : Infinity;
      list = list.filter(i => {
        if (!i.inboundTime) return false;
        const t = new Date(i.inboundTime).getTime();
        return t >= startMs && t <= endMs;
      });
    }
    return list;
  }, [items, filter, search, inboundStart, inboundEnd]);

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: items.length, available: 0, in_use: 0, damaged: 0, in_repair: 0, transferred: 0 };
    items.forEach(i => { if (c[i.status] !== undefined) c[i.status]++; });
    return c;
  }, [items]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const curPage = Math.min(page, totalPages);
  const pageItems = filtered.slice((curPage - 1) * PAGE_SIZE, curPage * PAGE_SIZE);

  const doExport = async () => {
    try {
      const params = new URLSearchParams();
      if (filter !== 'all') params.set('status', filter);
      if (search.trim()) params.set('search', search.trim());
      if (inboundStart) params.set('inboundStart', inboundStart.format('YYYY-MM-DD'));
      if (inboundEnd) params.set('inboundEnd', inboundEnd.format('YYYY-MM-DD'));
      const qs = params.toString();
      const res = await fetch(`/api/export/sn-links-xlsx${qs ? `?${qs}` : ''}`);
      if (!res.ok) { message.error('导出失败'); return; }
      const blob = await res.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `SN链接-${dayjs().format('YYYY-MM-DD')}.xlsx`;
      a.click();
      URL.revokeObjectURL(a.href);
      message.success('导出成功');
    } catch (e: any) {
      message.error(`导出失败: ${e?.message || ''}`);
    }
  };

  const doCopy = async (sn: string) => {
    const ok = await copyText(statusUrl(sn));
    if (ok) message.success('链接已复制');
    else message.error('复制失败，请手动复制');
  };

  return (
    <PageContainer
      title="SN链接管理"
      subtitle={`共 ${filtered.length} 条${(inboundStart || inboundEnd) ? `（已筛选 ${filtered.length}/${items.length}）` : ''}`}
      extra={<Button type="primary" icon={<DownloadOutlined />} onClick={doExport}>导出Excel</Button>}
    >
      {/* 统计卡片 */}
      <Row gutter={12} style={{ marginBottom: 12 }}>
        <Col span={5}><Card size="small"><Statistic title="总数量" value={counts.all} /></Card></Col>
        <Col span={5}><Card size="small"><Statistic title="库存" value={counts.available} valueStyle={{ color: '#f59e0b' }} /></Card></Col>
        <Col span={5}><Card size="small"><Statistic title="使用中" value={counts.in_use} valueStyle={{ color: '#22c55e' }} /></Card></Col>
        <Col span={5}><Card size="small"><Statistic title="售后中" value={counts.in_repair} valueStyle={{ color: '#3b82f6' }} /></Card></Col>
        <Col span={4}><Card size="small"><Statistic title="已损坏" value={counts.damaged} valueStyle={{ color: '#ef4444' }} /></Card></Col>
      </Row>

      {/* 筛选栏 */}
      <Flex wrap gap={8} align="center" style={{ marginBottom: 12 }}>
        <Radio.Group
          value={filter}
          onChange={e => { setFilter(e.target.value); setPage(1); }}
          optionType="button"
          buttonStyle="solid"
        >
          <Radio.Button value="all">全部 ({counts.all})</Radio.Button>
          <Radio.Button value="available">库存 ({counts.available})</Radio.Button>
          <Radio.Button value="in_use">使用中 ({counts.in_use})</Radio.Button>
          <Radio.Button value="in_repair">售后中 ({counts.in_repair})</Radio.Button>
          <Radio.Button value="damaged">已损坏 ({counts.damaged})</Radio.Button>
          <Radio.Button value="transferred">已转出 ({counts.transferred})</Radio.Button>
        </Radio.Group>
        <Input.Search
          placeholder="搜索SN码/机器编号/手型..."
          allowClear
          style={{ width: 240 }}
          value={search}
          onChange={e => { setSearch(e.target.value); setPage(1); }}
        />
        <Space size={4}>
          <span style={{ fontSize: 12, opacity: 0.7 }}>入库时间:</span>
          <DatePicker value={inboundStart} onChange={v => { setInboundStart(v); setPage(1); }} placeholder="开始" allowClear />
          <span style={{ opacity: 0.5 }}>至</span>
          <DatePicker value={inboundEnd} onChange={v => { setInboundEnd(v); setPage(1); }} placeholder="结束" allowClear />
          {(inboundStart || inboundEnd) && (
            <Button size="small" type="link" danger onClick={() => { setInboundStart(null); setInboundEnd(null); }}>清除时间</Button>
          )}
        </Space>
      </Flex>

      {pageItems.length === 0 && !isLoading ? (
        <Empty description="暂无SN码数据，请先在SN码管理中添加" style={{ marginTop: 60 }} />
      ) : (
        <>
          <Row gutter={[12, 12]}>
            {pageItems.map(item => {
              const handLabel = item.handType === 'left' ? '左手' : item.handType === 'right' ? '右手' : '';
              const meta = SM[item.status] || { label: item.status, color: 'default' };
              const url = statusUrl(item.snCode);
              return (
                <Col key={item.snCode} xs={24} sm={12} md={8} lg={6}>
                  <Card size="small" style={{ textAlign: 'center' }}>
                    <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 6 }}>{handLabel ? `${handLabel}手套` : '设备'}</div>
                    <a href={url} target="_blank" rel="noreferrer" style={{ textDecoration: 'none' }}>
                      <div style={{ fontFamily: 'monospace', fontSize: 12, fontWeight: 500, padding: 6, borderRadius: 6, background: 'rgba(148,163,184,0.12)', wordBreak: 'break-all', marginBottom: 8 }}>
                        {item.snCode}
                      </div>
                    </a>
                    <Typography.Paragraph type="secondary" style={{ fontSize: 10, wordBreak: 'break-all', marginBottom: 8 }} ellipsis={{ rows: 2 }}>
                      {url}
                    </Typography.Paragraph>
                    <Space size={4} wrap>
                      <Tag color={meta.color}>{meta.label}</Tag>
                      {item.inboundTime && <span style={{ fontSize: 11, opacity: 0.6 }}>入库 {formatTime(item.inboundTime)}</span>}
                    </Space>
                    <div style={{ marginTop: 8 }}>
                      <Space size={4}>
                        <Button size="small" icon={<LinkOutlined />} href={url} target="_blank">打开</Button>
                        <Button size="small" icon={<CopyOutlined />} onClick={() => doCopy(item.snCode)}>复制</Button>
                      </Space>
                    </div>
                  </Card>
                </Col>
              );
            })}
          </Row>
          {filtered.length > PAGE_SIZE && (
            <Flex justify="center" style={{ marginTop: 16 }}>
              <Pagination
                current={curPage}
                pageSize={PAGE_SIZE}
                total={filtered.length}
                onChange={setPage}
                showTotal={t => `共 ${t} 条`}
              />
            </Flex>
          )}
        </>
      )}
    </PageContainer>
  );
}
