// 维修日志页（移植 js/ui/tech-support.js）：ITSM 工单列表/详情/响应/完成/导出
import { useMemo, useState } from 'react';
import {
  AutoComplete, Button, Card, Col, Descriptions, Drawer, Empty, Flex, Input, Modal,
  Pagination, Radio, Row, Statistic, Steps, Table, Tag, TimePicker, DatePicker,
  Typography, message,
} from 'antd';
import { AppstoreOutlined, DownloadOutlined, ReloadOutlined, TableOutlined } from '@ant-design/icons';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import dayjs from 'dayjs';
import { PageContainer } from '@common/components/PageContainer';
import { useTechSupport } from '@common/hooks/useData';
import { useAuthStore } from '@common/stores/auth';
import * as api from '@common/api';

const PAGE_SIZE = 30;
const REPAIR_HISTORY_KEY = 'gms_repair_result_history';

// ITSM 状态归一化（与旧版 _tsBucket 保持一致）
const tsBucket = (s?: string): string =>
  ({ open: 'pending', assigned: 'pending', in_progress: 'responded', reopened: 'responded', resolved: 'completed', closed: 'completed' } as Record<string, string>)[s || ''] || s || 'pending';

const SM: Record<string, { label: string; color: string }> = {
  pending: { label: '待响应', color: 'orange' },
  responded: { label: '处理中', color: 'blue' },
  completed: { label: '已完成', color: 'green' },
  closed: { label: '已关闭', color: 'default' },
};

const fmtDuration = (seconds?: number | null): string => {
  if (seconds == null) return '-';
  const s = Math.round(seconds);
  if (s < 60) return '<1分钟';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}分钟`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm > 0 ? `${h}时${rm}分` : `${h}小时`;
};

const fm = (t?: string) => (t ? new Date(t).toLocaleString('zh-CN') : '-');

function loadRepairHistory(): string[] {
  try { return JSON.parse(localStorage.getItem(REPAIR_HISTORY_KEY) || '[]'); } catch { return []; }
}
function addRepairHistory(text: string) {
  const trimmed = text.trim();
  if (trimmed.length < 2) return;
  let list = loadRepairHistory().filter(r => r !== trimmed);
  list.unshift(trimmed);
  if (list.length > 50) list = list.slice(0, 50);
  localStorage.setItem(REPAIR_HISTORY_KEY, JSON.stringify(list));
}

// ==================== 详情抽屉 ====================
function DetailDrawer({ id, onClose, onChanged }: { id: string | null; onClose: () => void; onChanged: () => void }) {
  const user = useAuthStore(s => s.user);
  const qc = useQueryClient();
  const { data: item } = useQuery({
    queryKey: ['tech-support-detail', id],
    queryFn: () => api.getTechSupportDetail(id!),
    enabled: !!id,
  });

  const [completeOpen, setCompleteOpen] = useState(false);
  const [funnyMsg, setFunnyMsg] = useState('辛苦了！');
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [resultText, setResultText] = useState('');

  const canDelete = user?.system === 'maintenance' && (user?.role === 'admin' || user?.role === 'superadmin');

  const doRespond = async () => {
    if (!id) return;
    const result: any = await api.respondTechSupport(id);
    if (result && result.success !== false) {
      message.success('已响应，请进行维修处理');
      qc.invalidateQueries({ queryKey: ['tech-support'] });
      qc.invalidateQueries({ queryKey: ['tech-support-detail', id] });
    } else {
      message.error(result?.error || result?.message || '响应失败');
    }
  };

  const openComplete = async () => {
    const popup: any = await api.getRandomPopupMessage('complete').catch(() => null);
    setFunnyMsg(popup?.text || '辛苦了！');
    let sugg: string[] = [];
    try {
      const memList = await api.getMemoryList('repair_result');
      if (Array.isArray(memList)) sugg = memList.map((m: any) => m.text).slice(0, 20);
    } catch { /* ignore */ }
    if (sugg.length === 0) sugg = loadRepairHistory().slice(0, 20);
    setSuggestions(sugg);
    setResultText('');
    setCompleteOpen(true);
  };

  const doComplete = async () => {
    if (!resultText.trim()) { message.error('请输入维修结果'); return; }
    if (!id) return;
    const result: any = await api.completeTechSupport(id, resultText.trim());
    if (result && result.success !== false) {
      addRepairHistory(resultText);
      api.addMemory('repair_result', resultText.trim()).catch(() => {});
      message.success('维修已完成');
      setCompleteOpen(false);
      qc.invalidateQueries({ queryKey: ['tech-support'] });
      qc.invalidateQueries({ queryKey: ['tech-support-detail', id] });
      onChanged();
    } else {
      message.error(result?.error || result?.message || '操作失败');
    }
  };

  const doDelete = () => {
    if (!id) return;
    Modal.confirm({
      title: '确定要删除这条维修记录吗？此操作不可恢复！',
      onOk: async () => {
        const result: any = await api.deleteTechSupport(id);
        if (result && result.success !== false) {
          message.success('维修记录已删除');
          qc.invalidateQueries({ queryKey: ['tech-support'] });
          onChanged();
          onClose();
        } else {
          message.error(result?.error || '删除失败');
        }
      },
    });
  };

  if (!item) {
    return <Drawer title="维修详情" open={!!id} onClose={onClose} width={520} />;
  }

  const sb = tsBucket(item.status);
  const stepCurrent = sb === 'pending' ? 0 : sb === 'responded' ? 1 : 2;

  return (
    <>
      <Drawer title="维修详情" open={!!id} onClose={onClose} width={560}>
        <Steps
          size="small"
          current={stepCurrent}
          style={{ marginBottom: 24 }}
          items={[
            { title: '提交', description: fm(item.submittedAt) },
            { title: '响应', description: item.respondedAt ? fm(item.respondedAt) : '' },
            { title: '完成', description: item.completedAt ? fm(item.completedAt) : '' },
          ]}
        />

        <Card size="small" title="请求信息" style={{ marginBottom: 12 }}>
          <Descriptions column={2} size="small">
            <Descriptions.Item label="状态"><Tag color={SM[sb]?.color}>{SM[sb]?.label || sb}</Tag></Descriptions.Item>
            <Descriptions.Item label="故障设备">{item.equipmentTypeName || item.equipmentType || '-'}</Descriptions.Item>
            <Descriptions.Item label="设备编号">{item.machineNumber || item.machineId || '-'}</Descriptions.Item>
            <Descriptions.Item label="故障现象">{item.faultType || '-'}</Descriptions.Item>
            <Descriptions.Item label="操作员">{item.submitterName || '-'}</Descriptions.Item>
            <Descriptions.Item label="提交时间">{fm(item.submittedAt)}</Descriptions.Item>
            <Descriptions.Item label="故障说明" span={2}>{item.faultDescription || '无'}</Descriptions.Item>
          </Descriptions>
        </Card>

        <Card size="small" title="处理信息" style={{ marginBottom: 12 }}>
          <Descriptions column={2} size="small">
            <Descriptions.Item label="维修人员">{item.responderName || '待分配'}</Descriptions.Item>
            <Descriptions.Item label="响应时间">{fm(item.respondedAt)}</Descriptions.Item>
            <Descriptions.Item label="完成时间">{fm(item.completedAt)}</Descriptions.Item>
            <Descriptions.Item label="维修结果">{item.result || '—'}</Descriptions.Item>
          </Descriptions>
        </Card>

        <Card size="small" title="耗时统计" style={{ marginBottom: 16 }}>
          <Descriptions column={3} size="small">
            <Descriptions.Item label="等待时长">{fmtDuration(item.waitSeconds)}</Descriptions.Item>
            <Descriptions.Item label="维修时长">{fmtDuration(item.repairSeconds)}</Descriptions.Item>
            <Descriptions.Item label="总耗时">{fmtDuration(item.totalSeconds)}</Descriptions.Item>
          </Descriptions>
        </Card>

        <Flex gap={8}>
          {sb === 'pending' && <Button type="primary" onClick={doRespond}>响应请求</Button>}
          {sb === 'responded' && <Button type="primary" style={{ background: '#22c55e', borderColor: '#22c55e' }} onClick={openComplete}>维修完成</Button>}
          <Button onClick={onClose}>返回列表</Button>
          {canDelete && <Button danger style={{ marginLeft: 'auto' }} onClick={doDelete}>删除记录</Button>}
        </Flex>
      </Drawer>

      {/* 维修完成弹窗：鼓励语 + 结果输入 + 历史记忆标签 */}
      <Modal title="🎉 维修完成" open={completeOpen} onCancel={() => setCompleteOpen(false)} onOk={doComplete} okText="确认完成">
        <div style={{ textAlign: 'center', padding: '12px', background: 'rgba(148,163,184,0.08)', borderRadius: 12, marginBottom: 16 }}>
          <div style={{ fontSize: 28 }}>🔧</div>
          <p style={{ margin: 0, fontWeight: 500 }}>{funnyMsg}</p>
        </div>
        <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>维修结果说明</div>
        <AutoComplete
          style={{ width: '100%' }}
          value={resultText}
          onChange={setResultText}
          placeholder="请输入或选择维修结果..."
          options={suggestions.map(s => ({ value: s }))}
          filterOption={(input, option) => String(option?.value || '').toLowerCase().includes(input.toLowerCase())}
        >
          <Input.TextArea rows={3} />
        </AutoComplete>
        {suggestions.length > 0 && (
          <div style={{ marginTop: 8 }}>
            <div style={{ fontSize: 12, opacity: 0.65, marginBottom: 6 }}>历史记录（全运维用户共享，点击快速填入）：</div>
            <Flex wrap gap={6} style={{ maxHeight: 100, overflowY: 'auto' }}>
              {suggestions.slice(0, 12).map(s => (
                <Tag key={s} style={{ cursor: 'pointer' }} onClick={() => setResultText(s)}>
                  {s.length > 25 ? `${s.slice(0, 25)}...` : s}
                </Tag>
              ))}
            </Flex>
          </div>
        )}
      </Modal>
    </>
  );
}

// ==================== 主页面 ====================
export default function TechSupportPage() {
  const { data: items = [], isLoading, refetch } = useTechSupport();
  const [filter, setFilter] = useState('all');
  const [viewMode, setViewMode] = useState<'card' | 'table'>('card');
  const [page, setPage] = useState(1);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [exportDate, setExportDate] = useState<dayjs.Dayjs | null>(null);
  const [exportStart, setExportStart] = useState<dayjs.Dayjs | null>(dayjs('07:00', 'HH:mm'));
  const [exportEnd, setExportEnd] = useState<dayjs.Dayjs | null>(dayjs('02:00', 'HH:mm'));
  const qc = useQueryClient();

  const filtered = useMemo(() => {
    if (filter === 'all') return items;
    return items.filter(i => tsBucket(i.status) === filter);
  }, [items, filter]);

  const counts = useMemo(() => {
    const c = { all: items.length, pending: 0, responded: 0, completed: 0 };
    items.forEach(i => {
      const b = tsBucket(i.status) as keyof typeof c;
      if (c[b] !== undefined) c[b]++;
    });
    return c;
  }, [items]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const curPage = Math.min(page, totalPages);
  const pageItems = filtered.slice((curPage - 1) * PAGE_SIZE, curPage * PAGE_SIZE);

  const doExport = async () => {
    try {
      const params = new URLSearchParams();
      if (exportDate) params.set('date', exportDate.format('YYYY-MM-DD'));
      if (exportStart) params.set('startTime', exportStart.format('HH:mm'));
      if (exportEnd) params.set('endTime', exportEnd.format('HH:mm'));
      const qs = params.toString();
      const res = await fetch(`/api/export/tech-support-xlsx${qs ? `?${qs}` : ''}`);
      if (!res.ok) { message.error('导出失败'); return; }
      const blob = await res.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `维修日志-${exportDate ? exportDate.format('YYYY-MM-DD') : '全部'}.xlsx`;
      a.click();
      URL.revokeObjectURL(a.href);
      setExportOpen(false);
      message.success('导出成功');
    } catch (e: any) {
      message.error(`导出失败: ${e?.message || ''}`);
    }
  };

  const tableColumns: any[] = [
    { title: '设备编号', dataIndex: 'machineNumber', render: (v: string, i: any) => <strong>{v || i.machineId || '-'}</strong> },
    { title: '故障设备', render: (_: any, i: any) => i.equipmentTypeName || i.equipmentType || '-' },
    { title: '故障现象', dataIndex: 'faultType', render: (v: string) => v || '-' },
    { title: '操作员', dataIndex: 'submitterName', render: (v: string) => v || '-' },
    { title: '提交时间', dataIndex: 'submittedAt', render: (v: string) => <span style={{ fontSize: 12 }}>{fm(v)}</span>, sorter: (a: any, b: any) => String(a.submittedAt || '').localeCompare(String(b.submittedAt || '')), defaultSortOrder: 'descend' },
    { title: '状态', dataIndex: 'status', render: (v: string) => { const sb = tsBucket(v); return <Tag color={SM[sb]?.color}>{SM[sb]?.label || sb}</Tag>; } },
    { title: '维修人员', dataIndex: 'responderName', render: (v: string) => v || '-' },
    { title: '响应时间', dataIndex: 'respondedAt', render: (v: string) => <span style={{ fontSize: 12 }}>{fm(v)}</span> },
    { title: '恢复时间', dataIndex: 'completedAt', render: (v: string) => <span style={{ fontSize: 12 }}>{fm(v)}</span> },
    { title: '总时长', dataIndex: 'totalSeconds', render: (v: number) => fmtDuration(v) },
  ];

  return (
    <PageContainer
      title="维修日志"
      subtitle="设备故障与维修记录"
      extra={
        <>
          <Button icon={viewMode === 'card' ? <TableOutlined /> : <AppstoreOutlined />} onClick={() => { setViewMode(viewMode === 'card' ? 'table' : 'card'); setPage(1); }}>
            {viewMode === 'card' ? '表格' : '卡片'}
          </Button>
          <Button icon={<ReloadOutlined />} onClick={async () => { await refetch(); qc.invalidateQueries({ queryKey: ['tech-support'] }); message.success('数据已刷新'); }}>
            刷新
          </Button>
          <Button type="primary" icon={<DownloadOutlined />} onClick={() => setExportOpen(true)}>导出</Button>
        </>
      }
    >
      {/* 统计卡片 */}
      <Row gutter={12} style={{ marginBottom: 12 }}>
        <Col span={8}><Card size="small"><Statistic title="待响应" value={counts.pending} valueStyle={{ color: '#f59e0b' }} /></Card></Col>
        <Col span={8}><Card size="small"><Statistic title="处理中" value={counts.responded} valueStyle={{ color: '#3b82f6' }} /></Card></Col>
        <Col span={8}><Card size="small"><Statistic title="已完成" value={counts.completed} valueStyle={{ color: '#22c55e' }} /></Card></Col>
      </Row>

      {/* 筛选栏 */}
      <Flex wrap gap={8} align="center" style={{ marginBottom: 12 }}>
        <Radio.Group value={filter} onChange={e => { setFilter(e.target.value); setPage(1); }} optionType="button" buttonStyle="solid">
          <Radio.Button value="all">全部 ({counts.all})</Radio.Button>
          <Radio.Button value="pending">待响应 ({counts.pending})</Radio.Button>
          <Radio.Button value="responded">处理中 ({counts.responded})</Radio.Button>
          <Radio.Button value="completed">已完成 ({counts.completed})</Radio.Button>
        </Radio.Group>
      </Flex>

      {filtered.length === 0 && !isLoading ? (
        <Empty description="暂无维修记录，运营系统提交的技术支持请求将显示在此处" style={{ marginTop: 60 }} />
      ) : viewMode === 'table' ? (
        <Table
          rowKey="id"
          size="small"
          loading={isLoading}
          columns={tableColumns}
          dataSource={pageItems}
          pagination={false}
          onRow={record => ({ onClick: () => setDetailId(String(record.id)), style: { cursor: 'pointer' } })}
        />
      ) : (
        <Row gutter={[12, 12]}>
          {pageItems.map(item => {
            const sb = tsBucket(item.status);
            const meta = SM[sb] || SM.pending;
            return (
              <Col key={item.id} xs={24} sm={12} md={8} lg={6}>
                <Card
                  size="small"
                  hoverable
                  onClick={() => setDetailId(String(item.id))}
                  style={{ borderLeft: `3px solid ${sb === 'pending' ? '#f59e0b' : sb === 'responded' ? '#3b82f6' : '#22c55e'}` }}
                >
                  <div style={{ fontWeight: 600 }}>{item.machineNumber || item.machineId}</div>
                  <div style={{ fontSize: 12, opacity: 0.75, margin: '4px 0' }}>
                    {item.equipmentTypeName || item.equipmentType} · {item.faultType || '-'}
                  </div>
                  <Flex wrap gap={8} style={{ fontSize: 12, opacity: 0.65 }}>
                    <span>👤 {item.submitterName || '-'}</span>
                    <span>🕐 {fm(item.submittedAt)}</span>
                    {item.responderName && <span>🔧 {item.responderName}</span>}
                    {item.totalSeconds != null && <span>⏱ {fmtDuration(item.totalSeconds)}</span>}
                  </Flex>
                  <div style={{ marginTop: 8 }}><Tag color={meta.color}>{meta.label}</Tag></div>
                </Card>
              </Col>
            );
          })}
        </Row>
      )}

      {filtered.length > PAGE_SIZE && (
        <Flex justify="center" style={{ marginTop: 16 }}>
          <Pagination current={curPage} pageSize={PAGE_SIZE} total={filtered.length} onChange={setPage}
            showTotal={t => `共 ${t} 条`} showSizeChanger={false} />
        </Flex>
      )}

      <DetailDrawer id={detailId} onClose={() => setDetailId(null)} onChanged={() => qc.invalidateQueries({ queryKey: ['tech-support'] })} />

      {/* 导出弹窗（移植 exportTechSupportXLSX：日期+跨天时间段） */}
      <Modal title="导出维修日志" open={exportOpen} onCancel={() => setExportOpen(false)} onOk={doExport} okText="导出">
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>日期（留空=全部）</div>
          <DatePicker value={exportDate} onChange={setExportDate} style={{ width: '100%' }} allowClear />
        </div>
        <Flex gap={8}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>开始时间</div>
            <TimePicker value={exportStart} onChange={setExportStart} format="HH:mm" style={{ width: '100%' }} allowClear />
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>结束时间</div>
            <TimePicker value={exportEnd} onChange={setExportEnd} format="HH:mm" style={{ width: '100%' }} allowClear />
          </div>
        </Flex>
        <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 8, marginBottom: 0 }}>
          提示：结束时间早于开始时间=跨天（如7:00~次日2:00）<br />
          只填日期=导出当天全部记录 · 只填时间=仅按时间段筛选 · 全留空=导出全部
        </Typography.Paragraph>
      </Modal>
    </PageContainer>
  );
}
