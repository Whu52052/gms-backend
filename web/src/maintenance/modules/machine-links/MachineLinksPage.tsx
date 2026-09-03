// 机器链接管理页（移植 js/ui/machine-links.js）：每台机器的状态查询链接
import { useMemo, useState } from 'react';
import { Button, Card, Col, Empty, Flex, Input, Radio, Row, Space, Statistic, Tag, Typography, message } from 'antd';
import { CopyOutlined, LinkOutlined } from '@ant-design/icons';
import { PageContainer } from '@common/components/PageContainer';
import { useMachines, useSNRegistry, useEquipmentConfig } from '@common/hooks/useData';
import { latestMachineByNumber, buildEffectiveStatusMap, MACHINE_STATUS_META } from '@common/utils/domain';
import { naturalCompare } from '@common/utils/format';

const statusUrl = (num: string) =>
  `${window.location.origin}/machine-status.html?code=${encodeURIComponent(num)}`;

export function copyText(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(text).then(() => true).catch(() => fallbackCopy(text));
  }
  return Promise.resolve(fallbackCopy(text));
}

function fallbackCopy(text: string): boolean {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  document.body.removeChild(ta);
  return ok;
}

export default function MachineLinksPage() {
  const { data: machines = [] } = useMachines();
  const { data: registry = [] } = useSNRegistry();
  const { data: equipmentConfig = [] } = useEquipmentConfig();
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');

  const latestMap = useMemo(() => latestMachineByNumber(machines), [machines]);
  const numbers = useMemo(
    () => Object.keys(latestMap).sort(naturalCompare),
    [latestMap],
  );
  const effectiveStatusMap = useMemo(
    () => buildEffectiveStatusMap(numbers.map(n => latestMap[n]), registry),
    [numbers, latestMap, registry],
  );
  const typeLabel: Record<string, string> = {};
  equipmentConfig.forEach((c: any) => { typeLabel[c.id] = c.name; });

  const counts = useMemo(() => {
    const c = { all: numbers.length, online: 0, partial: 0, offline: 0 } as Record<string, number>;
    Object.values(effectiveStatusMap).forEach(s => { if (c[s] !== undefined) c[s]++; });
    return c;
  }, [numbers.length, effectiveStatusMap]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return numbers.filter(num => {
      const st = effectiveStatusMap[num] || 'offline';
      if (filter !== 'all' && st !== filter) return false;
      if (q && !String(num).toLowerCase().includes(q)) return false;
      return true;
    });
  }, [numbers, filter, search, effectiveStatusMap]);

  const doCopy = async (num: string) => {
    const ok = await copyText(statusUrl(num));
    if (ok) message.success('链接已复制');
    else message.error('复制失败，请手动复制');
  };

  return (
    <PageContainer title="机器链接管理" subtitle="为每台机器生成专属状态查询链接">
      {/* 统计卡片 */}
      <Row gutter={12} style={{ marginBottom: 12 }}>
        <Col span={6}><Card size="small"><Statistic title="机器总数" value={counts.all} /></Card></Col>
        <Col span={6}><Card size="small"><Statistic title="在线" value={counts.online} valueStyle={{ color: '#22c55e' }} /></Card></Col>
        {counts.partial > 0 && (
          <Col span={6}><Card size="small"><Statistic title="部分绑定" value={counts.partial} valueStyle={{ color: '#f59e0b' }} /></Card></Col>
        )}
        <Col span={6}><Card size="small"><Statistic title="离线" value={counts.offline} valueStyle={{ color: '#ef4444' }} /></Card></Col>
      </Row>

      {/* 筛选栏 */}
      <Flex wrap gap={8} align="center" style={{ marginBottom: 12 }}>
        <Radio.Group value={filter} onChange={e => setFilter(e.target.value)} optionType="button" buttonStyle="solid">
          <Radio.Button value="all">全部 ({counts.all})</Radio.Button>
          <Radio.Button value="online">在线 ({counts.online})</Radio.Button>
          {counts.partial > 0 && <Radio.Button value="partial">部分 ({counts.partial})</Radio.Button>}
          <Radio.Button value="offline">离线 ({counts.offline})</Radio.Button>
        </Radio.Group>
        <Input.Search
          placeholder="搜索机器编号..."
          allowClear
          style={{ width: 220 }}
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
      </Flex>

      {filtered.length === 0 ? (
        <Empty description="暂无机器，添加机器后在此生成状态链接" style={{ marginTop: 60 }} />
      ) : (
        <Row gutter={[12, 12]}>
          {filtered.map(num => {
            const m = latestMap[num];
            const st = effectiveStatusMap[num] || 'offline';
            const meta = MACHINE_STATUS_META[st] || MACHINE_STATUS_META.offline;
            const url = statusUrl(num);
            return (
              <Col key={num} xs={24} sm={12} md={8} lg={6}>
                <Card size="small" style={{ textAlign: 'center' }}>
                  <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 6 }}>
                    {typeLabel[m.deviceType] || '设备'}
                  </div>
                  <a href={url} target="_blank" rel="noreferrer" style={{ textDecoration: 'none' }}>
                    <div style={{ fontFamily: 'monospace', fontSize: 15, fontWeight: 600, padding: 8, borderRadius: 6, background: 'rgba(148,163,184,0.12)', marginBottom: 10 }}>
                      {num}
                    </div>
                  </a>
                  <Tag color={meta.color} style={{ marginBottom: 8 }}>{meta.label}</Tag>
                  <Typography.Paragraph
                    type="secondary"
                    style={{ fontSize: 11, wordBreak: 'break-all', marginBottom: 8 }}
                    ellipsis={{ rows: 2 }}
                  >
                    {url}
                  </Typography.Paragraph>
                  <Space>
                    <Button size="small" icon={<LinkOutlined />} href={url} target="_blank">打开</Button>
                    <Button size="small" icon={<CopyOutlined />} onClick={() => doCopy(num)}>复制</Button>
                  </Space>
                </Card>
              </Col>
            );
          })}
        </Row>
      )}
    </PageContainer>
  );
}
