// 提交技术支持请求（移植 OpsApp.renderTechSupportSubmit/doSubmitTechSupport）：
// 设备类型 + 设备编号（可搜索）+ 故障现象 + 说明；成功后随机鼓励弹窗
// 历史提交跟随账户（服务端存储）：从本人历史工单提取，跨设备可见，点击直接填充
import { useState } from 'react';
import { App as AntApp, Button, Card, Form, Input, Modal, Select, Tag } from 'antd';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { PageContainer } from '@common/components/PageContainer';
import * as api from '@common/api';

const FAULT_TYPES = ['闪退异常', '无法启动', '连接失败', '硬件损坏', '数据异常', '其他'];

interface TsHistoryEntry { faultType: string; faultDescription: string; submittedAt?: string | null }

export default function TechSupportSubmitPage() {
  const { message } = AntApp.useApp();
  const [form] = Form.useForm();
  const [submitting, setSubmitting] = useState(false);
  const queryClient = useQueryClient();

  const equipmentQuery = useQuery({
    queryKey: ['equipment-config'],
    queryFn: () => api.getEquipmentConfig().catch(() => [] as any[]),
  });
  const machinesQuery = useQuery({
    queryKey: ['machines'],
    queryFn: () => api.getMachines().catch(() => [] as any[]),
  });
  const historyQuery = useQuery({
    queryKey: ['tech-support-my-history'],
    queryFn: () => api.getMyTechSupportHistory().catch(() => [] as any[]),
  });
  const history: TsHistoryEntry[] = Array.isArray(historyQuery.data) ? historyQuery.data : [];

  const equipmentList = Array.isArray(equipmentQuery.data) ? equipmentQuery.data : [];
  const machinesList = Array.isArray(machinesQuery.data) ? machinesQuery.data : [];
  const machineNumbers = [...new Set(machinesList.map((m: any) => m.machineNumber || m.id).filter(Boolean))] as string[];

  // 故障现象选项 = 内置 + 历史提交中出现过的自定义值（去重）
  const faultTypeOptions = [...new Set([...FAULT_TYPES, ...history.map(h => h.faultType)])]
    .map(f => ({ value: f, label: f }));

  const fillFromHistory = (e: TsHistoryEntry) => {
    form.setFieldsValue({ faultType: e.faultType, faultDescription: e.faultDescription });
  };

  const submit = async () => {
    const v = await form.validateFields().catch(() => null);
    if (!v) return;
    const equipment = equipmentList.find((e: any) => e.id === v.equipmentType);
    setSubmitting(true);
    try {
      const result: any = await api.submitTechSupport({
        equipmentType: v.equipmentType,
        equipmentTypeName: equipment?.name || v.equipmentType,
        machineId: v.machineNumber,
        machineNumber: v.machineNumber,
        faultType: v.faultType,
        faultDescription: (v.faultDescription || '').trim(),
      });
      if (result && result.success === false) {
        message.error(result?.message || result?.error || '提交失败');
        return;
      }
      // 历史提交跟随账户（服务端从工单提取），提交成功后刷新
      queryClient.invalidateQueries({ queryKey: ['tech-support-my-history'] });
      // 随机鼓励弹窗（移植 _showPopupModal）
      const popup = await api.getRandomPopupMessage('submit');
      form.resetFields();
      Modal.success({
        title: '🎉 提交成功',
        content: <div style={{ textAlign: 'center', fontSize: 15, lineHeight: 1.6, padding: '12px 0' }}>{popup.text || '请求已提交！'}</div>,
        okText: '好的',
      });
    } catch (e: any) {
      message.error(e?.message || '网络错误，请重试');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <PageContainer title="🛠️ 提交技术支持请求" subtitle="设备故障时提交请求，运维人员将尽快处理">
      <Card style={{ maxWidth: 640 }}>
        <Form form={form} layout="vertical">
          <div style={{ fontWeight: 600, marginBottom: 12 }}>📟 设备信息</div>
          <Form.Item name="equipmentType" label="故障设备类型" rules={[{ required: true, message: '请选择故障设备' }]}>
            <Select
              placeholder="-- 请选择故障设备 --"
              options={equipmentList.map((e: any) => ({ value: e.id, label: `${e.icon || ''} ${e.name || e.id}` }))}
            />
          </Form.Item>
          <Form.Item name="machineNumber" label="设备编号" rules={[{ required: true, message: '请选择设备编号' }]}
            extra={`共 ${machineNumbers.length} 台设备可选`}>
            <Select
              showSearch
              placeholder="输入编号搜索或从列表选择..."
              options={machineNumbers.map(m => ({ value: m, label: m }))}
              filterOption={(input, option) => (option?.label as string || '').toLowerCase().includes(input.toLowerCase())}
            />
          </Form.Item>

          <div style={{ fontWeight: 600, marginBottom: 12, marginTop: 20 }}>🔍 故障详情</div>
          <Form.Item name="faultType" label="故障现象" rules={[{ required: true, message: '请选择故障现象' }]}>
            <Select placeholder="-- 请选择故障现象 --" options={faultTypeOptions} showSearch />
          </Form.Item>
          <Form.Item name="faultDescription" label="故障说明" rules={[{ required: true, message: '请填写故障说明' }]}>
            <Input.TextArea rows={4} placeholder="请详细描述故障现象，包括发生时间、操作过程、已尝试的方法等..." />
          </Form.Item>

          {history.length > 0 && (
            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>🕘 历史提交（点击直接填充）</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {history.slice(0, 20).map((e, i) => (
                  <div key={`${e.submittedAt || ''}-${i}`}
                    onClick={() => fillFromHistory(e)}
                    style={{ cursor: 'pointer', padding: '8px 10px', borderRadius: 8,
                      border: '1px solid rgba(128,128,128,0.25)', background: 'rgba(128,128,128,0.06)' }}>
                    <Tag style={{ marginRight: 6 }}>{e.faultType}</Tag>
                    <span style={{ fontSize: 12, opacity: 0.8 }}>
                      {e.faultDescription.length > 50 ? `${e.faultDescription.slice(0, 50)}…` : e.faultDescription}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          <Button type="primary" size="large" loading={submitting} onClick={submit} style={{ minWidth: 160 }}>
            ✓ 确认提交
          </Button>
        </Form>
      </Card>
    </PageContainer>
  );
}
