// 解决方案库（移植 OpsApp.renderSolutions/viewSolution/_openSolutionForm/_saveSolution/doDeleteSolution）：
// 卡片网格 + 搜索/分类过滤 + 详情弹窗 + 新建/编辑（8 字段）
import { useMemo, useState } from 'react';
import {
  App as AntApp, Button, Card, Col, Empty, Form, Input, Modal, Popconfirm, Row, Select, Tag,
} from 'antd';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { PageContainer } from '@common/components/PageContainer';
import { useAuthStore, isAdmin } from '@common/stores/auth';
import * as api from '@common/api';
import { catColor } from '../common/opsLocalData';

export default function SolutionsPage() {
  const user = useAuthStore(s => s.user);
  const leader = isAdmin(user);
  const { message } = AntApp.useApp();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [cat, setCat] = useState('all');
  const [detail, setDetail] = useState<any>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | number | null>(null);
  const [form] = Form.useForm();

  const solQuery = useQuery({ queryKey: ['solutions'], queryFn: () => api.getSolutions().catch(() => [] as any[]) });
  const sols = solQuery.data || [];
  const cats = useMemo(() => [...new Set(sols.map((s: any) => s.category || '默认'))].sort(), [sols]);

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['solutions'] });

  const q = search.trim().toLowerCase();
  const filtered = sols.filter((s: any) =>
    (cat === 'all' || (s.category || '默认') === cat) &&
    (!q || (s.title || '').toLowerCase().includes(q) || (s.description || '').toLowerCase().includes(q) ||
      (s.category || '').toLowerCase().includes(q) || (s.tags || '').toLowerCase().includes(q) ||
      (s.steps || '').toLowerCase().includes(q)));

  const openForm = (existing?: any) => {
    setEditingId(existing?.id ?? null);
    form.resetFields();
    if (existing) {
      form.setFieldsValue({
        title: existing.title, description: existing.description, category: existing.category || '默认',
        tags: existing.tags, steps: existing.steps, resources: existing.resources,
        scenarios: existing.scenarios, verification: existing.verification,
      });
    } else {
      form.setFieldsValue({ category: '默认' });
    }
    setFormOpen(true);
  };

  const save = async () => {
    const v = await form.validateFields().catch(() => null);
    if (!v) return;
    const payload = {
      title: (v.title || '').trim(),
      description: (v.description || '').trim(),
      category: (v.category || '').trim() || '默认',
      tags: (v.tags || '').trim(),
      steps: (v.steps || '').trim(),
      resources: (v.resources || '').trim(),
      scenarios: (v.scenarios || '').trim(),
      verification: (v.verification || '').trim(),
    };
    try {
      const r: any = editingId ? await api.updateSolution(editingId, payload) : await api.createSolution(payload);
      if (r?.success === false) { message.error(r?.error || r?.message || '保存失败，请检查网络'); return; }
      message.success(editingId ? '已更新' : '已创建');
      setFormOpen(false);
      refresh();
    } catch (e: any) { message.error(e?.message || '保存失败'); }
  };

  const doDelete = async (id: string | number) => {
    try {
      const r: any = await api.deleteSolution(id);
      if (r?.success === false) { message.error(r?.error || '删除失败'); return; }
      message.success('已删除');
      refresh();
    } catch (e: any) { message.error(e?.message || '删除失败'); }
  };

  const Section = ({ title, val }: { title: string; val?: string }) => (
    <div style={{ marginBottom: 14 }}>
      <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 6 }}>{title}</div>
      <div style={{
        whiteSpace: 'pre-wrap', fontSize: 13, lineHeight: 1.7, padding: 10, borderRadius: 8,
        background: 'rgba(128,128,128,.06)',
      }}>{val || <span style={{ opacity: 0.5 }}>暂无</span>}</div>
    </div>
  );

  return (
    <PageContainer
      title="💡 解决方案库"
      extra={leader && <Button type="primary" onClick={() => openForm()}>+ 新建解决方案</Button>}
    >
      <Card size="small" style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Input placeholder="搜索标题/内容/分类/标签..." style={{ maxWidth: 280 }} allowClear
            value={search} onChange={e => setSearch(e.target.value)} />
          <Select value={cat} onChange={setCat} style={{ width: 140 }}
            options={[{ value: 'all', label: '全部分类' }, ...cats.map(c => ({ value: c, label: c }))]} />
          <Button onClick={refresh}>⟳ 刷新</Button>
        </div>
      </Card>

      {filtered.length === 0 ? (
        <Card><Empty description={sols.length === 0 ? '暂无解决方案，管理员可点击右上角新建' : '无匹配结果'} /></Card>
      ) : (
        <Row gutter={[12, 12]}>
          {filtered.map((s: any) => (
            <Col xs={24} sm={12} lg={8} key={s.id}>
              <Card size="small" hoverable onClick={() => setDetail(s)} style={{ cursor: 'pointer', height: '100%' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 8 }}>
                  <Tag style={{ background: catColor(s.category), color: '#fff', border: 'none' }}>{s.category || '默认'}</Tag>
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                    <span style={{ fontSize: 11, opacity: 0.6 }} title="使用次数">⬆ {s.usage_count || 0}次</span>
                    {leader && (
                      <>
                        <Button size="small" type="text" onClick={e => { e.stopPropagation(); openForm(s); }}>编辑</Button>
                        <Popconfirm title="确认删除该解决方案？" description="关联关系将一并解除。"
                          onConfirm={e => { e?.stopPropagation(); doDelete(s.id); }}
                          onCancel={e => e?.stopPropagation()} okText="删除" cancelText="取消" okButtonProps={{ danger: true }}>
                          <Button size="small" type="text" danger onClick={e => e.stopPropagation()}>删除</Button>
                        </Popconfirm>
                      </>
                    )}
                  </div>
                </div>
                <div style={{ fontWeight: 600, fontSize: 14 }}>{s.title}</div>
                {s.description && (
                  <div style={{
                    fontSize: 12, opacity: 0.65, marginTop: 4, display: '-webkit-box',
                    WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden',
                  }}>{s.description}</div>
                )}
                {s.tags && <div style={{ fontSize: 11, color: '#525252', marginTop: 4 }}>{s.tags}</div>}
              </Card>
            </Col>
          ))}
        </Row>
      )}

      {/* 详情弹窗 */}
      <Modal
        title={detail?.title || '解决方案'}
        open={!!detail}
        onCancel={() => setDetail(null)}
        footer={<Button onClick={() => setDetail(null)}>关闭</Button>}
        width={680}
        destroyOnClose
      >
        {detail && (
          <div style={{ maxHeight: '72vh', overflowY: 'auto', padding: 4 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
              <Tag style={{ background: catColor(detail.category), color: '#fff', border: 'none' }}>{detail.category || '默认'}</Tag>
              <span style={{ fontSize: 12, opacity: 0.6 }}>使用 {detail.usage_count || 0} 次</span>
              {detail.tags && <span style={{ fontSize: 11, color: '#525252' }}>{detail.tags}</span>}
            </div>
            {detail.description && <div style={{ fontSize: 13, opacity: 0.7, marginBottom: 14 }}>{detail.description}</div>}
            <Section title="📋 实施步骤" val={detail.steps} />
            <Section title="🔧 所需资源" val={detail.resources} />
            <Section title="🎯 适用场景" val={detail.scenarios} />
            <Section title="✅ 验证方法" val={detail.verification} />
            <div style={{ fontSize: 11, opacity: 0.5, borderTop: '1px solid rgba(128,128,128,.15)', paddingTop: 8 }}>
              创建者：{detail.created_by || '-'}  创建时间：{(detail.created_at || '').replace('T', ' ').slice(0, 16)}
            </div>
          </div>
        )}
      </Modal>

      {/* 新建/编辑弹窗 */}
      <Modal
        title={editingId ? '编辑解决方案' : '新建解决方案'}
        open={formOpen}
        onCancel={() => setFormOpen(false)}
        onOk={save}
        okText="保存"
        width={560}
        destroyOnClose
      >
        <Form form={form} layout="vertical" style={{ marginTop: 12 }}>
          {!editingId && (
            <div style={{ fontSize: 12, opacity: 0.6, marginBottom: 8 }}>
              请填写解决方案的完整信息，便于后续检索与复用。
            </div>
          )}
          <Form.Item name="title" label="标题" rules={[{ required: true, message: '标题不能为空' }]}>
            <Input placeholder="如：设备闪退问题处理方案" />
          </Form.Item>
          <Form.Item name="description" label="简介">
            <Input placeholder="一句话描述该方案" />
          </Form.Item>
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item name="category" label="分类">
                <Input placeholder="如：硬件 / 软件 / 网络" />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="tags" label="标签（逗号分隔）">
                <Input placeholder="如：闪退,重启,常见" />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item name="steps" label="实施步骤">
            <Input.TextArea rows={4} placeholder={'1. xxx\n2. xxx'} />
          </Form.Item>
          <Form.Item name="resources" label="所需资源">
            <Input.TextArea rows={2} placeholder="工具、备件、权限等" />
          </Form.Item>
          <Form.Item name="scenarios" label="适用场景">
            <Input.TextArea rows={2} placeholder="适用于哪些故障/场景" />
          </Form.Item>
          <Form.Item name="verification" label="验证方法">
            <Input.TextArea rows={2} placeholder="如何验证解决成功" />
          </Form.Item>
        </Form>
      </Modal>
    </PageContainer>
  );
}
