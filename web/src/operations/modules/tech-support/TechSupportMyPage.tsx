// 维修日志（移植 OpsApp.renderTechSupportMy/showTechSupportDetail/exportTechSupportXLSX）：
// 统计卡 + 卡片/表格双视图 + 详情弹窗（进度/关联解决方案）+ XLSX 导出
import { useState } from 'react';
import {
  App as AntApp, Button, Card, Col, DatePicker, Descriptions, Empty, Flex, Modal,
  Popconfirm, Row, Segmented, Select, Steps, Table, Tag, TimePicker,
} from 'antd';
import { useQuery } from '@tanstack/react-query';
import dayjs from 'dayjs';
import { PageContainer } from '@common/components/PageContainer';
import { tsBucket } from '@common/types';
import * as api from '@common/api';
import { fmtDuration } from '../common/opsLocalData';

const STATUS_META: Record<string, { label: string; color: string }> = {
  pending: { label: '待响应', color: 'orange' },
  responded: { label: '处理中', color: 'blue' },
  completed: { label: '已完成', color: 'green' },
};
const fm = (t?: string) => t ? new Date(t).toLocaleString('zh-CN') : '-';

export default function TechSupportMyPage() {
  const { message } = AntApp.useApp();
  const [view, setView] = useState<'card' | 'table'>('card');
  const [detailId, setDetailId] = useState<string | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [exportDate, setExportDate] = useState<string>('');
  const [exportRange, setExportRange] = useState<[dayjs.Dayjs, dayjs.Dayjs] | null>([dayjs('07:00', 'HH:mm'), dayjs('02:00', 'HH:mm')]);
  const [linkSolId, setLinkSolId] = useState<string>('');

  // queryKey 与 SSE 事件映射（query.ts EVENT_QUERY_MAP: tech_support_updated → ['tech-support','solutions']）对齐，
  // 否则管理员响应/完成工单后本页列表不会实时刷新
  const listQuery = useQuery({ queryKey: ['tech-support'], queryFn: () => api.getTechSupportList().catch(() => [] as any[]) });
  const detailQuery = useQuery({
    queryKey: ['tech-support-detail', detailId],
    queryFn: () => api.getTechSupportDetail(detailId!),
    enabled: !!detailId,
  });
  const linkedQuery = useQuery({
    queryKey: ['ticket-solutions', detailId],
    queryFn: () => api.getTicketSolutions(detailId!).catch(() => [] as any[]),
    enabled: !!detailId,
  });
  const allSolsQuery = useQuery({
    queryKey: ['solutions'],
    queryFn: () => api.getSolutions().catch(() => [] as any[]),
    enabled: !!detailId,
  });

  const items = listQuery.data || [];
  // 后端可能返回 ITSM 枚举（open/assigned/in_progress/reopened/resolved/closed），统一归一化再统计
  const counts = {
    all: items.length,
    pending: items.filter((i: any) => tsBucket(i.status) === 'pending').length,
    responded: items.filter((i: any) => tsBucket(i.status) === 'responded').length,
    completed: items.filter((i: any) => tsBucket(i.status) === 'completed').length,
  };

  const item = detailQuery.data as any;
  const linked = linkedQuery.data || [];
  const allSols = allSolsQuery.data || [];

  const linkSolution = async () => {
    if (!detailId || !linkSolId) { message.warning('请选择一个解决方案'); return; }
    try {
      const r: any = await api.linkSolution(detailId, linkSolId);
      if (r?.success === false) { message.error(r?.error || '关联失败'); return; }
      message.success('关联成功');
      setLinkSolId('');
      linkedQuery.refetch();
    } catch (e: any) { message.error(e?.message || '关联失败'); }
  };

  const unlinkSolution = async (solId: string) => {
    if (!detailId) return;
    try {
      const r: any = await api.unlinkSolution(detailId, solId);
      if (r?.success === false) { message.error(r?.error || '解除关联失败'); return; }
      message.success('已解除关联');
      linkedQuery.refetch();
    } catch (e: any) { message.error(e?.message || '解除关联失败'); }
  };

  const doExport = async () => {
    try {
      const params = new URLSearchParams();
      if (exportDate) params.set('date', exportDate);
      if (exportRange?.[0]) params.set('startTime', exportRange[0].format('HH:mm'));
      if (exportRange?.[1]) params.set('endTime', exportRange[1].format('HH:mm'));
      const qs = params.toString();
      const res = await fetch('/api/export/tech-support-xlsx' + (qs ? '?' + qs : ''), { credentials: 'same-origin' });
      if (!res.ok) { message.error('导出失败'); return; }
      const blob = await res.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = '维修日志-' + (exportDate || '全部') + '.xlsx';
      a.click();
      URL.revokeObjectURL(a.href);
      message.success('导出成功');
      setExportOpen(false);
    } catch (e: any) {
      message.error('导出失败: ' + (e?.message || ''));
    }
  };

  const statusTag = (s: string) => {
    const m = STATUS_META[tsBucket(s)] || STATUS_META.pending;
    return <Tag color={m.color}>{m.label}</Tag>;
  };

  return (
    <PageContainer
      title="🧾 维修日志"
      subtitle={`${items.length} 条记录`}
      extra={
        <>
          <Segmented value={view} onChange={v => setView(v as any)} options={[
            { value: 'card', label: '🗂 卡片' },
            { value: 'table', label: '📄 表格' },
          ]} />
          <Button type="primary" onClick={() => setExportOpen(true)}>⬇ 导出</Button>
        </>
      }
    >
      {/* 统计卡 */}
      <Row gutter={[12, 12]} style={{ marginBottom: 16 }}>
        {[
          { label: '总记录', value: counts.all, color: '#6366f1' },
          { label: '待响应', value: counts.pending, color: '#f59e0b' },
          { label: '处理中', value: counts.responded, color: '#3b82f6' },
          { label: '已完成', value: counts.completed, color: '#10b981' },
        ].map(c => (
          <Col xs={12} sm={6} key={c.label}>
            <Card size="small" style={{ textAlign: 'center', borderTop: `3px solid ${c.color}` }}>
              <div style={{ fontSize: 22, fontWeight: 700 }}>{c.value}</div>
              <div style={{ fontSize: 12, opacity: 0.6 }}>{c.label}</div>
            </Card>
          </Col>
        ))}
      </Row>

      {items.length === 0 ? (
        <Card>
          <Empty description={
            <div>
              <div>暂无维修记录</div>
              <div style={{ fontSize: 12, opacity: 0.6 }}>提交技术支持请求后，记录将显示在此处</div>
            </div>
          } />
        </Card>
      ) : view === 'table' ? (
        <Card size="small">
          <Table
            size="small"
            rowKey="id"
            dataSource={items}
            onRow={(r: any) => ({ onClick: () => setDetailId(String(r.id)), style: { cursor: 'pointer' } })}
            columns={[
              { title: '设备编号', dataIndex: 'machineNumber', render: (v: string) => <strong>{v || '-'}</strong> },
              { title: '故障设备', render: (_: any, r: any) => r.equipmentTypeName || r.equipmentType || '-' },
              { title: '故障现象', dataIndex: 'faultType', render: (v: string) => v || '-' },
              { title: '提交时间', dataIndex: 'submittedAt', render: (v: string) => <span style={{ fontSize: 12, whiteSpace: 'nowrap' }}>{fm(v)}</span> },
              { title: '状态', dataIndex: 'status', render: (v: string) => statusTag(v) },
              { title: '维修人员', dataIndex: 'responderName', render: (v: string) => v || '-' },
              { title: '响应时间', dataIndex: 'respondedAt', render: (v: string) => <span style={{ fontSize: 12, whiteSpace: 'nowrap' }}>{fm(v)}</span> },
              { title: '恢复时间', dataIndex: 'completedAt', render: (v: string) => <span style={{ fontSize: 12, whiteSpace: 'nowrap' }}>{fm(v)}</span> },
              { title: '总时长', dataIndex: 'totalSeconds', render: (v: number) => fmtDuration(v) },
            ]}
          />
        </Card>
      ) : (
        <Row gutter={[12, 12]}>
          {items.map((it: any) => {
            const m = STATUS_META[tsBucket(it.status)] || STATUS_META.pending;
            return (
              <Col xs={24} sm={12} lg={8} key={it.id}>
                <Card size="small" hoverable onClick={() => setDetailId(String(it.id))}
                  style={{ borderLeft: `3px solid ${m.color === 'orange' ? '#f59e0b' : m.color === 'blue' ? '#3b82f6' : '#10b981'}` }}>
                  <Flex justify="space-between" align="center">
                    <strong>{it.machineNumber || it.machineId}</strong>
                    {statusTag(it.status)}
                  </Flex>
                  <div style={{ fontSize: 12, opacity: 0.7, marginTop: 6 }}>
                    {it.equipmentTypeName || it.equipmentType} · {it.faultType || '-'}
                  </div>
                  <div style={{ fontSize: 12, opacity: 0.5, marginTop: 8, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                    <span>🕐 {fm(it.submittedAt)}</span>
                    {it.responderName && <span>🔧 {it.responderName}</span>}
                    {it.totalSeconds != null && <span>⏱ {fmtDuration(it.totalSeconds)}</span>}
                  </div>
                </Card>
              </Col>
            );
          })}
        </Row>
      )}

      {/* 详情弹窗 */}
      <Modal
        title="🔧 维修详情"
        open={!!detailId}
        onCancel={() => { setDetailId(null); setLinkSolId(''); }}
        footer={<Button onClick={() => { setDetailId(null); setLinkSolId(''); }}>关闭</Button>}
        width={720}
        destroyOnClose
      >
        {!item ? (
          <div style={{ textAlign: 'center', padding: 40 }}>加载中...</div>
        ) : (
          <div>
            <Steps
              size="small"
              style={{ marginBottom: 20 }}
              current={tsBucket(item.status) === 'completed' ? 2 : tsBucket(item.status) === 'responded' ? 1 : 0}
              items={[
                { title: '提交', description: item.submittedAt ? fm(item.submittedAt) : '' },
                { title: '响应', description: item.respondedAt ? fm(item.respondedAt) : '' },
                { title: '完成', description: item.completedAt ? fm(item.completedAt) : '' },
              ]}
            />
            <Card size="small" title="📋 请求信息" style={{ marginBottom: 12 }}>
              <Descriptions size="small" column={2}>
                <Descriptions.Item label="状态">{statusTag(item.status)}</Descriptions.Item>
                <Descriptions.Item label="故障设备">{item.equipmentTypeName || item.equipmentType || '-'}</Descriptions.Item>
                <Descriptions.Item label="设备编号">{item.machineNumber || item.machineId || '-'}</Descriptions.Item>
                <Descriptions.Item label="故障现象">{item.faultType || '-'}</Descriptions.Item>
                <Descriptions.Item label="提交人">{item.submitterName || '-'}</Descriptions.Item>
                <Descriptions.Item label="提交时间">{fm(item.submittedAt)}</Descriptions.Item>
                <Descriptions.Item label="故障说明" span={2}>{item.faultDescription || '无'}</Descriptions.Item>
              </Descriptions>
            </Card>
            <Card size="small" title="🔧 处理信息" style={{ marginBottom: 12 }}>
              <Descriptions size="small" column={2}>
                <Descriptions.Item label="维修人员">{item.responderName || '待分配'}</Descriptions.Item>
                <Descriptions.Item label="响应时间">{fm(item.respondedAt)}</Descriptions.Item>
                <Descriptions.Item label="完成时间">{fm(item.completedAt)}</Descriptions.Item>
                {item.result && <Descriptions.Item label="维修结果" span={2}>{item.result}</Descriptions.Item>}
              </Descriptions>
            </Card>
            <Card size="small" title="⏱ 耗时统计" style={{ marginBottom: 12 }}>
              <Descriptions size="small" column={3}>
                <Descriptions.Item label="等待时长">{fmtDuration(item.waitSeconds)}</Descriptions.Item>
                <Descriptions.Item label="维修时长">{fmtDuration(item.repairSeconds)}</Descriptions.Item>
                <Descriptions.Item label="总耗时">{fmtDuration(item.totalSeconds)}</Descriptions.Item>
              </Descriptions>
            </Card>
            <Card size="small" title="💡 关联解决方案">
              {linked.length === 0 ? (
                <div style={{ fontSize: 12, opacity: 0.6 }}>暂无关联解决方案</div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {linked.map((s: any) => (
                    <Flex key={s.id} justify="space-between" align="center" style={{
                      padding: '6px 8px', borderRadius: 6, background: 'rgba(128,128,128,.06)',
                    }}>
                      <span style={{ fontSize: 13 }}>{s.title}</span>
                      <Popconfirm title="确认解除关联？" onConfirm={() => unlinkSolution(s.id)} okText="解除" cancelText="取消">
                        <Button size="small" type="text">✕</Button>
                      </Popconfirm>
                    </Flex>
                  ))}
                </div>
              )}
              <Flex gap={8} style={{ marginTop: 10 }}>
                <Select
                  style={{ flex: 1 }}
                  placeholder="-- 选择解决方案关联 --"
                  value={linkSolId || undefined}
                  onChange={setLinkSolId}
                  showSearch
                  filterOption={(input, option) => (option?.label as string || '').toLowerCase().includes(input.toLowerCase())}
                  options={allSols
                    .filter((s: any) => !linked.some((l: any) => String(l.id) === String(s.id)))
                    .map((s: any) => ({ value: String(s.id), label: s.title }))}
                />
                <Button type="primary" onClick={linkSolution}>关联</Button>
              </Flex>
            </Card>
          </div>
        )}
      </Modal>

      {/* 导出弹窗 */}
      <Modal
        title="⬇ 导出维修日志"
        open={exportOpen}
        onCancel={() => setExportOpen(false)}
        onOk={doExport}
        okText="导出"
        destroyOnClose
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 12 }}>
          <div>
            <div style={{ fontSize: 13, marginBottom: 6 }}>📅 日期（留空=全部）</div>
            <DatePicker style={{ width: '100%' }} onChange={d => setExportDate(d ? d.format('YYYY-MM-DD') : '')} />
          </div>
          <div>
            <div style={{ fontSize: 13, marginBottom: 6 }}>⏰ 时间范围</div>
            <TimePicker.RangePicker style={{ width: '100%' }} format="HH:mm"
              defaultValue={[dayjs('07:00', 'HH:mm'), dayjs('02:00', 'HH:mm')]}
              onChange={v => setExportRange(v as any)} />
          </div>
          <div style={{ fontSize: 12, opacity: 0.6 }}>ℹ 全留空=导出全部 | 日期+时间=精确筛选</div>
        </div>
      </Modal>
    </PageContainer>
  );
}
