// 需求（移植 OpsApp.renderRequirements/showAddRequirementForm/showRequirementDetail）：
// 数据存 localStorage ops_requirements
import { useState } from 'react';
import { App as AntApp, Button, Card, Empty, Form, Input, Modal, Select, Tag } from 'antd';
import { PageContainer } from '@common/components/PageContainer';
import {
  loadRequirements, saveRequirements, PRIORITY_COLOR, REQ_STATUS_COLOR, REQ_STATUS_LABEL, type OpsRequirement,
} from '../common/opsLocalData';

export default function RequirementsPage() {
  const { message } = AntApp.useApp();
  const [reqs, setReqs] = useState<OpsRequirement[]>(loadRequirements);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<OpsRequirement | null>(null);
  const [form] = Form.useForm();

  const update = (next: OpsRequirement[]) => { saveRequirements(next); setReqs([...next]); };

  const openAdd = () => {
    setEditing(null);
    form.resetFields();
    setOpen(true);
  };

  const openDetail = (r: OpsRequirement) => {
    setEditing(r);
    form.setFieldsValue({ title: r.title, requester: r.requester, priority: r.priority, status: r.status });
    setOpen(true);
  };

  const submit = async () => {
    const v = await form.validateFields().catch(() => null);
    if (!v) return;
    if (editing) {
      update(reqs.map(r => r.id === editing.id
        ? { ...r, title: v.title.trim(), requester: (v.requester || '').trim(), priority: v.priority, status: v.status }
        : r));
      message.success('需求已更新');
    } else {
      update([{
        id: 'r' + Date.now(),
        title: v.title.trim(),
        requester: (v.requester || '').trim() || '-',
        priority: v.priority || 'medium',
        status: v.status || 'pending',
        date: new Date().toLocaleDateString('zh-CN'),
      }, ...reqs]);
      message.success('需求已添加');
    }
    setOpen(false);
  };

  return (
    <PageContainer title="💡 需求" extra={<Button type="primary" onClick={openAdd}>+ 添加需求</Button>}>
      {reqs.length === 0 ? (
        <Card><Empty description="暂无需求" /></Card>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {reqs.map(r => (
            <Card key={r.id} size="small" hoverable onClick={() => openDetail(r)} style={{ cursor: 'pointer' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: PRIORITY_COLOR[r.priority] || '#f59e0b', flexShrink: 0 }} />
                <strong style={{ flex: 1, minWidth: 200 }}>{r.title}</strong>
                <Tag color={REQ_STATUS_COLOR[r.status]}>{REQ_STATUS_LABEL[r.status] || '待处理'}</Tag>
              </div>
              <div style={{ marginTop: 6, fontSize: 12, opacity: 0.6, display: 'flex', gap: 16 }}>
                <span>👤 {r.requester || '-'}</span>
                <span>📅 {r.date || '-'}</span>
                <span>{r.priority === 'high' ? '高优先' : r.priority === 'low' ? '低优先' : '中优先'}</span>
              </div>
            </Card>
          ))}
        </div>
      )}

      <Modal
        title={editing ? '需求详情' : '添加需求'}
        open={open}
        onCancel={() => setOpen(false)}
        onOk={submit}
        okText="保存"
        destroyOnClose
      >
        <Form form={form} layout="vertical" style={{ marginTop: 12 }}
          initialValues={{ priority: 'medium', status: 'pending' }}>
          <Form.Item name="title" label="需求标题" rules={[{ required: true, message: '请输入需求标题' }]}>
            <Input placeholder="输入需求标题" />
          </Form.Item>
          <Form.Item name="requester" label="提出人">
            <Input placeholder="输入提出人姓名" />
          </Form.Item>
          <Form.Item name="priority" label="优先级">
            <Select options={[
              { value: 'high', label: '高优先' },
              { value: 'medium', label: '中优先' },
              { value: 'low', label: '低优先' },
            ]} />
          </Form.Item>
          <Form.Item name="status" label="状态">
            <Select options={[
              { value: 'pending', label: '待处理' },
              { value: 'approved', label: '已通过' },
              { value: 'rejected', label: '已拒绝' },
            ]} />
          </Form.Item>
        </Form>
      </Modal>
    </PageContainer>
  );
}
