// 库位管理页（移植 js/ui/storage-locations.js）：库位 CRUD + 库位内设备列表
import { useState } from 'react';
import {
  Button, Card, Col, Empty, Flex, Form, Input, Modal, Popconfirm, Row, Space, Spin,
  Statistic, Table, Tag, Typography, message,
} from 'antd';
import { CopyOutlined, EditOutlined, LinkOutlined, PlusOutlined, RollbackOutlined } from '@ant-design/icons';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { PageContainer } from '@common/components/PageContainer';
import { useStorageLocations } from '@common/hooks/useData';
import { useAuthStore, isAdmin } from '@common/stores/auth';
import * as api from '@common/api';
import { copyText } from '../machine-links/MachineLinksPage';

const ST_LABEL: Record<string, { label: string; color: string }> = {
  available: { label: '可用', color: 'green' },
  in_use: { label: '使用中', color: 'blue' },
  damaged: { label: '损坏', color: 'red' },
  in_repair: { label: '维修中', color: 'orange' },
  transferred: { label: '已转出', color: 'purple' },
  repaired: { label: '已修复', color: 'cyan' },
  shipped: { label: '已发货', color: 'geekblue' },
  scrapped: { label: '已报废', color: 'default' },
};

const locationUrl = (code: string) =>
  `${window.location.origin}/location-status.html?code=${encodeURIComponent(code)}`;

function LocationFormModal({ open, existing, onClose }: { open: boolean; existing?: any; onClose: () => void }) {
  const [form] = Form.useForm();
  const [saving, setSaving] = useState(false);
  const qc = useQueryClient();

  const save = async () => {
    const values = await form.validateFields();
    setSaving(true);
    try {
      const payload = {
        name: (values.name || '').trim(),
        area: (values.area || '').trim(),
        description: (values.description || '').trim(),
      };
      const result = existing
        ? await api.updateStorageLocation(existing.code, payload)
        : await api.addStorageLocation({ code: (values.code || '').trim(), ...payload });
      if (result && result.success === false) {
        message.error(result.error || '保存失败');
        return;
      }
      message.success(existing ? '库位已更新' : '库位已添加');
      qc.invalidateQueries({ queryKey: ['storage-locations'] });
      onClose();
    } catch (e: any) {
      message.error(e?.message || '保存失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title={existing ? '编辑库位' : '添加库位'}
      open={open}
      onCancel={onClose}
      onOk={save}
      confirmLoading={saving}
      destroyOnClose
      afterOpenChange={vis => {
        if (vis) form.setFieldsValue(existing ? existing : { code: '', name: '', area: '', description: '' });
      }}
    >
      <Form form={form} layout="vertical">
        <Form.Item name="code" label="库位编码" rules={[{ required: true, message: '库位编码不能为空' }]}>
          <Input placeholder="如 A-01、B-02" readOnly={!!existing} style={{ fontFamily: 'monospace' }} />
        </Form.Item>
        <Form.Item name="name" label="库位名称">
          <Input placeholder="如 手套A货架" />
        </Form.Item>
        <Form.Item name="area" label="区域">
          <Input placeholder="如 A区、B区、C区" />
        </Form.Item>
        <Form.Item name="description" label="描述">
          <Input.TextArea placeholder="库位说明（可选）" rows={3} />
        </Form.Item>
      </Form>
    </Modal>
  );
}

function LocationSNView({ code, onBack, privileged, onEdit }: {
  code: string; onBack: () => void; privileged: boolean; onEdit: (loc: any) => void;
}) {
  const { data: locations = [] } = useStorageLocations();
  const loc = locations.find((l: any) => l.code === code) || { code, name: '', area: '', description: '' };
  const qc = useQueryClient();
  const { data: sns = [], isLoading } = useQuery({
    queryKey: ['location-sns', code],
    queryFn: () => api.getLocationSNs(code),
  });

  const doDeleteLocation = async () => {
    const result = await api.deleteStorageLocation(code);
    if (result && result.error) { message.error(result.error); return; }
    message.success('库位已删除');
    qc.invalidateQueries({ queryKey: ['storage-locations'] });
    qc.invalidateQueries({ queryKey: ['sn-registry'] });
    onBack();
  };

  return (
    <>
      <Flex align="center" gap={12} style={{ marginBottom: 16 }}>
        <Button icon={<RollbackOutlined />} onClick={onBack}>返回</Button>
        <div>
          <Typography.Title level={5} style={{ margin: 0 }}>库位 {code}</Typography.Title>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {loc.name || ''}{loc.area ? ` · ${loc.area}` : ''} · 共 {sns.length} 台设备
          </Typography.Text>
        </div>
        <div style={{ marginLeft: 'auto' }}>
          <Space>
            {privileged && <Button size="small" icon={<EditOutlined />} onClick={() => onEdit(loc)}>编辑</Button>}
            {privileged && (
              <Popconfirm
                title={`确定删除库位 ${code}？`}
                description="该库位下所有 SN 将解除关联，但 SN 数据不会删除。"
                onConfirm={doDeleteLocation}
              >
                <Button size="small" danger>删除库位</Button>
              </Popconfirm>
            )}
          </Space>
        </div>
      </Flex>
      <Table
        rowKey="snCode"
        size="small"
        loading={isLoading}
        dataSource={sns}
        locale={{ emptyText: <Empty description={privileged ? '该库位暂无设备，可从 SN码 页面为设备分配库位' : '该库位暂无设备'} /> }}
        pagination={{ pageSize: 20, showTotal: t => `共 ${t} 条` }}
        columns={[
          { title: 'SN码', dataIndex: 'snCode', render: (v: string) => <Typography.Text code>{v}</Typography.Text> },
          { title: '设备类型', dataIndex: 'equipmentType', render: (v: string) => v || '-' },
          { title: '手型', dataIndex: 'handType', width: 80, render: (v: string) => (v === 'left' ? '左手' : v === 'right' ? '右手' : '-') },
          {
            title: '状态', dataIndex: 'status', width: 100,
            render: (v: string) => {
              const meta = ST_LABEL[v] || { label: v || '-', color: 'default' };
              return <Tag color={meta.color}>{meta.label}</Tag>;
            },
          },
          { title: '绑定机器', dataIndex: 'machineNumber', render: (v: string) => v || '-' },
          { title: '来源', dataIndex: 'source', render: (v: string) => v || '-' },
        ]}
      />
    </>
  );
}

export default function StorageLocationsPage() {
  const { data: locations = [], isLoading } = useStorageLocations();
  const user = useAuthStore(s => s.user);
  const privileged = isAdmin(user);
  const qc = useQueryClient();

  const [selected, setSelected] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<any>(null);

  const totalSN = locations.reduce((s: number, l: any) => s + (Number(l.snCount) || 0), 0);

  const doCopy = async (code: string) => {
    const ok = await copyText(locationUrl(code));
    if (ok) message.success('库位链接已复制');
    else message.error('复制失败，请手动复制');
  };

  const doDelete = async (code: string) => {
    const result = await api.deleteStorageLocation(code);
    if (result && result.error) { message.error(result.error); return; }
    message.success('库位已删除');
    qc.invalidateQueries({ queryKey: ['storage-locations'] });
    qc.invalidateQueries({ queryKey: ['sn-registry'] });
  };

  if (selected) {
    return (
      <PageContainer title="库位管理" subtitle="库位内设备列表">
        <LocationSNView
          code={selected}
          onBack={() => setSelected(null)}
          privileged={privileged}
          onEdit={loc => { setEditing(loc); setFormOpen(true); }}
        />
        <LocationFormModal
          open={formOpen}
          existing={editing}
          onClose={() => { setFormOpen(false); setEditing(null); }}
        />
      </PageContainer>
    );
  }

  return (
    <PageContainer
      title="库位管理"
      subtitle="管理仓储库位，关联 SN 设备到具体库位 · 每个库位有专属链接可分享"
      extra={privileged && (
        <Button type="primary" icon={<PlusOutlined />} onClick={() => { setEditing(null); setFormOpen(true); }}>
          添加库位
        </Button>
      )}
    >
      {/* 统计卡片 */}
      <Row gutter={12} style={{ marginBottom: 12 }}>
        <Col span={6}><Card size="small"><Statistic title="库位总数" value={locations.length} /></Card></Col>
        <Col span={6}><Card size="small"><Statistic title="已关联SN" value={totalSN} valueStyle={{ color: '#22c55e' }} /></Card></Col>
      </Row>

      {locations.length === 0 ? (
        isLoading ? <Flex justify="center" style={{ marginTop: 60 }}><Spin /></Flex> : (
          <Empty
            description={privileged ? '暂无库位，点击右上角"添加库位"创建第一个库位' : '暂无库位，请管理员添加'}
            style={{ marginTop: 60 }}
          />
        )
      ) : (
        <Row gutter={[12, 12]}>
          {locations.map((l: any) => {
            const url = locationUrl(l.code);
            return (
              <Col key={l.code} xs={24} sm={12} md={8} lg={6}>
                <Card size="small">
                  <Flex gap={10} align="center" style={{ marginBottom: 10, cursor: 'pointer' }} onClick={() => setSelected(l.code)}>
                    <div style={{ width: 40, height: 40, borderRadius: 10, background: 'rgba(59,130,246,0.12)', color: '#3b82f6', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18 }}>
                      📦
                    </div>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontFamily: 'monospace', fontWeight: 700, fontSize: 16 }}>{l.code}</div>
                      {l.name && <div style={{ fontSize: 12, opacity: 0.7 }}>{l.name}</div>}
                    </div>
                  </Flex>
                  {l.area && (
                    <div style={{ fontSize: 12, opacity: 0.6, marginBottom: 8 }}>
                      <Tag>{l.area}</Tag>
                    </div>
                  )}
                  <div
                    style={{ fontSize: 13, opacity: 0.75, marginBottom: 12, minHeight: 20, cursor: 'pointer', overflow: 'hidden', textOverflow: 'ellipsis', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}
                    onClick={() => setSelected(l.code)}
                  >
                    {l.description || ''}
                  </div>
                  <Flex align="center" gap={8} style={{ marginBottom: 10 }} onClick={() => setSelected(l.code)}>
                    <Tag color={Number(l.snCount) > 0 ? 'green' : 'blue'}>{Number(l.snCount) || 0} 台设备</Tag>
                    <span style={{ marginLeft: 'auto', color: '#3b82f6', fontSize: 12 }}>查看库位</span>
                  </Flex>
                  <Typography.Paragraph type="secondary" style={{ fontSize: 10, wordBreak: 'break-all', marginBottom: 8 }} ellipsis={{ rows: 2 }}>
                    {url}
                  </Typography.Paragraph>
                  <Space size={4}>
                    <Button size="small" icon={<LinkOutlined />} href={url} target="_blank">打开</Button>
                    <Button size="small" icon={<CopyOutlined />} onClick={() => doCopy(l.code)}>复制</Button>
                    {privileged && <Button size="small" icon={<EditOutlined />} onClick={() => { setEditing(l); setFormOpen(true); }} />}
                    {privileged && (
                      <Popconfirm
                        title={`确定删除库位 ${l.code}？`}
                        description="该库位下所有 SN 将解除关联，但 SN 数据不会删除。"
                        onConfirm={() => doDelete(l.code)}
                      >
                        <Button size="small" danger>删除</Button>
                      </Popconfirm>
                    )}
                  </Space>
                </Card>
              </Col>
            );
          })}
        </Row>
      )}

      <LocationFormModal
        open={formOpen}
        existing={editing}
        onClose={() => { setFormOpen(false); setEditing(null); }}
      />
    </PageContainer>
  );
}
