// 盘点页：发起（快照）→ 录入实盘 → 完成差异调整 → 历史报告
// SN 模式按单件勾选（缺失→scrapped、盘盈→入库），数量模式填实盘数
import { useMemo, useState } from 'react';
import {
  Alert, Button, Card, Checkbox, Col, Empty, Flex, Input, InputNumber, List, Modal,
  Popconfirm, Radio, Row, Space, Statistic, Table, Tag, Typography, message,
} from 'antd';
import { CheckCircleOutlined, FileSearchOutlined, PlusOutlined, RollbackOutlined } from '@ant-design/icons';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { PageContainer } from '@common/components/PageContainer';
import { useInventory, useInventoryConfig } from '@common/hooks/useData';
import { useAuthStore, isAdmin } from '@common/stores/auth';
import { typeLabelOf } from '@common/utils/domain';
import { formatTime } from '@common/utils/format';
import * as api from '@common/api';

export default function StocktakePage() {
  const user = useAuthStore(s => s.user);
  const qc = useQueryClient();
  const inventory = useInventory();
  const inventoryConfig = useInventoryConfig();
  const admin = isAdmin(user);

  // 视图状态：list（历史列表） | form（录入中，activeId）
  const [view, setView] = useState<'list' | 'form'>('list');
  const [activeId, setActiveId] = useState<string | null>(null);
  // 录入数据（从详情加载的本地副本）
  const [draft, setDraft] = useState<any[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [search, setSearch] = useState('');

  const listQuery = useQuery({ queryKey: ['stocktakes'], queryFn: () => api.getStocktakes().catch(() => [] as any[]) });
  const detailQuery = useQuery({
    queryKey: ['stocktake', activeId],
    queryFn: () => api.getStocktake(activeId!),
    enabled: !!activeId,
  });

  // 发起盘点 → 创建（全品类快照）→ 直接进入录入
  const startStocktake = async () => {
    setBusy(true);
    try {
      const res: any = await api.createStocktake();
      if (res && res.stocktake) {
        message.success(`盘点单 ${res.stocktake.id} 已创建，账面数据已快照`);
        setActiveId(res.stocktake.id);
        setDraft(res.stocktake.items || []);
        setView('form');
        qc.invalidateQueries({ queryKey: ['stocktakes'] });
      } else {
        message.error(res?.error || '创建失败');
      }
    } catch (e) {
      message.error((e as Error).message || '创建失败');
    } finally {
      setBusy(false);
    }
  };

  // 加载历史单进入查看/继续录入
  const openStocktake = async (id: string, status: string) => {
    setActiveId(id);
    setView('form');
    if (status === 'draft') {
      // 草稿：等详情加载后写入本地副本
      const d = await api.getStocktake(id).catch(() => null);
      setDraft(d ? d.items || [] : []);
    } else {
      setDraft(null); // 已完成：只读展示
    }
  };

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['stocktakes'] });
    qc.invalidateQueries({ queryKey: ['stocktake', activeId] });
    qc.invalidateQueries({ queryKey: ['inventory'] });
    qc.invalidateQueries({ queryKey: ['transactions'] });
    qc.invalidateQueries({ queryKey: ['sn-registry'] });
  };

  // ===== 录入操作 =====
  const setActualQty = (invType: string, val: number | null) => {
    setDraft(prev => (prev || []).map(it => it.invType === invType ? { ...it, actualQty: val } : it));
  };
  const toggleSn = (invType: string, snCode: string, present: boolean) => {
    setDraft(prev => (prev || []).map(it => it.invType === invType ? {
      ...it,
      snList: (it.snList || []).map((s: any) => s.snCode === snCode ? { ...s, present } : s),
    } : it));
  };
  const setExtraSns = (invType: string, text: string) => {
    const arr = text.split(/[\n\r,;，；\s]+/).map(s => s.trim()).filter(Boolean);
    setDraft(prev => (prev || []).map((it: any) => it.invType === invType ? { ...it, extraSns: arr } : it));
  };

  // 汇总：当前录入的差异
  const diffSummary = useMemo(() => {
    if (!draft) return { adjusted: 0, totalDiff: 0, pending: 0 };
    let adjusted = 0, totalDiff = 0, pending = 0;
    for (const it of draft) {
      if (it.mode === 'quantity') {
        if (it.actualQty == null) { pending++; continue; }
        const diff = it.actualQty - it.bookQty;
        if (diff !== 0) { adjusted++; totalDiff += diff; }
      } else {
        const missing = (it.snList || []).filter((s: any) => s.present === false).length;
        const extra = (it.extraSns || []).length;
        if (missing > 0 || extra > 0) { adjusted++; totalDiff += extra - missing; }
      }
    }
    return { adjusted, totalDiff, pending };
  }, [draft]);

  // 保存草稿
  const saveDraft = async (silent = false) => {
    if (!activeId || !draft) return;
    const payload = draft.map((it: any) => it.mode === 'quantity'
      ? { invType: it.invType, actualQty: it.actualQty }
      : {
          invType: it.invType,
          missingSns: (it.snList || []).filter((s: any) => s.present === false).map((s: any) => s.snCode),
          presentSns: (it.snList || []).filter((s: any) => s.present !== false).map((s: any) => s.snCode),
          extraSns: it.extraSns || [],
        });
    try {
      await api.saveStocktake(activeId, payload);
      if (!silent) message.success('已保存，可稍后继续');
      refresh();
    } catch (e) {
      message.error((e as Error).message || '保存失败');
    }
  };

  // 完成盘点
  const completeNow = async () => {
    if (!activeId) return;
    Modal.confirm({
      title: '完成盘点',
      content: `共 ${diffSummary.adjusted} 个品类有差异（净差异 ${diffSummary.totalDiff > 0 ? '+' : ''}${diffSummary.totalDiff} 件），${diffSummary.pending} 个品类未录入（将跳过不调整）。确认执行差异调整？`,
      okText: '执行调整',
      cancelText: '再检查一下',
      onOk: async () => {
        await saveDraft(true);
        setBusy(true);
        try {
          const res: any = await api.completeStocktake(activeId);
          if (res && res.success) {
            message.success('盘点完成，差异已调整');
            setView('list'); setActiveId(null); setDraft(null);
            refresh();
          } else {
            message.error(res?.error || '完成失败');
          }
        } catch (e) {
          message.error((e as Error).message || '完成失败');
        } finally {
          setBusy(false);
        }
      },
    });
  };

  const cancelNow = async (id: string) => {
    try {
      await api.cancelStocktake(id);
      message.success('盘点单已取消');
      setView('list'); setActiveId(null); setDraft(null);
      refresh();
    } catch (e) {
      message.error((e as Error).message || '取消失败');
    }
  };

  // ==================== 渲染 ====================
  if (!admin) {
    return (
      <PageContainer title="📋 库存盘点">
        <Card><div style={{ opacity: 0.6 }}>无权限访问</div></Card>
      </PageContainer>
    );
  }

  const labelOf = (t: string) => typeLabelOf(t, inventoryConfig.data);

  // ---------- 列表视图 ----------
  if (view === 'list') {
    const rows = (listQuery.data || []).filter((s: any) => !search
      || String(s.id).includes(search)
      || String(s.createdBy || '').toLowerCase().includes(search.toLowerCase()));
    const columns: any[] = [
      { title: '盘点单号', dataIndex: 'id', width: 170, render: (v: string) => <Typography.Text code>{v}</Typography.Text> },
      { title: '状态', dataIndex: 'status', width: 90, render: (v: string) => v === 'draft'
        ? <Tag color="orange">进行中</Tag> : <Tag color="green">已完成</Tag> },
      { title: '品类数', dataIndex: 'itemCount', width: 80 },
      { title: '差异品类', width: 100, render: (_: any, s: any) => {
        if (s.status !== 'completed' || !s.result) return '-';
        return s.result.adjustedCount > 0 ? <Tag color="red">{s.result.adjustedCount}</Tag> : '0';
      } },
      { title: '净差异', width: 90, render: (_: any, s: any) => {
        if (s.status !== 'completed' || !s.result) return '-';
        const d = s.result.totalDiff || 0;
        return d === 0 ? '0' : <span style={{ color: d > 0 ? '#22c55e' : '#ef4444', fontWeight: 700 }}>{d > 0 ? '+' : ''}{d}</span>;
      } },
      { title: '创建', dataIndex: 'createdAt', width: 165, render: (v: string) => formatTime(v) },
      { title: '创建人', dataIndex: 'createdBy', width: 100 },
      { title: '完成时间', dataIndex: 'completedAt', width: 165, render: (v: string) => formatTime(v) },
      {
        title: '操作', key: 'act', width: 150,
        render: (_: any, s: any) => (
          <Space size={4}>
            <Button size="small" type="link" onClick={() => openStocktake(s.id, s.status)}>
              {s.status === 'draft' ? '继续录入' : '查看报告'}
            </Button>
            {s.status === 'draft' && (
              <Popconfirm title="取消该盘点单？" onConfirm={() => cancelNow(s.id)} okText="取消单据" cancelText="返回">
                <Button size="small" type="link" danger>取消</Button>
              </Popconfirm>
            )}
          </Space>
        ),
      },
    ];
    return (
      <PageContainer
        title="📋 库存盘点"
        subtitle="定期核对账面与实盘，差异自动调整并留存报告"
        extra={
          <Space>
            <Input.Search placeholder="搜索单号/创建人" allowClear style={{ width: 200 }}
              value={search} onChange={e => setSearch(e.target.value)} />
            <Button type="primary" icon={<PlusOutlined />} loading={busy} onClick={startStocktake}>
              发起全库盘点
            </Button>
          </Space>
        }
      >
        <Alert type="info" showIcon style={{ marginBottom: 12, fontSize: 12 }}
          message="盘点流程：发起时系统快照账面数据 → 逐项录入实盘（SN品类按件勾选，缺失的取消勾选）→ 完成后自动执行差异调整（缺失SN标记报废、盘盈SN入库、数量品类直接修正），全程留痕可追溯。" />
        {rows.length === 0 && !listQuery.isLoading ? (
          <Empty description="暂无盘点记录，点击右上角发起第一次盘点" style={{ marginTop: 60 }} />
        ) : (
          <Table rowKey="id" size="small" loading={listQuery.isLoading} columns={columns}
            dataSource={rows} pagination={{ pageSize: 15, showTotal: t => `共 ${t} 张盘点单` }} />
        )}
      </PageContainer>
    );
  }

  // ---------- 录入/查看视图 ----------
  const detail = detailQuery.data;
  const isDraftMode = detail?.status === 'draft' && draft;
  const items = isDraftMode ? draft : (detail?.items || []);

  const renderQuantityItem = (it: any) => {
    const diff = it.actualQty != null ? it.actualQty - it.bookQty : null;
    return (
      <List.Item>
        <List.Item.Meta
          title={<Space>{labelOf(it.invType)}<Tag>{it.mode === 'quantity' ? '数量' : 'SN'}</Tag></Space>}
          description={`账面：${it.bookQty}`}
        />
        {isDraftMode ? (
          <Space>
            <InputNumber min={0} placeholder="实盘数" value={it.actualQty}
              onChange={v => setActualQty(it.invType, v)} style={{ width: 110 }} />
            {diff != null && diff !== 0 && (
              <Tag color={diff > 0 ? 'green' : 'red'}>{diff > 0 ? `盘盈 ${diff}` : `盘亏 ${Math.abs(diff)}`}</Tag>
            )}
          </Space>
        ) : (
          <span>实盘：{it.actualQty ?? '—'}</span>
        )}
      </List.Item>
    );
  };

  const renderSnItem = (it: any) => {
    const missing = (it.snList || []).filter((s: any) => s.present === false);
    const extra = it.extraSns || [];
    return (
      <List.Item style={{ display: 'block' }}>
        <Flex justify="space-between" align="center" style={{ width: '100%' }}>
          <Space>
            <b>{labelOf(it.invType)}</b>
            <Tag>SN</Tag>
            <span style={{ fontSize: 12, opacity: 0.65 }}>在手 {it.bookQty} 件</span>
            {(missing.length > 0 || extra.length > 0) && (
              <Tag color={(extra.length - missing.length) >= 0 ? 'green' : 'red'}>
                差异 {(extra.length - missing.length) > 0 ? '+' : ''}{extra.length - missing.length}
              </Tag>
            )}
          </Space>
        </Flex>
        <div style={{ marginTop: 8, maxHeight: 220, overflowY: 'auto', border: '1px solid rgba(128,128,128,0.2)', borderRadius: 6, padding: '6px 10px' }}>
          {(it.snList || []).map((s: any) => (
            <Flex key={s.snCode} align="center" style={{ padding: '3px 0' }}>
              {isDraftMode ? (
                <Checkbox checked={s.present !== false}
                  onChange={e => toggleSn(it.invType, s.snCode, e.target.checked)}>
                  <Typography.Text code style={{ fontSize: 12 }}>{s.snCode}</Typography.Text>
                </Checkbox>
              ) : (
                <span style={{ fontSize: 12, opacity: s.present === false ? 0.4 : 1, textDecoration: s.present === false ? 'line-through' : 'none' }}>
                  {s.present === false ? '❌ ' : '✓ '}<Typography.Text code style={{ fontSize: 12 }}>{s.snCode}</Typography.Text>
                </span>
              )}
            </Flex>
          ))}
          {(it.snList || []).length === 0 && <div style={{ fontSize: 12, opacity: 0.5, padding: '4px 0' }}>无在手 SN</div>}
        </div>
        {isDraftMode && (
          <div style={{ marginTop: 8 }}>
            <Input.TextArea rows={2} placeholder="盘盈SN码（逗号/换行/空格分隔，选填）"
              value={(it.extraSns || []).join('\n')}
              onChange={e => setExtraSns(it.invType, e.target.value)}
              style={{ fontFamily: 'monospace', fontSize: 12 }} />
          </div>
        )}
        {!isDraftMode && (missing.length > 0 || extra.length > 0) && (
          <div style={{ marginTop: 8, fontSize: 12 }}>
            {missing.length > 0 && <div style={{ color: '#ef4444' }}>缺失（已标报废）：{missing.map((s: any) => s.snCode).join(', ')}</div>}
            {extra.length > 0 && <div style={{ color: '#22c55e' }}>盘盈（已入库）：{extra.join(', ')}</div>}
          </div>
        )}
      </List.Item>
    );
  };

  return (
    <PageContainer
      title={<span>📋 盘点单 <Typography.Text code>{activeId}</Typography.Text></span>}
      subtitle={detail ? `创建于 ${formatTime(detail.createdAt)} · ${detail.createdBy}` : ''}
      extra={
        <Space>
          <Button icon={<RollbackOutlined />} onClick={() => { setView('list'); setActiveId(null); setDraft(null); }}>返回列表</Button>
          {isDraftMode && <Button icon={<FileSearchOutlined />} onClick={() => saveDraft()}>保存进度</Button>}
          {isDraftMode && (
            <Button type="primary" icon={<CheckCircleOutlined />} loading={busy} onClick={completeNow}>
              完成盘点
            </Button>
          )}
        </Space>
      }
    >
      {detailQuery.isLoading ? (
        <Card><div style={{ textAlign: 'center', padding: 40 }}>加载中...</div></Card>
      ) : !detail ? (
        <Empty description="盘点单不存在" style={{ marginTop: 60 }} />
      ) : (
        <>
          {detail.status === 'completed' && detail.result && (
            <Row gutter={12} style={{ marginBottom: 12 }}>
              <Col span={8}><Card size="small"><Statistic title="差异品类数" value={detail.result.adjustedCount} /></Card></Col>
              <Col span={8}><Card size="small"><Statistic title="净差异" value={detail.result.totalDiff}
                valueStyle={{ color: detail.result.totalDiff > 0 ? '#22c55e' : detail.result.totalDiff < 0 ? '#ef4444' : undefined }} suffix="件" /></Card></Col>
              <Col span={8}><Card size="small"><Statistic title="完成时间" value={formatTime(detail.completedAt)} valueStyle={{ fontSize: 18 }} /></Card></Col>
            </Row>
          )}
          {isDraftMode && (
            <Alert type="warning" showIcon style={{ marginBottom: 12, fontSize: 12 }}
              message={`已录入差异：${diffSummary.adjusted} 个品类（净 ${diffSummary.totalDiff > 0 ? '+' : ''}${diffSummary.totalDiff} 件）· ${diffSummary.pending} 个品类未录入（完成时将跳过）。勾选=实盘存在，取消勾选=缺失。`} />
          )}
          <Row gutter={12}>
            <Col xs={24} lg={12}>
              <Card size="small" title="数量跟踪品类（填实盘数）">
                <List size="small" dataSource={items.filter((it: any) => it.mode === 'quantity')}
                  locale={{ emptyText: '无数量跟踪品类' }}
                  renderItem={renderQuantityItem} />
              </Card>
            </Col>
            <Col xs={24} lg={12}>
              <Card size="small" title="SN 跟踪品类（按件勾选）">
                <List size="small" dataSource={items.filter((it: any) => it.mode === 'sn')}
                  locale={{ emptyText: '无 SN 跟踪品类' }}
                  renderItem={renderSnItem} />
              </Card>
            </Col>
          </Row>
          {detail.status === 'completed' && detail.result && detail.result.adjustments?.length > 0 && (
            <Card size="small" title="差异调整明细" style={{ marginTop: 12 }}>
              <Table rowKey={(_, i) => String(i)} size="small" pagination={false}
                dataSource={detail.result.adjustments}
                columns={[
                  { title: '品类', dataIndex: 'invType', render: (v: string) => labelOf(v) },
                  { title: '模式', dataIndex: 'mode', width: 80, render: (v: string) => <Tag>{v === 'quantity' ? '数量' : 'SN'}</Tag> },
                  { title: '账面', dataIndex: 'bookQty', width: 80 },
                  { title: '调整', dataIndex: 'diff', width: 90, render: (v: number) => v === 0 ? '0'
                    : <span style={{ color: v > 0 ? '#22c55e' : '#ef4444', fontWeight: 700 }}>{v > 0 ? '+' : ''}{v}</span> },
                  { title: '说明', render: (_: any, a: any) => a.mode === 'sn'
                    ? `${a.missingSns?.length || 0} 件缺失报废、${a.extraSns?.length || 0} 件盘盈入库`
                    : `账面 ${a.bookQty} → 实盘 ${a.actualQty}` },
                ]} />
            </Card>
          )}
        </>
      )}
    </PageContainer>
  );
}

export { StocktakePage };
