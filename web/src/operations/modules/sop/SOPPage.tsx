// SOP 文档（移植 OpsApp.renderSOP/showSOPAddForm/_addSOP/doDeleteSOP）：
// 卡片网格 + 搜索/分类过滤 + 链接/文本/文件三种类型 + 预览弹窗
import { useMemo, useState } from 'react';
import {
  App as AntApp, Button, Card, Col, Empty, Form, Input, Modal, Popconfirm, Row, Select, Tag, Upload,
} from 'antd';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { PageContainer } from '@common/components/PageContainer';
import { useAuthStore, isAdmin } from '@common/stores/auth';
import * as api from '@common/api';
import { catColor } from '../common/opsLocalData';

export default function SOPPage() {
  const user = useAuthStore(s => s.user);
  const leader = isAdmin(user);
  const { message } = AntApp.useApp();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [cat, setCat] = useState('all');
  const [addOpen, setAddOpen] = useState(false);
  const [addForm] = Form.useForm();
  const [kind, setKind] = useState<'url' | 'text' | 'file'>('url');
  const [preview, setPreview] = useState<any>(null);

  const sopQuery = useQuery({ queryKey: ['sop'], queryFn: () => api.getSOP().catch(() => [] as any[]) });
  const docs = sopQuery.data || [];
  const cats = useMemo(() => [...new Set(docs.map((d: any) => d.category || '默认'))].sort(), [docs]);

  const filtered = docs.filter((d: any) =>
    (cat === 'all' || (d.category || '默认') === cat) &&
    (!search.trim() || (d.title || '').toLowerCase().includes(search.trim().toLowerCase()) ||
      (d.category || '').toLowerCase().includes(search.trim().toLowerCase())));

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['sop'] });

  const openDoc = (d: any) => {
    if ((d.kind || 'url') === 'url') {
      window.open(d.url, '_blank');
    } else {
      setPreview(d);
    }
  };

  const addSOP = async () => {
    const v = await addForm.validateFields().catch(() => null);
    if (!v) return;
    const payload: any = { title: v.title.trim(), category: (v.category || '').trim() || '默认', kind };
    if (kind === 'url') {
      if (!(v.url || '').trim()) { message.warning('链接不能为空'); return; }
      payload.url = v.url.trim();
    } else if (kind === 'text') {
      if (!(v.content || '').trim()) { message.warning('内容不能为空'); return; }
      payload.content = v.content.trim();
    } else {
      const file = v.file?.[0]?.originFileObj as File | undefined;
      if (!file) { message.warning('请选择文件'); return; }
      // 文件转 base64 dataURL（移植 uploadSOPFile）
      payload.content = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = e => resolve(e.target?.result as string);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
      });
      payload.mime = file.type;
    }
    try {
      const r: any = await api.addSOP(payload);
      if (r?.success === false) { message.error(r?.error || r?.message || '添加失败，请检查网络'); return; }
      message.success('添加成功');
      setAddOpen(false);
      addForm.resetFields();
      setKind('url');
      refresh();
    } catch (e: any) { message.error(e?.message || '添加失败'); }
  };

  const doDelete = async (id: string | number) => {
    try {
      const r: any = await api.deleteSOP(id);
      if (r?.success === false) { message.error(r?.error || '删除失败'); return; }
      message.success('已删除');
      refresh();
    } catch (e: any) { message.error(e?.message || '删除失败'); }
  };

  return (
    <PageContainer
      title="📖 SOP 文档"
      extra={leader && <Button type="primary" onClick={() => setAddOpen(true)}>+ 添加 SOP</Button>}
    >
      <Card size="small" style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Input placeholder="搜索标题/分类..." style={{ maxWidth: 260 }} allowClear
            value={search} onChange={e => setSearch(e.target.value)} />
          <Select value={cat} onChange={setCat} style={{ width: 140 }}
            options={[{ value: 'all', label: '全部分类' }, ...cats.map(c => ({ value: c, label: c }))]} />
          <Button onClick={refresh}>⟳ 刷新</Button>
        </div>
      </Card>

      {filtered.length === 0 ? (
        <Card><Empty description={docs.length === 0 ? '暂无 SOP，请联系管理员添加' : '无匹配结果'} /></Card>
      ) : (
        <Row gutter={[12, 12]}>
          {filtered.map((d: any) => (
            <Col xs={24} sm={12} lg={8} xl={6} key={d.id}>
              <Card size="small" hoverable onClick={() => openDoc(d)} style={{ cursor: 'pointer', height: '100%' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 8 }}>
                  <Tag style={{ background: catColor(d.category), color: '#fff', border: 'none' }}>{d.category || '默认'}</Tag>
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                    <span style={{ fontSize: 11, opacity: 0.7 }}>
                      {(d.kind || 'url') === 'url' ? '🔗 链接' : d.kind === 'text' ? '📄 内容' : '📎 文件'}
                    </span>
                    {leader && (
                      <Popconfirm title="确认删除该 SOP？" onConfirm={e => { e?.stopPropagation(); doDelete(d.id); }}
                        onCancel={e => e?.stopPropagation()} okText="删除" cancelText="取消" okButtonProps={{ danger: true }}>
                        <Button size="small" danger type="text" onClick={e => e.stopPropagation()}>删除</Button>
                      </Popconfirm>
                    )}
                  </div>
                </div>
                <div style={{ fontWeight: 600, fontSize: 14 }}>{d.title}</div>
                <div style={{ fontSize: 12, opacity: 0.5, marginTop: 4 }}>{d.uploaded_at || ''}</div>
              </Card>
            </Col>
          ))}
        </Row>
      )}

      {/* 添加 SOP */}
      <Modal title="添加 SOP 文档" open={addOpen} onCancel={() => setAddOpen(false)} onOk={addSOP}
        okText="保存" width={520} destroyOnClose>
        <Form form={addForm} layout="vertical" style={{ marginTop: 12 }}>
          <Form.Item name="title" label="标题" rules={[{ required: true, message: '标题不能为空' }]}>
            <Input placeholder="如：设备开机检查 SOP" />
          </Form.Item>
          <Form.Item name="category" label="分类">
            <Input placeholder="如：运维 / 生产 / 安全" />
          </Form.Item>
          <Form.Item label="类型">
            <Select value={kind} onChange={setKind} options={[
              { value: 'url', label: '链接（飞书文档）' },
              { value: 'text', label: '直接粘贴内容' },
              { value: 'file', label: '上传文件' },
            ]} />
          </Form.Item>
          {kind === 'url' && (
            <Form.Item name="url" label="链接（飞书文档 URL）" rules={[{ required: true, message: '链接不能为空' }]}>
              <Input placeholder="https://xxx.feishu.cn/docx/..." />
            </Form.Item>
          )}
          {kind === 'text' && (
            <Form.Item name="content" label="内容（支持 Markdown）" rules={[{ required: true, message: '内容不能为空' }]}>
              <Input.TextArea rows={6} placeholder="在此粘贴 SOP 内容..." />
            </Form.Item>
          )}
          {kind === 'file' && (
            <Form.Item name="file" label="上传文件（PDF/图片）" valuePropName="fileList"
              getValueFromEvent={e => (Array.isArray(e) ? e : e?.fileList)}>
              <Upload accept=".pdf,.png,.jpg,.jpeg,.gif,.webp" maxCount={1} beforeUpload={() => false}>
                <Button>选择文件</Button>
              </Upload>
            </Form.Item>
          )}
        </Form>
      </Modal>

      {/* 预览弹窗 */}
      <Modal
        title={preview?.title || '预览'}
        open={!!preview}
        onCancel={() => setPreview(null)}
        footer={<Button onClick={() => setPreview(null)}>关闭</Button>}
        width={800}
        destroyOnClose
      >
        {preview && (preview.kind === 'file' ? (() => {
          // content 为 base64 dataURL（新上传）或文件名（旧数据，走 /api/sop/serve/）
          const isDataUrl = typeof preview.content === 'string' && preview.content.startsWith('data:');
          const src = isDataUrl ? preview.content : `/api/sop/serve/${encodeURIComponent(preview.content || '')}`;
          return preview.mime?.startsWith('image/') ? (
            <div style={{ textAlign: 'center' }}>
              <img src={src} alt={preview.title} style={{ maxWidth: '100%', maxHeight: '75vh', objectFit: 'contain' }} />
            </div>
          ) : (
            <iframe src={src} title={preview.title} style={{ width: '100%', height: '75vh', border: 'none' }} allowFullScreen />
          );
        })() : (
          <div style={{ maxHeight: '70vh', overflowY: 'auto', whiteSpace: 'pre-wrap', fontSize: 14, lineHeight: 1.7, padding: 8 }}>
            {preview.content}
          </div>
        ))}
      </Modal>
    </PageContainer>
  );
}
