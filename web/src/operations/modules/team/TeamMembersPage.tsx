// 组员管理（移植 OpsApp.renderTeamMembers 及调配/维修统计逻辑）：
// 我的组员 + 其他组（调入）+ 待处理调配（审批）+ 调配记录；点击组员查看维修统计
import { useState } from 'react';
import {
  App as AntApp, Avatar, Button, Card, DatePicker, Empty, Flex, Form, Input, Modal,
  Select, Space, Spin, Table, Tag,
} from 'antd';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import dayjs from 'dayjs';
import { PageContainer } from '@common/components/PageContainer';
import { useAuthStore, isAdmin } from '@common/stores/auth';
import * as api from '@common/api';
import { fmtDuration } from '../common/opsLocalData';

const AVATAR_COLORS = ['#6366f1', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899'];

export default function TeamMembersPage() {
  const user = useAuthStore(s => s.user);
  const { message } = AntApp.useApp();
  const queryClient = useQueryClient();
  const isLeader = isAdmin(user);

  const membersQuery = useQuery({ queryKey: ['group-members'], queryFn: () => api.getGroupMembers(), enabled: isLeader });
  const transfersQuery = useQuery({ queryKey: ['group-transfers'], queryFn: () => api.getGroupTransfers(), enabled: isLeader });
  const subordinatesQuery = useQuery({ queryKey: ['subordinates'], queryFn: () => api.getSubordinates(), enabled: isLeader });

  // 调配弹窗
  const [transferOpen, setTransferOpen] = useState(false);
  const [transferInfo, setTransferInfo] = useState<{ userId: string; username: string; direction: 'in' | 'out'; fromAdminId?: string; fromAdminName?: string }>({ userId: '', username: '', direction: 'out' });
  const [transferForm] = Form.useForm();

  // 组员维修统计弹窗
  const [statsOpen, setStatsOpen] = useState(false);
  const [statsUser, setStatsUser] = useState<{ id: string; name: string } | null>(null);
  const [stats, setStats] = useState<any>(null);
  const [statsLoading, setStatsLoading] = useState(false);
  const [statsRange, setStatsRange] = useState<[string, string]>(['', '']);

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['group-members'] });
    queryClient.invalidateQueries({ queryKey: ['group-transfers'] });
    queryClient.invalidateQueries({ queryKey: ['subordinates'] });
  };

  if (!isLeader) {
    return (
      <PageContainer title="👥 组员">
        <Card><Empty description="仅组长和管理员可查看组员管理" /></Card>
      </PageContainer>
    );
  }

  const groups = membersQuery.data || [];
  const transfers = transfersQuery.data || [];
  const myUsers = subordinatesQuery.data || [];
  const myGroup = groups.find((g: any) => String(g.adminId) === String(user?.id)) || { adminName: user?.username, members: myUsers };
  const pendingTransfers = transfers.filter((t: any) => t.status === 'pending');
  const historyTransfers = transfers.filter((t: any) => t.status !== 'pending');

  // ==================== 调配 ====================
  const startOutTransfer = (userId: string, username: string) => {
    setTransferInfo({ userId, username, direction: 'out' });
    transferForm.resetFields();
    setTransferOpen(true);
  };

  const startInTransfer = (userId: string, username: string, fromAdminId: string, fromAdminName: string) => {
    setTransferInfo({ userId, username, direction: 'in', fromAdminId, fromAdminName });
    transferForm.resetFields();
    setTransferOpen(true);
  };

  const otherAdmins = groups
    .filter((g: any) => String(g.adminId) !== String(user?.id))
    .map((g: any) => ({ value: String(g.adminId), label: `${g.adminName || g.adminId}（${g.members.length}名组员）` }));

  const submitTransfer = async () => {
    const v = await transferForm.validateFields().catch(() => null);
    if (!v) return;
    const info = transferInfo;
    const payload = info.direction === 'out'
      ? { toAdminId: v.toAdminId, userId: info.userId, username: info.username, direction: 'out', reason: (v.reason || '').trim() }
      : { toAdminId: info.fromAdminId, userId: info.userId, username: info.username, direction: 'in', reason: (v.reason || '').trim() };
    try {
      const r: any = await api.createGroupTransfer(payload);
      if (r?.success === false) { message.error(r?.message || r?.error || '发送失败'); return; }
      message.success('调配请求已发送，等待对方组长审批');
      setTransferOpen(false);
      refresh();
    } catch (e: any) {
      message.error(e?.message || '发送失败');
    }
  };

  const doTransferAction = async (id: string, action: 'approve' | 'reject' | 'cancel') => {
    try {
      const r: any = action === 'approve' ? await api.approveGroupTransfer(id)
        : action === 'reject' ? await api.rejectGroupTransfer(id)
          : await api.cancelGroupTransfer(id);
      if (r?.success === false) { message.error(r?.message || r?.error || '操作失败'); return; }
      message.success(action === 'approve' ? '调配已批准，组员已转移' : action === 'reject' ? '调配已拒绝' : '调配请求已取消');
      refresh();
    } catch (e: any) {
      message.error(e?.message || '操作失败');
    }
  };

  // ==================== 组员维修统计 ====================
  const loadStats = async (userId: string, from: string, to: string) => {
    setStatsLoading(true);
    try {
      setStats(await api.getMemberRepairStats(userId, from || undefined, to || undefined));
    } catch { setStats(null); }
    setStatsLoading(false);
  };

  const openStats = (userId: string, name: string) => {
    setStatsUser({ id: userId, name });
    setStatsRange(['', '']);
    setStats(null);
    setStatsOpen(true);
    loadStats(userId, '', '');
  };

  return (
    <PageContainer title="👥 组员管理" extra={<Button onClick={refresh}>⟳ 刷新</Button>}>
      {membersQuery.isLoading ? (
        <div style={{ textAlign: 'center', padding: 60 }}><Spin /></div>
      ) : (
        <>
          {/* 我的组员 */}
          <Card size="small" title={`我的组员（组长：${(myGroup as any).adminName || user?.username}）`} style={{ marginBottom: 16 }}>
            {(myGroup as any).members?.length === 0 ? (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description='暂无组员。通过"添加用户"功能创建用户后自动加入此组。' />
            ) : (
              <Flex gap={12} wrap>
                {(myGroup as any).members.map((m: any, i: number) => (
                  <Card key={m.id} size="small" hoverable style={{ width: 220 }}
                    onClick={() => openStats(String(m.id), m.displayName || m.username || '')}>
                    <Flex align="center" gap={10}>
                      <Avatar style={{ background: AVATAR_COLORS[i % 6] }}>{(m.username || '?')[0].toUpperCase()}</Avatar>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontWeight: 600 }}>{m.username}</div>
                        <div style={{ fontSize: 12, opacity: 0.6 }}>{m.role === 'admin' ? '组长' : '组员'}</div>
                      </div>
                      <Button size="small" onClick={e => { e.stopPropagation(); startOutTransfer(String(m.id), m.username); }}>
                        调出
                      </Button>
                    </Flex>
                  </Card>
                ))}
              </Flex>
            )}
          </Card>

          {/* 其他组 */}
          {groups.filter((g: any) => String(g.adminId) !== String(user?.id)).length > 0 && (
            <Card size="small" title="其他组（可申请调入）" style={{ marginBottom: 16 }}>
              {groups.filter((g: any) => String(g.adminId) !== String(user?.id)).map((g: any) => (
                <div key={String(g.adminId)} style={{ marginBottom: 10, padding: 12, borderRadius: 8, background: 'rgba(128,128,128,.05)' }}>
                  <div style={{ marginBottom: 8 }}>
                    <strong>👥 {g.adminName || g.adminId}</strong>
                    <span style={{ fontSize: 12, opacity: 0.6, marginLeft: 8 }}>{g.members.length} 名组员</span>
                  </div>
                  <Flex gap={6} wrap>
                    {g.members.length === 0 && <span style={{ fontSize: 12, opacity: 0.5 }}>暂无组员</span>}
                    {g.members.map((m: any) => (
                      <Tag key={m.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '4px 10px' }}>
                        {m.username}
                        <Button size="small" type="link" style={{ padding: 0, height: 'auto', fontSize: 12 }}
                          onClick={() => startInTransfer(String(m.id), m.username, String(g.adminId), g.adminName || String(g.adminId))}>
                          调入
                        </Button>
                      </Tag>
                    ))}
                  </Flex>
                </div>
              ))}
            </Card>
          )}

          {/* 待处理调配 */}
          {pendingTransfers.length > 0 && (
            <Card size="small" title="待处理调配" style={{ marginBottom: 16 }}>
              {pendingTransfers.map((t: any) => {
                const isFromMe = String(t.fromAdminId) === String(user?.id);
                return (
                  <div key={t.id} style={{ padding: 12, borderRadius: 8, marginBottom: 8, background: 'rgba(128,128,128,.05)' }}>
                    <Flex gap={8} align="center" wrap>
                      <Tag color={t.direction === 'out' ? 'blue' : 'green'}>{t.direction === 'out' ? '调出' : '调入'}</Tag>
                      <Tag color="orange">待审批</Tag>
                      <span style={{ fontSize: 12, opacity: 0.5 }}>{new Date(t.createdAt).toLocaleString('zh-CN')}</span>
                    </Flex>
                    <div style={{ marginTop: 8, fontSize: 13 }}>
                      <strong>{t.username}</strong>：
                      {t.direction === 'out'
                        ? <>从 <strong>{t.fromAdminName}</strong> 调出至 <strong>{t.toAdminName}</strong></>
                        : <>从 <strong>{t.toAdminName}</strong> 调入至 <strong>{t.fromAdminName}</strong></>}
                      {t.reason && <div style={{ opacity: 0.7, marginTop: 4 }}>原因：{t.reason}</div>}
                    </div>
                    <div style={{ marginTop: 8 }}>
                      {!isFromMe ? (
                        <Space>
                          <Button size="small" type="primary" onClick={() => doTransferAction(t.id, 'approve')}>✓ 同意</Button>
                          <Button size="small" danger onClick={() => doTransferAction(t.id, 'reject')}>✗ 拒绝</Button>
                        </Space>
                      ) : (
                        <Button size="small" onClick={() => doTransferAction(t.id, 'cancel')}>取消请求</Button>
                      )}
                    </div>
                  </div>
                );
              })}
            </Card>
          )}

          {/* 调配记录 */}
          {historyTransfers.length > 0 && (
            <Card size="small" title="调配记录">
              {historyTransfers.slice(0, 20).map((t: any) => (
                <div key={t.id} style={{ padding: 10, borderRadius: 8, marginBottom: 8, background: 'rgba(128,128,128,.04)', opacity: 0.75 }}>
                  <Flex gap={8} align="center" wrap>
                    <Tag color={t.direction === 'out' ? 'blue' : 'green'}>{t.direction === 'out' ? '调出' : '调入'}</Tag>
                    <Tag color={t.status === 'completed' ? 'green' : t.status === 'rejected' ? 'red' : 'default'}>
                      {t.status === 'completed' ? '✓ 已完成' : t.status === 'rejected' ? '✗ 已拒绝' : '⊗ 已取消'}
                    </Tag>
                    <span style={{ fontSize: 12, opacity: 0.5 }}>{new Date(t.updatedAt).toLocaleString('zh-CN')}</span>
                  </Flex>
                  <div style={{ marginTop: 6, fontSize: 13 }}>
                    <strong>{t.username}</strong>：
                    {t.direction === 'out' ? <>{t.fromAdminName} → {t.toAdminName}</> : <>{t.toAdminName} → {t.fromAdminName}</>}
                    {t.status === 'completed' ? ' — 调配已完成' : t.rejectedByName ? ` — 被 ${t.rejectedByName} 拒绝` : ''}
                  </div>
                </div>
              ))}
            </Card>
          )}
        </>
      )}

      {/* 调配弹窗 */}
      <Modal
        title={transferInfo.direction === 'out' ? '调出组员' : '调入组员'}
        open={transferOpen}
        onCancel={() => setTransferOpen(false)}
        onOk={submitTransfer}
        okText="发送请求"
        destroyOnClose
      >
        <Form form={transferForm} layout="vertical" style={{ marginTop: 12 }}>
          <Form.Item label={transferInfo.direction === 'out' ? '调出组员' : '调入组员'}>
            <Input value={transferInfo.username} disabled />
          </Form.Item>
          {transferInfo.direction === 'out' ? (
            <Form.Item name="toAdminId" label="目标组长" rules={[{ required: true, message: '请选择目标组长' }]}>
              <Select options={otherAdmins} placeholder="选择目标组长" notFoundContent="暂无其他组长可调配" />
            </Form.Item>
          ) : (
            <Form.Item label="来源组长">
              <Input value={transferInfo.fromAdminName || ''} disabled />
            </Form.Item>
          )}
          <Form.Item name="reason" label="调配原因">
            <Input.TextArea rows={2} placeholder="可选：调配原因说明" />
          </Form.Item>
        </Form>
      </Modal>

      {/* 组员维修统计弹窗 */}
      <Modal
        title={`组员详情 — ${statsUser?.name || ''}`}
        open={statsOpen}
        onCancel={() => setStatsOpen(false)}
        footer={<Button onClick={() => setStatsOpen(false)}>关闭</Button>}
        width={760}
        destroyOnClose
      >
        {statsLoading ? (
          <div style={{ textAlign: 'center', padding: 40 }}><Spin /></div>
        ) : !stats ? (
          <Empty description="加载失败" />
        ) : (
          <div>
            <Flex gap={12} style={{ marginBottom: 16 }}>
              {[
                { label: '今日维修时长', value: fmtDuration(stats.todayRepairSeconds), color: '#6366f1' },
                { label: '历史维修时长', value: fmtDuration(stats.filteredRepairSeconds), color: '#10b981' },
                { label: '今日技术支持', value: String(stats.todayTechCount ?? 0), color: '#f59e0b' },
              ].map(c => (
                <Card key={c.label} size="small" style={{ flex: 1, textAlign: 'center' }}>
                  <div style={{ fontSize: 22, fontWeight: 700, color: c.color }}>{c.value}</div>
                  <div style={{ fontSize: 12, opacity: 0.6, marginTop: 4 }}>{c.label}</div>
                </Card>
              ))}
            </Flex>
            <Flex gap={8} align="center" wrap style={{ marginBottom: 12 }}>
              <span style={{ fontSize: 12, opacity: 0.6 }}>筛选：</span>
              <DatePicker.RangePicker
                value={[statsRange[0] ? dayjs(statsRange[0]) : null, statsRange[1] ? dayjs(statsRange[1]) : null]}
                onChange={vals => {
                  const from = vals?.[0]?.format('YYYY-MM-DD') || '';
                  const to = vals?.[1]?.format('YYYY-MM-DD') || '';
                  setStatsRange([from, to]);
                  if (statsUser) loadStats(statsUser.id, from, to);
                }}
              />
              <Button size="small" onClick={() => { setStatsRange(['', '']); if (statsUser) loadStats(statsUser.id, '', ''); }}>
                重置
              </Button>
            </Flex>
            <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 8 }}>维修记录 ({(stats.history || []).length})</div>
            <Table
              size="small"
              rowKey={(r: any) => `${r.submittedAt}-${r.machineNumber}`}
              dataSource={stats.history || []}
              pagination={false}
              scroll={{ y: 300 }}
              columns={[
                { title: '提交时间', dataIndex: 'submittedAt', width: 150, render: (v: string) => v ? new Date(v).toLocaleString('zh-CN', { hour12: false }) : '-' },
                { title: '设备', dataIndex: 'machineNumber', render: (v: string) => v || '-' },
                { title: '故障类型', dataIndex: 'faultType', render: (v: string) => v || '-' },
                { title: '状态', dataIndex: 'status', render: (v: string) => v || '-' },
                { title: '维修时长', dataIndex: 'repairSeconds', render: (v: number) => fmtDuration(v) },
                { title: '结果', dataIndex: 'result', render: (v: string) => v || '-' },
              ]}
            />
            <div style={{ marginTop: 10, fontSize: 12, opacity: 0.5 }}>
              今日技术支持数量 = 该组员今日提交的技术支持数；维修时长统计自维修完成时间（完成时间 - 响应时间）。
            </div>
          </div>
        )}
      </Modal>
    </PageContainer>
  );
}
