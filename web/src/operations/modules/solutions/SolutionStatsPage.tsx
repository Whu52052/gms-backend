// 解决方案数据统计（移植 OpsApp.renderSolutionStats）：
// 效率统计卡 + 使用频率/分类分布横条 + 各方案平均解决时长列表
import { App as AntApp, Button, Card, Col, Empty, Row } from 'antd';
import { useQuery } from '@tanstack/react-query';
import { PageContainer } from '@common/components/PageContainer';
import { useUIStore } from '@common/stores/ui';
import * as api from '@common/api';

const CAT_LABEL: Record<string, string> = { hardware: '硬件', software: '软件', network: '网络', operation: '操作', other: '其他' };

// 旧版 renderSolutionStats 内的时长格式化（与 _fmtDuration 不同，保持忠实）
const fmt = (sec?: number | null): string => {
  if (!sec) return '0';
  const m = Math.floor(sec / 60);
  return m < 60 ? `${m}分钟` : `${Math.floor(m / 60)}小时${m % 60}分`;
};

// 横条列表（忠实旧版 div 渲染，不用图表库）
function BarList({ items, color }: { items: { label: string; val: number }[]; color: string }) {
  if (!items.length) return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无数据" />;
  const max = Math.max(...items.map(i => i.val), 1);
  return (
    <div>
      {items.map((it, i) => (
        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
          <div style={{
            width: '48%', fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }} title={it.label}>{it.label}</div>
          <div style={{ flex: 1, background: 'rgba(128,128,128,.08)', borderRadius: 4, height: 16 }}>
            <div style={{ width: `${Math.round((it.val / max) * 100)}%`, background: color, height: 16, borderRadius: 4 }} />
          </div>
          <span style={{ width: 36, textAlign: 'right', fontSize: 12 }}>{it.val}</span>
        </div>
      ))}
    </div>
  );
}

export default function SolutionStatsPage() {
  const { message } = AntApp.useApp();
  const dark = useUIStore(s => s.theme === 'dark');
  const neutral = dark ? '#fafafa' : '#0a0a0a';
  const statsQuery = useQuery({ queryKey: ['solution-stats'], queryFn: () => api.getSolutionStats() });
  const stats: any = statsQuery.data;

  if (!statsQuery.isLoading && !stats) {
    return (
      <PageContainer title="📊 解决方案数据统计">
        <Card><Empty description="暂无统计数据" /></Card>
      </PageContainer>
    );
  }

  const usage = (stats?.usageFrequency || []) as any[];
  const eff = (stats?.efficiency || {}) as any;
  const linkEff = (stats?.linkEfficiency || []) as any[];

  const effCards = [
    { label: '已解决工单', val: eff.completedCount || 0 },
    { label: '平均维修时长', val: fmt(eff.avgRepairSeconds) },
    { label: '平均总处理时长', val: fmt(eff.avgTotalSeconds) },
    { label: '方案被采用次数', val: stats?.linkCount || 0 },
  ];

  return (
    <PageContainer
      title="📊 解决方案数据统计"
      extra={<Button onClick={() => { statsQuery.refetch(); message.info('已刷新'); }}>⟳ 刷新</Button>}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <Row gutter={[12, 12]}>
          {effCards.map(c => (
            <Col xs={12} sm={6} key={c.label}>
              <Card size="small" style={{ textAlign: 'center' }}>
                <div style={{ fontSize: 24, fontWeight: 700, color: neutral }}>{c.val}</div>
                <div style={{ fontSize: 12, opacity: 0.65, marginTop: 4 }}>{c.label}</div>
              </Card>
            </Col>
          ))}
        </Row>

        <Card size="small" title="📈 解决方案使用频率" loading={statsQuery.isLoading}>
          <BarList color={neutral} items={usage.map(u => ({ label: u.title, val: u.usage_count || 0 }))} />
        </Card>

        <Row gutter={[12, 12]}>
          <Col xs={24} lg={12}>
            <Card size="small" title="🗂 解决方案分类分布" loading={statsQuery.isLoading} style={{ height: '100%' }}>
              <BarList color="#10b981" items={(stats?.categoryDistribution || []).map((c: any) => ({ label: c.category, val: c.cnt }))} />
            </Card>
          </Col>
          <Col xs={24} lg={12}>
            <Card size="small" title="🛠 技术支持分类分布" loading={statsQuery.isLoading} style={{ height: '100%' }}>
              <BarList color="#f59e0b" items={(stats?.techSupportCategoryDistribution || []).map((c: any) => ({ label: CAT_LABEL[c.category] || c.category, val: c.cnt }))} />
            </Card>
          </Col>
        </Row>

        <Card size="small" title="⏱ 各解决方案平均解决时长（越短越高效）" loading={statsQuery.isLoading}>
          {linkEff.length === 0 ? (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无关联数据" />
          ) : (
            linkEff.map((s: any, i: number) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                <div style={{
                  width: '48%', fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }} title={s.title}>{s.title}</div>
                <div style={{ flex: 1, fontSize: 12, opacity: 0.65 }}>{fmt(s.avgRepairSeconds)}（{s.count}单）</div>
              </div>
            ))
          )}
        </Card>
      </div>
    </PageContainer>
  );
}
