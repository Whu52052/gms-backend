// 库存弹窗：快速出入库 / 直接设置库存 / 批量操作（移植 js/ui/inventory.js 的 quickInOut/showSetInventoryModal/showBatch*Form）
import { useEffect, useState } from 'react';
import { Alert, Form, Input, InputNumber, Modal, Select, Upload, message } from 'antd';
import { InboxOutlined } from '@ant-design/icons';
import { useQueryClient } from '@tanstack/react-query';
import * as api from '@common/api';
import { useAuthStore } from '@common/stores/auth';
import { typeLabelOf } from '@common/utils/domain';

/** 库存类型 → 流水记录的 equipmentType + handType（与旧版写入口径一致） */
export function txTypeParts(invType: string): { equipmentType: string; handType: string | null } {
  if (invType === 'left_glove' || invType === 'right_glove') {
    return { equipmentType: 'glove', handType: invType.startsWith('left') ? 'left' : 'right' };
  }
  if (invType === 'left_dexterous_hand' || invType === 'right_dexterous_hand') {
    return { equipmentType: 'dexterous_hand', handType: invType.startsWith('left') ? 'left' : 'right' };
  }
  const m = invType.match(/^(.+)_(left|right)$/);
  if (m) return { equipmentType: m[1], handType: m[2] as 'left' | 'right' };
  return { equipmentType: invType, handType: null };
}

function invalidateCore(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ queryKey: ['inventory'] });
  qc.invalidateQueries({ queryKey: ['transactions'] });
  qc.invalidateQueries({ queryKey: ['sn-registry'] });
}

// ==================== 快速出入库 ====================
interface QuickInOutProps {
  open: boolean;
  type: string;               // 库存类型（如 left_glove / myType_left）
  initialDirection?: 'in' | 'out';
  inventoryConfig?: any[];
  mode?: 'sn' | 'quantity';   // 纯数量模式：服务端原子出入库（自动写流水）
  warehouseId?: string;      // 目标仓库（缺省 main）
  onClose: () => void;
}

export function QuickInOutModal({ open, type, initialDirection = 'in', inventoryConfig, mode = 'sn', warehouseId, onClose }: QuickInOutProps) {
  const [form] = Form.useForm();
  const qc = useQueryClient();
  const user = useAuthStore(s => s.user);
  const [busy, setBusy] = useState(false);
  const [attachment, setAttachment] = useState<File | null>(null);

  useEffect(() => {
    if (open) {
      form.resetFields();
      form.setFieldsValue({ direction: initialDirection, quantity: 1, updatedBy: user?.username || '' });
      setAttachment(null);
    }
  }, [open, initialDirection, form, user?.username]);

  const label = typeLabelOf(type, inventoryConfig);

  const submit = async () => {
    const values = await form.validateFields();
    const qty = Number(values.quantity) || 0;
    if (qty <= 0) { message.error('数量必须大于0'); return; }
    setBusy(true);
    try {
      const delta = values.direction === 'in' ? qty : -qty;

      if (mode === 'quantity') {
        // 纯数量模式：一次调用完成库存增减 + 自动流水（服务端事务内原子完成）
        await api.adjustInventory(type, delta, values.updatedBy, undefined, values.note || '出入库', warehouseId);
        invalidateCore(qc);
        message.success('操作成功！');
        onClose();
        return;
      }

      let attachmentUrl = '';
      if (attachment) attachmentUrl = (await api.uploadAttachment(attachment)) || '';
      await api.adjustInventory(type, delta, values.updatedBy, values.snCode || undefined, undefined, warehouseId);
      const { equipmentType, handType } = txTypeParts(type);
      await api.addTransaction({
        equipmentType, handType, direction: values.direction, quantity: qty,
        snCode: values.snCode || '', machineNumber: values.machineNumber || '',
        updatedBy: values.updatedBy, note: values.note || '', attachment: attachmentUrl,
      });
      if (values.snCode) {
        // 入库登记为可用；出库标记为已调出（与旧版 _registerSN 一致）
        await api.upsertSNRegistry({
          snCode: values.snCode, equipmentType, handType,
          status: values.direction === 'in' ? 'available' : 'transferred',
          machineNumber: '', damageReason: values.direction === 'out' ? '手动出库' : '',
        }).catch(() => {});
      }
      invalidateCore(qc);
      message.success(`操作成功！`);
      onClose();
    } catch (e) {
      message.error((e as Error).message || '操作失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={`${label} - ${initialDirection === 'in' ? '入库' : '出库'}`} open={open} onOk={submit}
      confirmLoading={busy} onCancel={onClose} okText="确定" cancelText="取消" destroyOnClose>
      <Form form={form} layout="vertical">
        <Form.Item label="出入库" name="direction" rules={[{ required: true }]}>
          <Select options={[{ value: 'in', label: '入库 (+)' }, { value: 'out', label: '出库 (-)' }]} />
        </Form.Item>
        <Form.Item label="数量" name="quantity" rules={[{ required: true, message: '请输入数量' }]}>
          <InputNumber min={1} style={{ width: '100%' }} />
        </Form.Item>
        {mode === 'sn' && (
          <>
            <Form.Item label="SN码 (选填)" name="snCode">
              <Input placeholder="输入SN码" autoComplete="off" />
            </Form.Item>
            <Form.Item label="附件/图片">
              <Upload beforeUpload={f => { setAttachment(f); return false; }} onRemove={() => setAttachment(null)}
                fileList={attachment ? [attachment as any] : []} maxCount={1} accept="image/*,.pdf">
                <span style={{ cursor: 'pointer' }}><InboxOutlined /> 选择文件（图片自动识别关联）</span>
              </Upload>
            </Form.Item>
            <Form.Item label="机器编号 (选填)" name="machineNumber">
              <Input placeholder="关联机器编号" />
            </Form.Item>
          </>
        )}
        <Form.Item label="更新人" name="updatedBy" rules={[{ required: true, message: '请输入更新人' }]}>
          <Input />
        </Form.Item>
        <Form.Item label="备注" name="note">
          <Input.TextArea rows={2} placeholder="可选备注" />
        </Form.Item>
      </Form>
    </Modal>
  );
}

// ==================== 直接设置库存（超管） ====================
interface SetInventoryProps {
  open: boolean;
  type: string;
  current: number;
  inventoryConfig?: any[];
  warehouseId?: string;
  onClose: () => void;
}

export function SetInventoryModal({ open, type, current, inventoryConfig, warehouseId, onClose }: SetInventoryProps) {
  const [form] = Form.useForm();
  const qc = useQueryClient();
  const user = useAuthStore(s => s.user);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) { form.resetFields(); form.setFieldsValue({ newQty: current }); }
  }, [open, current, form]);

  const submit = async () => {
    const values = await form.validateFields();
    const newQty = Number(values.newQty);
    if (isNaN(newQty) || newQty < 0) { message.error('请输入有效的库存数量'); return; }
    setBusy(true);
    try {
      const delta = newQty - current;
      const username = user?.username || '系统';
      await api.adjustInventory(type, delta, username, undefined, undefined, warehouseId);
      // 使用基础设备类型记录事务（与旧版一致）
      const { equipmentType, handType } = txTypeParts(type);
      await api.addTransaction({
        equipmentType, handType,
        direction: delta >= 0 ? 'in' : 'out', quantity: Math.abs(delta),
        snCode: '', machineNumber: '', updatedBy: username,
        note: `直接设置库存: ${current}→${newQty}${values.reason ? ` (${values.reason})` : ''}`,
      });
      invalidateCore(qc);
      message.success(`${typeLabelOf(type, inventoryConfig)} 库存已从 ${current} 设置为 ${newQty}`);
      onClose();
    } catch (e) {
      message.error((e as Error).message || '设置失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={`直接设置 ${typeLabelOf(type, inventoryConfig)} 库存`} open={open} onOk={submit}
      confirmLoading={busy} onCancel={onClose} okText="确定" cancelText="取消" destroyOnClose>
      <Form form={form} layout="vertical">
        <Form.Item label="当前库存">
          <Input value={current} disabled />
        </Form.Item>
        <Form.Item label="新库存数量" name="newQty" rules={[{ required: true, message: '请输入新库存' }]}>
          <InputNumber min={0} style={{ width: '100%' }} />
        </Form.Item>
        <Form.Item label="操作原因" name="reason">
          <Input placeholder="请输入操作原因" />
        </Form.Item>
      </Form>
      <Alert type="info" showIcon style={{ fontSize: 12 }}
        message="直接覆盖库存计数器，差值将记录为调整流水。显示的空闲库存以实际SN码数量为准。" />
    </Modal>
  );
}

// ==================== 批量操作（手套/灵巧手：左手+5 / 右手-3） ====================
interface BatchProps {
  open: boolean;
  kind: 'glove' | 'dexterous';
  warehouseId?: string;
  onClose: () => void;
}

export function BatchOperationModal({ open, kind, warehouseId, onClose }: BatchProps) {
  const [form] = Form.useForm();
  const qc = useQueryClient();
  const user = useAuthStore(s => s.user);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) { form.resetFields(); form.setFieldsValue({ updatedBy: user?.username || '' }); }
  }, [open, form, user?.username]);

  const submit = async () => {
    const values = await form.validateFields();
    const lines = String(values.instructions || '').split('\n').map(l => l.trim()).filter(Boolean);
    if (lines.length === 0) { message.error('请输入批量指令'); return; }
    setBusy(true);
    try {
      let successCount = 0;
      const errors: string[] = [];
      for (const line of lines) {
        const match = line.match(/(左手|右手)([+-])(\d+)/);
        if (!match) { errors.push(`无效格式: ${line}`); continue; }
        const hand = match[1] === '左手' ? 'left' : 'right';
        const direction = match[2] === '+' ? 'in' : 'out';
        const qty = parseInt(match[3], 10);
        const invType = kind === 'glove'
          ? (hand === 'left' ? 'left_glove' : 'right_glove')
          : (hand === 'left' ? 'left_dexterous_hand' : 'right_dexterous_hand');
        const delta = direction === 'in' ? qty : -qty;
        try {
          await api.adjustInventory(invType, delta, values.updatedBy, undefined, undefined, warehouseId);
          await api.addTransaction({
            equipmentType: kind === 'glove' ? 'glove' : 'dexterous_hand',
            handType: hand, direction, quantity: qty,
            snCode: '', updatedBy: values.updatedBy, note: '批量操作',
          });
          successCount++;
        } catch (e) {
          errors.push(`${match[1]}: ${(e as Error).message}`);
        }
      }
      invalidateCore(qc);
      if (errors.length > 0) message.warning(`成功 ${successCount} 条，失败 ${errors.length} 条: ${errors.join('; ')}`);
      else message.success(`批量操作成功！共处理 ${successCount} 条记录`);
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={`批量操作${kind === 'glove' ? '手套' : '灵巧手'}`} open={open} onOk={submit}
      confirmLoading={busy} onCancel={onClose} okText="执行" cancelText="取消" destroyOnClose>
      <Alert type="info" showIcon style={{ marginBottom: 12, fontSize: 12 }}
        message='批量操作：输入格式 "左手+n" 或 "右手-n"，每行一条' />
      <Form form={form} layout="vertical">
        <Form.Item label="批量指令" name="instructions" rules={[{ required: true, message: '请输入批量指令' }]}>
          <Input.TextArea rows={6} placeholder={'示例：\n左手+5\n右手+3\n左手-2'} />
        </Form.Item>
        <Form.Item label="更新人" name="updatedBy" rules={[{ required: true, message: '请输入更新人' }]}>
          <Input />
        </Form.Item>
      </Form>
    </Modal>
  );
}
