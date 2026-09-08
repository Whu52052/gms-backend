// 提交技术支持请求（移植 OpsApp.renderTechSupportSubmit/doSubmitTechSupport）：
// 设备类型 + 设备编号（可搜索）+ 故障现象 + 说明；成功后随机鼓励弹窗
// 历史提交跟随账户（服务端存储）：从本人历史工单提取，跨设备可见，点击直接填充
// 常见故障：内置模板 + 运营共享模板（任何运营账户可添加，全运营账户可见可用）
import { useState } from 'react';
import { App as AntApp, Button, Card, Form, Input, Modal, Popconfirm, Select, Tag, Tooltip } from 'antd';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { PageContainer } from '@common/components/PageContainer';
import { useAuthStore } from '@common/stores/auth';
import * as api from '@common/api';

const FAULT_TYPES = ['闪退异常', '无法启动', '连接失败', '传感器异常', '硬件损坏', '校准异常', '数据异常', '其他'];

// 内置常见故障（系统模板，不可删除）
const BUILTIN_FAULTS: { faultType: string; faultDescription: string }[] = [
  { faultType: '连接失败', faultDescription: '设备使用中频繁断连/无法连接，已尝试重启软件和设备，问题仍存在。' },
  { faultType: '传感器异常', faultDescription: '手套/灵巧手某根手指数据无响应或明显漂移，动作不跟手，影响正常使用。' },
  { faultType: '闪退异常', faultDescription: '采集/操作软件运行中闪退，复现步骤：启动后进行常规操作即退出。' },
  { faultType: '无法启动', faultDescription: '设备上电/软件启动无反应，指示灯状态异常，已检查供电与网线连接。' },
  { faultType: '硬件损坏', faultDescription: '设备外观破损/线缆断裂/手指机构卡滞，需现场检修或更换。' },
  { faultType: '校准异常', faultDescription: '标定后姿态仍偏移，动作与实际手势不一致，重新标定无效。' },
];

interface TsHistoryEntry { faultType: string; faultDescription: string; submittedAt?: string | null }
interface CommonFaultEntry { id: string; faultType: string; faultDescription: string; createdBy?: string; createdByName?: string; createdAt?: string }

export default function TechSupportSubmitPage() {
  const { message } = AntApp.useApp();
  const [form] = Form.useForm();
  const [submitting, setSubmitting] = useState(false);
  const [savingFault, setSavingFault] = useState(false);
  const queryClient = useQueryClient();
  const user = useAuthStore(s => s.user);
  // 运营账户（含普通运营 user）可添加/删除共享常见故障
  const canManageFaults = !!user && (user.system === 'operations' || user.role === 'superadmin');

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
  const commonFaultsQuery = useQuery({
    queryKey: ['tech-support-common-faults'],
    queryFn: () => api.getCommonFaults(),
  });
  const history: TsHistoryEntry[] = Array.isArray(historyQuery.data) ? historyQuery.data : [];
  const sharedFaults: CommonFaultEntry[] = Array.isArray(commonFaultsQuery.data) ? commonFaultsQuery.data : [];

  const equipmentList = Array.isArray(equipmentQuery.data) ? equipmentQuery.data : [];
  const machinesList = Array.isArray(machinesQuery.data) ? machinesQuery.data : [];
  const machineNumbers = [...new Set(machinesList.map((m: any) => m.machineNumber || m.id).filter(Boolean))] as string[];

  // 故障现象选项 = 内置 + 共享常见故障 + 历史提交中出现过的自定义值（去重）
  const faultTypeOptions = [...new Set([...FAULT_TYPES, ...sharedFaults.map(f => f.faultType), ...history.map(h => h.faultType)])]
    .map(f => ({ value: f, label: f }));

  const fillFromHistory = (e: TsHistoryEntry) => {
    form.setFieldsValue({ faultType: e.faultType, faultDescription: e.faultDescription });
  };
  const fillFault = (faultType: string, faultDescription: string) => {
    form.setFieldsValue({ faultType, faultDescription });
  };

  // 把当前填写的故障现象+说明保存为全运营共享的常见故障
  const saveAsCommonFault = async () => {
    const ft = String(form.getFieldValue('faultType') || '').trim();
    const fd = String(form.getFieldValue('faultDescription') || '').trim();
    if (!ft || !fd) {
      message.warning('请先填写故障现象和故障说明，再保存为常见故障');
      return;
    }
    setSavingFault(true);
    try {
      const r: any = await api.addCommonFault({ faultType: ft, faultDescription: fd });
      if (r && r.success === false) { message.error(r?.error || r?.message || '保存失败'); return; }
      message.success('已保存为常见故障，全运营账户可见');
      queryClient.invalidateQueries({ queryKey: ['tech-support-common-faults'] });
    } catch (e: any) {
      message.error(e?.message || '网络错误，请重试');
    } finally {
      setSavingFault(false);
    }
  };

  const removeCommonFault = async (f: CommonFaultEntry) => {
    try {
      await api.deleteCommonFault(f.id);
      message.success('已删除');
      queryClient.invalidateQueries({ queryKey: ['tech-support-common-faults'] });
    } catch (e: any) {
      message.error(e?.message || '删除失败');
    }
  };

  const canDeleteFault = (f: CommonFaultEntry) =>
    user?.role === 'superadmin' || !f.createdBy || f.createdBy === (user?.userId ?? user?.id);

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

          <div style={{ marginBottom: 16 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
              <span style={{ fontSize: 13, fontWeight: 600 }}>📌 常见故障（点击直接填充，可再修改）</span>
              {canManageFaults && (
                <Button size="small" type="link" loading={savingFault} onClick={saveAsCommonFault} style={{ padding: 0, fontSize: 12 }}>
                  ＋ 把当前填写保存为常见故障
                </Button>
              )}
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {BUILTIN_FAULTS.map((c, i) => (
                <Tag key={`b-${i}`} color="blue"
                  onClick={() => fillFault(c.faultType, c.faultDescription)}
                  style={{ cursor: 'pointer', padding: '4px 10px', fontSize: 13, margin: 0 }}>
                  {c.faultType}
                </Tag>
              ))}
              {sharedFaults.map(f => (
                <Tooltip key={f.id} title={`${f.faultDescription}${f.createdByName ? `（${f.createdByName} 添加）` : ''}`}>
                  <Tag color="cyan"
                    onClick={() => fillFault(f.faultType, f.faultDescription)}
                    style={{ cursor: 'pointer', padding: '4px 10px', fontSize: 13, margin: 0 }}>
                    {f.faultType}
                    {canManageFaults && canDeleteFault(f) && (
                      <Popconfirm title="删除这条常见故障？" onConfirm={(e) => { e?.stopPropagation(); removeCommonFault(f); }}
                        onCancel={e => e?.stopPropagation()} okText="删除" cancelText="取消">
                        <span onClick={e => e.stopPropagation()}
                          style={{ marginLeft: 6, opacity: 0.55 }}>×</span>
                      </Popconfirm>
                    )}
                  </Tag>
                </Tooltip>
              ))}
            </div>
            {sharedFaults.length === 0 && (
              <div style={{ fontSize: 12, opacity: 0.55, marginTop: 6 }}>
                暂无团队共享常见故障{canManageFaults ? '，填好故障现象和说明后点右上角「保存为常见故障」即可添加' : ''}
              </div>
            )}
          </div>

          {history.length > 0 && (
            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>🕘 历史提交（跟随当前账号，点击直接填充）</div>
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
