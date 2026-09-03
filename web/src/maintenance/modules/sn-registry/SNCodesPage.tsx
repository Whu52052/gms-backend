// SN码管理页（移植 js/ui/sn-registry.js + attachments.js）：
// 注册表 + 流水合并视图，使用中/闲置/售后损坏分组，附件上传，标记损坏，删除
import { useMemo, useRef, useState } from 'react';
import {
  Button, Card, Col, Empty, Flex, Input, Modal, Pagination, Popconfirm, Radio, Row,
  Space, Statistic, Table, Tag, Tooltip, Typography, message,
} from 'antd';
import { AppstoreOutlined, DeleteOutlined, PaperClipOutlined, TableOutlined, WarningOutlined } from '@ant-design/icons';
import { useQueryClient } from '@tanstack/react-query';
import { post } from '@common/api/http';
import { PageContainer } from '@common/components/PageContainer';
import { useSNRegistry, useTransactions, useInventoryConfig } from '@common/hooks/useData';
import { useAuthStore, isAdmin } from '@common/stores/auth';
import { formatTime } from '@common/utils/format';
import * as api from '@common/api';

const PAGE_SIZE = 24;
const DELETED_SNS_KEY = 'gms_deleted_sns';
const SN_RELATED_TYPES = ['glove', 'dexterous_hand', 'left_glove', 'right_glove', 'left_dexterous_hand', 'right_dexterous_hand'];

function getDeletedSns(): Set<string> {
  try { return new Set(JSON.parse(localStorage.getItem(DELETED_SNS_KEY) || '[]')); } catch { return new Set(); }
}

function addDeletedSn(snCode: string) {
  const set = getDeletedSns();
  set.add(snCode);
  localStorage.setItem(DELETED_SNS_KEY, JSON.stringify(Array.from(set)));
}

// 图片压缩（移植旧版 _compressImage：最大边 1024，jpeg 0.75）
function compressImage(file: File): Promise<string | null> {
  return new Promise(resolve => {
    if (!file.type.startsWith('image/')) {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(file);
      return;
    }
    const img = new Image();
    img.onload = () => {
      const maxDim = 1024;
      let w = img.width, h = img.height;
      if (w > maxDim || h > maxDim) {
        const ratio = Math.min(maxDim / w, maxDim / h);
        w = Math.round(w * ratio); h = Math.round(h * ratio);
      }
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      canvas.getContext('2d')?.drawImage(img, 0, 0, w, h);
      resolve(canvas.toDataURL('image/jpeg', 0.75));
    };
    img.onerror = () => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(file);
    };
    img.src = URL.createObjectURL(file);
  });
}

const hasValidAttachment = (a?: string) =>
  !!a && (a.startsWith('data:') || a.startsWith('http://') || a.startsWith('https://') || a.startsWith('/uploads/'));
const isImageAttachment = (a?: string) =>
  !!hasValidAttachment(a) && (a!.startsWith('data:image/') || /\.(jpg|jpeg|png|gif|webp|svg)(\?|$)/i.test(a!));

/** 合并 registry 与流水，构建展示条目（移植 _doRenderSNCodes 数据逻辑） */
function buildSNList(registry: any[], transactions: any[], invConfig: any[]) {
  const invCfgMap: Record<string, any> = {};
  invConfig.forEach(c => {
    invCfgMap[c.id] = c;
    if (c.hasLeftRight) {
      invCfgMap[c.id + '_left'] = { name: c.name + '左手' };
      invCfgMap[c.id + '_right'] = { name: c.name + '右手' };
    }
  });
  const getLabel = (t: any) => {
    if (t.equipmentType === 'glove') return t.handType === 'left' ? '左手手套' : '右手手套';
    if (t.equipmentType === 'dexterous_hand') return t.handType === 'left' ? '左手灵巧手' : '右手灵巧手';
    return invCfgMap[t.equipmentType]?.name || t.equipmentType;
  };
  const getHandLabel = (t: any) => {
    if (t.handType === 'left' || (t.equipmentType && t.equipmentType.endsWith('_left'))) return '左手';
    if (t.handType === 'right' || (t.equipmentType && t.equipmentType.endsWith('_right'))) return '右手';
    return '';
  };

  const snMap: Record<string, any> = {};
  registry.forEach(r => {
    if (!r.snCode || r.status === '_deleted') return;
    let typeLabel = r.equipmentType || '';
    let handLabel = '';
    if (r.equipmentType === 'glove') {
      typeLabel = r.handType === 'left' ? '左手手套' : '右手手套';
      handLabel = r.handType === 'left' ? '左手' : '右手';
    } else if (r.equipmentType === 'dexterous_hand') {
      typeLabel = r.handType === 'left' ? '左手灵巧手' : '右手灵巧手';
      handLabel = r.handType === 'left' ? '左手' : '右手';
    } else {
      const cfg = invCfgMap[r.equipmentType];
      if (cfg) typeLabel = cfg.name;
    }
    snMap[r.snCode] = {
      snCode: r.snCode, type: typeLabel, handLabel, attachment: r.attachment || '',
      latest: { timestamp: r.updatedAt || new Date().toISOString(), direction: 'in', snCode: r.snCode, equipmentType: r.equipmentType, handType: r.handType },
    };
  });

  const deletedSns = getDeletedSns();
  const allSnTxs = (transactions || []).filter(t => SN_RELATED_TYPES.includes(t.equipmentType) && t.snCode);
  allSnTxs.forEach(t => {
    const key = t.snCode;
    if (deletedSns.has(key)) return;
    if (!snMap[key]) {
      snMap[key] = { snCode: key, type: getLabel(t), handLabel: getHandLabel(t), attachment: '', latest: t };
    } else {
      if (t.attachment && !snMap[key].attachment) snMap[key].attachment = t.attachment;
      if (new Date(t.timestamp).getTime() > new Date(snMap[key].latest.timestamp).getTime()) snMap[key].latest = t;
    }
  });

  const regLookup: Record<string, any> = {};
  registry.forEach(r => { if (r.snCode) regLookup[r.snCode] = r; });

  const snList = Object.values(snMap).filter(sn => regLookup[sn.snCode] && regLookup[sn.snCode].status !== '_deleted');
  snList.forEach(sn => {
    const reg = regLookup[sn.snCode];
    if (reg.status === 'damaged') { sn.status = '损坏'; sn.machine = reg.damageReason || ''; }
    else if (reg.status === 'in_repair') { sn.status = '售后中'; sn.machine = reg.trackingNumber || ''; }
    else if (reg.status === 'in_use') { sn.status = '在用'; sn.machine = reg.machineNumber || ''; }
    else if (reg.status === 'available') { sn.status = '可用'; sn.machine = ''; }
    else {
      const latestTx = allSnTxs.filter(t => t.snCode === sn.snCode)
        .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())[0];
      if (latestTx && latestTx.direction === 'out' && latestTx.machineNumber) {
        sn.status = '在用'; sn.machine = latestTx.machineNumber;
      } else { sn.status = '可用'; sn.machine = ''; }
    }
    sn.group = reg.status === 'in_use' ? 'inuse' : (reg.status === 'damaged' || reg.status === 'in_repair') ? 'damaged' : 'idle';
  });
  snList.sort((a, b) => new Date(b.latest.timestamp).getTime() - new Date(a.latest.timestamp).getTime());
  return snList;
}

const SN_STATUS_TAG: Record<string, string> = { '在用': 'green', '可用': 'blue', '损坏': 'red', '售后中': 'orange' };

// ==================== 附件管理弹窗 ====================
function AttachmentModal({ sn, privileged, onClose, onChanged }: {
  sn: any | null; privileged: boolean; onClose: () => void; onChanged: () => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const attachment = sn?.attachment || '';
  const hasValid = hasValidAttachment(attachment);
  const isImage = isImageAttachment(attachment);

  const doUpload = async (file: File) => {
    if (!sn) return;
    if (!file.type.startsWith('image/')) { message.error('只支持图片文件'); return; }
    if (file.size > 10 * 1024 * 1024) { message.error('文件大小超过限制(最大10MB)'); return; }
    setUploading(true);
    try {
      const dataUrl = await compressImage(file);
      if (!dataUrl) throw new Error('读取图片失败');
      const res = await post<{ path?: string; error?: string }>('/api/upload', { filename: file.name, data: dataUrl }, 30000);
      if (!res?.path) throw new Error(res?.error || '上传失败');
      const old = attachment;
      const upsertRes: any = await api.upsertSNRegistry({ snCode: sn.snCode, attachment: res.path });
      if (upsertRes && upsertRes.error) throw new Error(upsertRes.error);
      // 新附件确认保存后再删除旧附件文件
      if (old && old.startsWith('/uploads/')) api.deleteUpload(old).catch(() => {});
      message.success(`${sn.snCode} 照片已更新`);
      onChanged();
      onClose();
    } catch (e: any) {
      message.error(`上传失败: ${e?.message || '未知错误'}`);
    } finally {
      setUploading(false);
    }
  };

  const doDelete = async () => {
    if (!sn) return;
    try {
      const res: any = await api.upsertSNRegistry({ snCode: sn.snCode, attachment: '' });
      if (res && res.error) { message.error(`删除失败: ${res.error}`); return; }
      message.success('附件已删除');
      onChanged();
      onClose();
    } catch (e: any) {
      message.error(`删除失败: ${e?.message || ''}`);
    }
  };

  return (
    <Modal title={`📎 ${sn?.snCode} 附件管理`} open={!!sn} onCancel={onClose} footer={null}>
      <div style={{ textAlign: 'center' }}>
        {hasValid ? (
          isImage
            ? <img src={attachment} alt={sn.snCode} style={{ maxWidth: '100%', maxHeight: '60vh', borderRadius: 8 }} />
            : <Button type="primary" href={attachment} target="_blank">打开附件</Button>
        ) : (
          <div style={{ padding: '40px 20px', opacity: 0.5 }}>
            <PaperClipOutlined style={{ fontSize: 36 }} />
            <div style={{ marginTop: 8 }}>暂无附件</div>
          </div>
        )}
      </div>
      {privileged && (
        <Flex gap={8} justify="center" style={{ marginTop: 16 }}>
          <input ref={fileRef} type="file" accept="image/*" style={{ display: 'none' }}
            onChange={e => { const f = e.target.files?.[0]; if (f) doUpload(f); e.target.value = ''; }} />
          <Button type="primary" loading={uploading} onClick={() => fileRef.current?.click()}>
            {hasValid ? '重新上传' : '上传附件'}
          </Button>
          {hasValid && <Button danger onClick={doDelete}>删除附件</Button>}
        </Flex>
      )}
    </Modal>
  );
}

// ==================== 主页面 ====================
export default function SNCodesPage() {
  const { data: registry = [], isLoading } = useSNRegistry();
  const { data: transactions = [] } = useTransactions();
  const { data: invConfig = [] } = useInventoryConfig();
  const user = useAuthStore(s => s.user);
  const privileged = isAdmin(user);
  const qc = useQueryClient();

  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [viewMode, setViewMode] = useState<'card' | 'table'>('card');
  const [page, setPage] = useState(1);
  const [attachSn, setAttachSn] = useState<any | null>(null);
  const [damageSn, setDamageSn] = useState<any | null>(null);
  const [damageReason, setDamageReason] = useState('');

  const snList = useMemo(() => buildSNList(registry, transactions, invConfig), [registry, transactions, invConfig]);

  const counts = useMemo(() => ({
    all: snList.length,
    inuse: snList.filter(s => s.group === 'inuse').length,
    idle: snList.filter(s => s.group === 'idle').length,
    damaged: snList.filter(s => s.group === 'damaged').length,
  }), [snList]);

  const filtered = useMemo(() => {
    let list = snList;
    if (filter !== 'all') list = list.filter(s => s.group === filter);
    const q = search.trim().toLowerCase();
    if (q) {
      list = list.filter(s =>
        s.snCode.toLowerCase().includes(q) ||
        String(s.type || '').toLowerCase().includes(q) ||
        String(s.machine || '').toLowerCase().includes(q));
    }
    return list;
  }, [snList, filter, search]);

  const invalidateAll = () => {
    qc.invalidateQueries({ queryKey: ['sn-registry'] });
    qc.invalidateQueries({ queryKey: ['inventory'] });
    qc.invalidateQueries({ queryKey: ['transactions'] });
  };

  // 标记损坏（移植 _markAsDamaged）：出库流水 + 注册表改状态
  // 注意：库存由服务端在 upsertSNRegistry 后从注册表自动重算（_syncInventoryFromSN），
  // 前端不可再调 adjustInventory（SN 化库存下它会额外删除一只随机可用 SN）
  const markDamaged = async () => {
    const reg = registry.find(r => r.snCode === damageSn?.snCode);
    if (!reg || reg.status !== 'available') { message.error('该SN码不是空闲状态，无法标记损坏'); return; }
    const reason = damageReason.trim();
    if (!reason) { message.error('请填写损坏原因'); return; }
    const username = user?.username || '系统';
    try {
      await api.addTransaction({
        equipmentType: reg.equipmentType, handType: reg.handType, direction: 'out',
        quantity: 1, snCode: reg.snCode, updatedBy: username, note: `直接标记损坏: ${reason}`,
      });
      await api.upsertSNRegistry({
        snCode: reg.snCode, equipmentType: reg.equipmentType, handType: reg.handType,
        status: 'damaged', machineNumber: '', damageReason: reason, updatedBy: username,
      });
      message.success(`${reg.snCode} 已标记为损坏`);
      setDamageSn(null); setDamageReason('');
      invalidateAll();
    } catch (e: any) {
      message.error(e?.message || '操作失败');
    }
  };

  // 删除SN（移植 _deleteSNCode）：拦截在用；删附件文件；写删除流水
  const deleteSN = async (snCode: string) => {
    const reg = registry.find(r => r.snCode === snCode);
    if (reg && reg.status === 'in_use') {
      message.warning(`SN码 ${snCode} 当前正在机器【${reg.machineNumber || '-'}】上使用，请先下线该机器后再删除。`);
      return;
    }
    try {
      const data: any = await api.deleteSNFull(snCode);
      if (!data || !data.success) { message.error(data?.message || '删除失败'); return; }
    } catch {
      message.error('网络错误');
      return;
    }
    addDeletedSn(snCode);
    // 同步删除服务端附件文件，避免孤儿文件
    if (reg?.attachment && reg.attachment.startsWith('/uploads/')) {
      api.deleteUpload(reg.attachment).catch(() => {});
    }
    // 写入删除流水保留审计轨迹
    // 库存由服务端 deleteSNFull 内部从注册表自动重算，前端不再额外扣减
    if (reg) {
      api.addTransaction({
        equipmentType: reg.equipmentType, handType: reg.handType, direction: 'out',
        quantity: 1, snCode, updatedBy: user?.username || '系统', note: `删除SN码（${reg.status || '未知'}）`,
      }).catch(() => {});
    }
    message.success(`${snCode} 已删除`);
    invalidateAll();
  };

  const columns: any[] = [
    { title: 'SN码', dataIndex: 'snCode', render: (v: string) => <Typography.Text code>{v}</Typography.Text> },
    { title: '设备类型', render: (_: any, s: any) => `${s.type}${s.handLabel ? ` · ${s.handLabel}` : ''}` },
    { title: '状态', dataIndex: 'status', width: 90, render: (v: string) => <Tag color={SN_STATUS_TAG[v] || 'default'}>{v}</Tag> },
    { title: '所属机器/原因', dataIndex: 'machine', ellipsis: true, render: (v: string) => v || '-' },
    { title: '最后操作', width: 170, render: (_: any, s: any) => formatTime(s.latest.timestamp) },
    {
      title: '附件', width: 70,
      render: (_: any, s: any) => (hasValidAttachment(s.attachment)
        ? <a onClick={() => setAttachSn(s)}><PaperClipOutlined /></a>
        : <a onClick={() => setAttachSn(s)} style={{ opacity: 0.35 }}><PaperClipOutlined /></a>),
    },
    {
      title: '操作', width: 100,
      render: (_: any, s: any) => (
        <Space size={4}>
          {s.status === '可用' && (
            <Tooltip title="标记损坏"><Button type="text" size="small" icon={<WarningOutlined style={{ color: '#d97706' }} />} onClick={() => { setDamageSn(s); setDamageReason(''); }} /></Tooltip>
          )}
          {privileged && (
            <Popconfirm title={`确定要删除 ${s.snCode}？此操作不可恢复！`} onConfirm={() => deleteSN(s.snCode)}>
              <Button type="text" danger size="small" icon={<DeleteOutlined />} />
            </Popconfirm>
          )}
        </Space>
      ),
    },
  ];

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const curPage = Math.min(page, totalPages);
  const pageItems = viewMode === 'card' ? filtered.slice((curPage - 1) * PAGE_SIZE, curPage * PAGE_SIZE) : filtered;

  return (
    <PageContainer
      title="SN码管理"
      subtitle="SN 全生命周期跟踪 · 附件/损坏/删除管理"
      extra={
        <Button
          icon={viewMode === 'card' ? <TableOutlined /> : <AppstoreOutlined />}
          onClick={() => setViewMode(viewMode === 'card' ? 'table' : 'card')}
        >
          {viewMode === 'card' ? '表格' : '卡片'}
        </Button>
      }
    >
      {/* 统计卡片 */}
      <Row gutter={12} style={{ marginBottom: 12 }}>
        <Col span={6}><Card size="small"><Statistic title="SN总数" value={counts.all} /></Card></Col>
        <Col span={6}><Card size="small"><Statistic title="使用中" value={counts.inuse} valueStyle={{ color: '#22c55e' }} /></Card></Col>
        <Col span={6}><Card size="small"><Statistic title="闲置可用" value={counts.idle} valueStyle={{ color: '#f59e0b' }} /></Card></Col>
        <Col span={6}><Card size="small"><Statistic title="售后/损坏" value={counts.damaged} valueStyle={{ color: '#ef4444' }} /></Card></Col>
      </Row>

      {/* 筛选栏 */}
      <Flex wrap gap={8} align="center" style={{ marginBottom: 12 }}>
        <Radio.Group value={filter} onChange={e => { setFilter(e.target.value); setPage(1); }} optionType="button" buttonStyle="solid">
          <Radio.Button value="all">全部 ({counts.all})</Radio.Button>
          <Radio.Button value="inuse">使用中 ({counts.inuse})</Radio.Button>
          <Radio.Button value="idle">闲置 ({counts.idle})</Radio.Button>
          <Radio.Button value="damaged">售后 ({counts.damaged})</Radio.Button>
        </Radio.Group>
        <Input.Search
          placeholder="搜索SN码/类型..."
          allowClear
          style={{ width: 220 }}
          value={search}
          onChange={e => { setSearch(e.target.value); setPage(1); }}
        />
      </Flex>

      {filtered.length === 0 && !isLoading ? (
        <Empty description="暂无SN码记录" style={{ marginTop: 60 }} />
      ) : viewMode === 'table' ? (
        <Table rowKey="snCode" size="small" loading={isLoading} columns={columns} dataSource={pageItems}
          pagination={{ pageSize: 20, showSizeChanger: true, showTotal: t => `共 ${t} 条` }} />
      ) : (
        <>
          <Row gutter={[12, 12]}>
            {pageItems.map(s => (
              <Col key={s.snCode} xs={24} sm={12} md={8} lg={6}>
                <Card
                  size="small"
                  hoverable
                  style={{ borderLeft: `3px solid ${s.status === '在用' ? '#22c55e' : s.status === '可用' ? '#3b82f6' : s.status === '售后中' ? '#f59e0b' : '#ef4444'}` }}
                >
                  <div style={{ fontWeight: 600 }}><Typography.Text code style={{ fontSize: 12 }}>{s.snCode}</Typography.Text></div>
                  <div style={{ fontSize: 12, opacity: 0.75, margin: '4px 0' }}>{s.type}{s.handLabel ? ` · ${s.handLabel}` : ''}</div>
                  {s.machine && <div style={{ fontSize: 12, opacity: 0.65, marginBottom: 4 }}>{s.status === '在用' ? '🖥 ' : ''}{s.machine}</div>}
                  <Flex align="center" gap={6} wrap style={{ marginTop: 6 }}>
                    <span style={{ fontSize: 11, opacity: 0.6 }}>{formatTime(s.latest.timestamp)}</span>
                    <span style={{ marginLeft: 'auto' }}>
                      <Space size={4}>
                        <Tooltip title={hasValidAttachment(s.attachment) ? '查看附件' : '上传附件'}>
                          <Button type="text" size="small" icon={<PaperClipOutlined />} onClick={() => setAttachSn(s)} />
                        </Tooltip>
                        {s.status === '可用' && (
                          <Tooltip title="标记损坏">
                            <Button type="text" size="small" icon={<WarningOutlined style={{ color: '#d97706' }} />} onClick={() => { setDamageSn(s); setDamageReason(''); }} />
                          </Tooltip>
                        )}
                        {privileged && (
                          <Popconfirm title={`确定要删除 ${s.snCode}？此操作不可恢复！`} onConfirm={() => deleteSN(s.snCode)}>
                            <Button type="text" danger size="small" icon={<DeleteOutlined />} />
                          </Popconfirm>
                        )}
                        <Tag color={SN_STATUS_TAG[s.status] || 'default'}>{s.status}</Tag>
                      </Space>
                    </span>
                  </Flex>
                </Card>
              </Col>
            ))}
          </Row>
          {filtered.length > PAGE_SIZE && (
            <Flex justify="flex-end" style={{ marginTop: 16 }}>
              <Pagination current={curPage} pageSize={PAGE_SIZE} total={filtered.length} onChange={setPage} showTotal={t => `共 ${t} 条`} />
            </Flex>
          )}
        </>
      )}

      {/* 附件管理 */}
      <AttachmentModal sn={attachSn} privileged={privileged} onClose={() => setAttachSn(null)} onChanged={invalidateAll} />

      {/* 标记损坏 */}
      <Modal
        title="标记为损坏"
        open={!!damageSn}
        onCancel={() => setDamageSn(null)}
        onOk={markDamaged}
        okText="确认标记"
        okButtonProps={{ danger: true }}
      >
        <div style={{ marginBottom: 12 }}>
          <Typography.Text code>{damageSn?.snCode}</Typography.Text>
          <span style={{ marginLeft: 8, opacity: 0.7 }}>{damageSn?.type}</span>
        </div>
        <Input placeholder="描述损坏情况" value={damageReason} onChange={e => setDamageReason(e.target.value)} />
      </Modal>
    </PageContainer>
  );
}
