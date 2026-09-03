// 机器模块弹窗：上/下线表单（统一走服务端原子接口）、批量导入、标记损坏
// 移植 js/ui/machines.js 的 showMachineForm/_showQuickToggleForm/showBulkMachineImport/_markGloveDamaged
import { useEffect, useMemo, useState } from 'react';
import { AutoComplete, Form, Input, Modal, Select, Typography, message } from 'antd';
import { useQueryClient } from '@tanstack/react-query';
import * as api from '@common/api';
import { useMachines, useSNRegistry, useInventory, useTransactions, useEquipmentConfig, useInventoryConfig } from '@common/hooks/useData';
import { useAuthStore } from '@common/stores/auth';
import { latestMachineByNumber, deviceConsumptionMap, deviceTypeLabel, typeLabelOf } from '@common/utils/domain';
import { getHandType, isGloveType } from '@common/utils/format';
import { statusCountsFor } from '@common/hooks/useInventoryStats';
import { txTypeParts } from '../inventory/inventoryModals';

function invalidateCore(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ queryKey: ['machines'] });
  qc.invalidateQueries({ queryKey: ['inventory'] });
  qc.invalidateQueries({ queryKey: ['transactions'] });
  qc.invalidateQueries({ queryKey: ['sn-registry'] });
}

/** 消耗项 → 完整库存类型（自定义类型拼 _left/_right 后缀） */
function fullInvTypeOf(consumed: any): string {
  if (getHandType(consumed.inventoryType)) return consumed.inventoryType;
  return consumed.handType ? `${consumed.inventoryType}_${consumed.handType}` : consumed.inventoryType;
}

/** 移植 _getAvailableSNs：仅从注册表过滤 status=available 的 SN */
function getAvailableSNs(invType: string, registry: any[]): string[] {
  const { equipmentType: eqType, handType: hType } = txTypeParts(invType);
  return (registry || [])
    .filter(r => r.status === 'available' && r.equipmentType === eqType && (!hType || r.handType === hType))
    .map(r => r.snCode);
}

// ==================== 上/下线表单 ====================
interface MachineFormProps {
  open: boolean;
  presetNumber?: string;
  presetStatus?: 'online' | 'offline';
  onClose: () => void;
}

export function MachineFormModal({ open, presetNumber, presetStatus, onClose }: MachineFormProps) {
  const [form] = Form.useForm();
  const qc = useQueryClient();
  const user = useAuthStore(s => s.user);
  const machines = useMachines();
  const snRegistry = useSNRegistry();
  const inventory = useInventory();
  const transactions = useTransactions();
  const equipmentConfig = useEquipmentConfig();
  const inventoryConfig = useInventoryConfig();
  const [busy, setBusy] = useState(false);
  const [snMap, setSnMap] = useState<Record<string, string>>({});            // 上线：fullInvType → SN码
  const [snActions, setSnActions] = useState<Record<string, { action: string; reason: string }>>({}); // 下线：SN → 处理

  const status = Form.useWatch('status', form);
  const deviceType = Form.useWatch('deviceType', form);
  const machineNumber = (Form.useWatch('machineNumber', form) || '').trim();
  const offlineType = Form.useWatch('offlineType', form);

  const machineList = machines.data || [];
  const registry = snRegistry.data || [];
  const existingNumbers = useMemo(() => [...new Set(machineList.map(m => m.machineNumber))], [machineList]);

  useEffect(() => {
    if (!open) return;
    form.resetFields();
    const latestMap = latestMachineByNumber(machineList);
    const preset = presetNumber ? latestMap[presetNumber] : null;
    form.setFieldsValue({
      deviceType: preset?.deviceType || (equipmentConfig.data || [])[0]?.id || 'glove',
      machineNumber: presetNumber || '',
      status: presetStatus || 'online',
      offlineType: 'normal',
      updatedBy: user?.username || '',
    });
    setSnMap({});
    setSnActions({});
  }, [open, presetNumber, presetStatus]); // eslint-disable-line react-hooks/exhaustive-deps

  const eqConfig = (equipmentConfig.data || []).find((c: any) => c.id === deviceType);
  const consumesWithHand = (eqConfig?.consumes || []).filter((c: any) => c.handType);

  // 下线时：该机器上已分配的 SN（注册表为准，兜底取最近一次出库配对）
  const assignedSns = useMemo(() => {
    if (status !== 'offline' || !machineNumber) return [];
    const direct = registry.filter(r => r.machineNumber === machineNumber && r.status === 'in_use');
    if (direct.length > 0) return direct;
    const txs = (transactions.data || []).filter(t => t.machineNumber === machineNumber && t.snCode && t.pairId);
    const pairMap: Record<string, any[]> = {};
    txs.forEach(t => { (pairMap[t.pairId] = pairMap[t.pairId] || []).push(t); });
    const pairs = Object.entries(pairMap).sort((a, b) => new Date(b[1][0].timestamp).getTime() - new Date(a[1][0].timestamp).getTime());
    if (pairs.length > 0 && pairs[0][1][0].direction === 'out') {
      return pairs[0][1].map(t => ({ snCode: t.snCode, equipmentType: t.equipmentType, handType: t.handType }));
    }
    return [];
  }, [status, machineNumber, registry, transactions.data]);

  // 实时预览：将扣减/归还的库存
  const preview = useMemo(() => {
    if (!deviceType || !status) return '';
    const needed = deviceConsumptionMap(equipmentConfig.data || [], deviceType);
    const items = Object.entries(needed).map(([t, q]) => `${typeLabelOf(t, inventoryConfig.data)} ${q}个`).join('、');
    return `${status === 'online' ? '将扣减' : '将归还'}: ${items || '无'}`;
  }, [deviceType, status, equipmentConfig.data, inventoryConfig.data]);

  const submit = async () => {
    const values = await form.validateFields();
    const num = values.machineNumber.trim();
    const st = values.status;
    if (!values.updatedBy?.trim()) { message.error('请输入更新人'); return; }

    // 最新记录已是目标状态 → 阻止重复操作（与旧版一致）
    const latestMap = latestMachineByNumber(machineList);
    const latestRec = latestMap[num];
    if (latestRec && latestRec.status === st) {
      message.warning(`机器 ${num} 已经是${st === 'online' ? '上线' : '下线'}状态`);
      return;
    }

    // 下线时设备类型以现有在线记录为准
    const existingOnline = st === 'offline' ? machineList.find(m => m.machineNumber === num && m.status === 'online') : null;
    const effectiveDeviceType = (st === 'offline' && existingOnline) ? existingOnline.deviceType : values.deviceType;

    setBusy(true);
    try {
      const snOperations: any[] = [];

      if (st === 'online') {
        // 校验：手套类 SN 必填
        const missing = consumesWithHand
          .map((c: any) => fullInvTypeOf(c))
          .filter((t: string) => isGloveType(t) && !snMap[t]);
        if (missing.length > 0) {
          message.error(`请选择SN码：${missing.map((t: string) => typeLabelOf(t, inventoryConfig.data)).join('、')}`);
          return;
        }
        // 校验：可用库存充足（Phase 1.1：检查 available 而非 quantity）
        const invMap: Record<string, any> = {};
        (inventory.data || []).forEach((it: any) => { invMap[it.type] = it; });
        const shortages: string[] = [];
        for (const c of (eqConfig?.consumes || [])) {
          const fullType = fullInvTypeOf(c);
          const inv = invMap[fullType] || {};
          const avail = inv.available != null ? inv.available : statusCountsFor(fullType, registry).available;
          if (avail < c.quantity) {
            shortages.push(`${typeLabelOf(fullType, inventoryConfig.data)} (需要${c.quantity}，可用${avail})`);
          }
        }
        if (shortages.length > 0) { message.error(`库存不足：${shortages.join('、')}`); return; }

        for (const [invType, sn] of Object.entries(snMap)) {
          if (!sn) continue;
          const { equipmentType, handType } = txTypeParts(invType);
          snOperations.push({ snCode: sn, equipmentType, handType, targetStatus: 'in_use' });
        }
      } else {
        // 下线：逐 SN 处理（正常归还 / 损坏 / 调用）
        const transferredSNs: string[] = [];
        let transferLocation = '';
        for (const r of assignedSns) {
          const act = snActions[r.snCode]?.action || 'normal';
          const reasonText = (snActions[r.snCode]?.reason || '').trim();
          if (act === 'damaged') {
            snOperations.push({ snCode: r.snCode, equipmentType: r.equipmentType, handType: r.handType, targetStatus: 'damaged', reason: reasonText || values.reason || '损坏' });
          } else if (act === 'transfer') {
            const loc = reasonText || '未指定地点';
            snOperations.push({ snCode: r.snCode, equipmentType: r.equipmentType, handType: r.handType, targetStatus: 'transferred', reason: loc });
            transferredSNs.push(r.snCode);
            if (!transferLocation) transferLocation = loc;
          } else {
            snOperations.push({ snCode: r.snCode, equipmentType: r.equipmentType, handType: r.handType, targetStatus: 'available' });
          }
        }
        // 全局调用类型：机器上所有 in_use SN 全部调出
        if (values.offlineType === 'transfer') {
          transferLocation = (values.transferLocation || '').trim() || '未指定地点';
          const allSns = assignedSns.map(r => r.snCode);
          snOperations.length = 0;
          for (const r of assignedSns) {
            snOperations.push({ snCode: r.snCode, equipmentType: r.equipmentType, handType: r.handType, targetStatus: 'transferred', reason: transferLocation });
          }
          transferredSNs.length = 0;
          transferredSNs.push(...allSns);
        }
        if (transferredSNs.length > 0) {
          await api.transferGloves({ location: transferLocation || '未指定地点', reason: values.reason || '', snCodes: transferredSNs, notes: '' }).catch(() => {});
        }
      }

      // snOperations 为空时（下线未指定 SN），后端对全部 in_use 应用 offlineType
      const result: any = await api.syncMachineState(num, {
        status: st, deviceType: effectiveDeviceType, reason: values.reason || '',
        offlineType: st === 'offline' ? values.offlineType : undefined, snOperations,
      });
      if (result && result.error) { message.error(`机器${st === 'online' ? '上线' : '下线'}失败: ${result.error}`); return; }

      invalidateCore(qc);
      message.success(`${deviceTypeLabel(effectiveDeviceType)} ${num} ${st === 'online' ? '上线' : '下线'}成功！`);
      onClose();
    } catch (e) {
      message.error((e as Error).message || '操作失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={presetStatus ? (presetStatus === 'online' ? '机器上线' : '机器下线') : '添加机器上/下线记录'}
      open={open} onOk={submit} confirmLoading={busy} onCancel={onClose}
      okText="确定" cancelText="取消" destroyOnClose width={560}
    >
      <Form form={form} layout="vertical">
        <Form.Item label="设备类型" name="deviceType" rules={[{ required: true }]}>
          <Select options={(equipmentConfig.data || []).map((c: any) => {
            const consumeDesc = (c.consumes || []).map((co: any) => {
              const label = typeLabelOf(fullInvTypeOf(co), inventoryConfig.data);
              return `${label} x${co.quantity}`;
            }).join(' + ');
            return { value: c.id, label: `${c.icon || ''} ${c.name} (消耗${consumeDesc})` };
          })} />
        </Form.Item>
        <Form.Item label="机器编号" name="machineNumber" rules={[{ required: true, message: '请输入机器编号' }]}>
          <AutoComplete
            placeholder="选择已有编号或输入新编号"
            options={existingNumbers.map(n => ({ value: n }))}
            filterOption={(q, opt) => String(opt?.value).toLowerCase().includes(q.toLowerCase())}
          />
        </Form.Item>
        <Form.Item label="上/下线" name="status" rules={[{ required: true }]}>
          <Select options={[
            { value: 'online', label: '上线 (自动扣减库存)' },
            { value: 'offline', label: '下线 (自动归还库存)' },
          ]} />
        </Form.Item>
        <Form.Item label="原因" name="reason">
          <Input placeholder="上线或下线原因" />
        </Form.Item>

        {status === 'offline' && (
          <>
            <Form.Item label="下线类型" name="offlineType">
              <Select options={[
                { value: 'normal', label: '正常归还' },
                { value: 'damaged', label: '手套损坏' },
                { value: 'transfer', label: '调用/转移' },
              ]} />
            </Form.Item>
            {offlineType === 'transfer' && (
              <Form.Item label="调出地点" name="transferLocation" rules={[{ required: true, message: '请输入调出地点' }]}>
                <Input placeholder="例如：广州工厂、上海仓库" />
              </Form.Item>
            )}
          </>
        )}

        {/* 上线：按消耗配置逐项选择可用 SN */}
        {status === 'online' && consumesWithHand.length > 0 && (
          <Form.Item label="SN码选择" required>
            {consumesWithHand.map((c: any) => {
              const fullType = fullInvTypeOf(c);
              const available = getAvailableSNs(fullType, registry);
              const handLabel = c.handType === 'left' ? '左手' : '右手';
              return (
                <div key={fullType} style={{ marginBottom: 8 }}>
                  <div style={{ fontSize: 12, opacity: 0.7 }}>
                    {handLabel}{typeLabelOf(fullType, inventoryConfig.data)}{' '}
                    <span style={{ color: '#22c55e' }}>({available.length}个可用)</span>{' '}
                    <span style={{ color: '#ef4444' }}>*</span>
                  </div>
                  <AutoComplete
                    placeholder="搜索或输入SN码..."
                    value={snMap[fullType] || ''}
                    onChange={v => setSnMap(prev => ({ ...prev, [fullType]: v }))}
                    options={available.map(sn => ({ value: sn }))}
                    filterOption={(q, opt) => String(opt?.value).toLowerCase().includes(q.toLowerCase())}
                  />
                </div>
              );
            })}
          </Form.Item>
        )}

        {/* 下线：逐个选择 SN 状态（全局调用类型时由后端统一处理） */}
        {status === 'offline' && offlineType !== 'transfer' && (
          assignedSns.length > 0 ? (
            <Form.Item label="SN码状态（逐个选择）">
              {assignedSns.map(r => {
                const handLabel = r.handType === 'left' ? '左手' : r.handType === 'right' ? '右手' : '';
                const act = snActions[r.snCode]?.action || 'normal';
                return (
                  <div key={r.snCode} style={{ marginBottom: 6, padding: '6px 8px', background: 'rgba(128,128,128,0.08)', borderRadius: 6 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <Typography.Text code style={{ flex: 1 }}>{r.snCode}</Typography.Text>
                      <span style={{ fontSize: 12, opacity: 0.6 }}>{handLabel}{r.equipmentType}</span>
                      <Select size="small" style={{ width: 90 }} value={act}
                        onChange={v => setSnActions(prev => ({ ...prev, [r.snCode]: { action: v, reason: prev[r.snCode]?.reason || '' } }))}
                        options={[{ value: 'normal', label: '正常' }, { value: 'damaged', label: '损坏' }, { value: 'transfer', label: '调用' }]} />
                    </div>
                    {act !== 'normal' && (
                      <Input size="small" style={{ marginTop: 4 }}
                        placeholder={act === 'damaged' ? '描述损坏情况' : '调出地点（如：广州工厂、上海仓库）'}
                        value={snActions[r.snCode]?.reason || ''}
                        onChange={e => setSnActions(prev => ({ ...prev, [r.snCode]: { action: act, reason: e.target.value } }))} />
                    )}
                  </div>
                );
              })}
            </Form.Item>
          ) : (
            <div style={{ fontSize: 12, opacity: 0.6, marginBottom: 12 }}>该机器无已分配的SN码</div>
          )
        )}

        <Form.Item label="更新人" name="updatedBy" rules={[{ required: true, message: '请输入更新人' }]}>
          <Input />
        </Form.Item>
        <div style={{ fontSize: 12, opacity: 0.65 }}>{preview}</div>
        <div style={{ fontSize: 12, opacity: 0.5, marginTop: 6 }}>
          💡 选择已有编号 → 从列表选取；新机器 → 直接输入新编号。同一编号不可重复上线/下线。
        </div>
      </Form>
    </Modal>
  );
}

// ==================== 批量导入（格式：编号,类型,状态,原因） ====================
export function BulkImportModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [form] = Form.useForm();
  const qc = useQueryClient();
  const machines = useMachines();
  const equipmentConfig = useEquipmentConfig();
  const [busy, setBusy] = useState(false);

  useEffect(() => { if (open) form.resetFields(); }, [open, form]);

  const submit = async () => {
    const values = await form.validateFields();
    const lines = String(values.data || '').split('\n').map(l => l.trim()).filter(Boolean);
    if (lines.length === 0) { message.error('请输入数据'); return; }
    setBusy(true);
    try {
      const latestMap = latestMachineByNumber(machines.data || []);
      const eqIds = (equipmentConfig.data || []).map((c: any) => c.id);
      const validTypes = eqIds.length > 0 ? eqIds : ['glove', 'dexterous', 'gripper'];
      let successCount = 0;
      const errors: string[] = [];

      for (const line of lines) {
        const parts = line.split(',').map(p => p.trim());
        if (parts.length < 3) { errors.push(`格式错误: ${line}`); continue; }
        const [machineNumber, devType, status, reason] = parts;
        if (!validTypes.includes(devType)) { errors.push(`无效设备类型: ${machineNumber}`); continue; }
        if (!['online', 'offline'].includes(status)) { errors.push(`无效状态: ${machineNumber}`); continue; }
        const latest = latestMap[machineNumber];
        if (latest && latest.status === status) { errors.push(`${machineNumber} 已为${status === 'online' ? '上线' : '下线'}状态`); continue; }

        try {
          // 统一走服务端原子接口：SN 释放/绑定、库存重算、流水、机器记录均在服务端事务内完成。
          // （旧实现手动 adjustInventory/addTransaction/addMachine，在 SN 化库存下会误删/虚增 SN）
          const result: any = await api.syncMachineState(machineNumber, {
            status, deviceType: devType, reason: reason || '',
            offlineType: status === 'offline' ? 'normal' : undefined,
            snOperations: [],
          });
          if (result && result.error) { errors.push(`${machineNumber}: ${result.error}`); continue; }
          successCount++;
        } catch (e) {
          errors.push(`${machineNumber}: ${(e as Error).message}`);
        }
      }
      invalidateCore(qc);
      if (errors.length > 0) message.warning(`导入完成: 成功 ${successCount} 条，失败 ${errors.length} 条`);
      else message.success(`批量导入成功！共处理 ${successCount} 条记录`);
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="批量导入机器" open={open} onOk={submit} confirmLoading={busy} onCancel={onClose}
      okText="导入" cancelText="取消" destroyOnClose>
      <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 8 }}>
        每行一条，格式为 <Typography.Text code>机器编号,设备类型(glove/dexterous/gripper),状态(online/offline),原因</Typography.Text>
      </div>
      <Form form={form} layout="vertical">
        <Form.Item name="data" rules={[{ required: true, message: '请输入数据' }]}>
          <Input.TextArea rows={8} placeholder={'示例：\nM001,glove,online,新机器上线\nM002,dexterous,online,新机器上线\nM003,gripper,offline,维护中'} />
        </Form.Item>
      </Form>
      <div style={{ fontSize: 12, opacity: 0.5 }}>
        💡 批量导入不绑定SN手套；机器上线后请在机器管理页逐台绑定左/右手套。
      </div>
    </Modal>
  );
}

// ==================== 标记损坏（填原因 → damaged + 出库流水） ====================
export function MarkDamagedModal({ open, snCode, machineNumber, onClose }: {
  open: boolean; snCode: string; machineNumber: string; onClose: () => void;
}) {
  const [form] = Form.useForm();
  const qc = useQueryClient();
  const user = useAuthStore(s => s.user);
  const snRegistry = useSNRegistry();
  const [busy, setBusy] = useState(false);

  useEffect(() => { if (open) form.resetFields(); }, [open, form]);

  const submit = async () => {
    const values = await form.validateFields();
    const reason = (values.reason || '').trim();
    if (!reason) { message.error('请填写损坏原因'); return; }
    const regEntry = (snRegistry.data || []).find(r => r.snCode === snCode);
    if (!regEntry) { message.error('SN码未注册'); return; }
    setBusy(true);
    try {
      const username = user?.username || '系统';
      await api.upsertSNRegistry({
        snCode, equipmentType: regEntry.equipmentType, handType: regEntry.handType,
        status: 'damaged', machineNumber, damageReason: reason,
      });
      await api.addTransaction({
        equipmentType: regEntry.equipmentType, handType: regEntry.handType,
        direction: 'out', quantity: 1, snCode, machineNumber,
        updatedBy: username, note: `机器上标记损坏: ${reason}`,
      });
      invalidateCore(qc);
      message.success(`${snCode} 已标记为损坏`);
      onClose();
    } catch (e) {
      message.error((e as Error).message || '操作失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={`标记损坏 — ${snCode}`} open={open} onOk={submit} confirmLoading={busy}
      onCancel={onClose} okText="确定" cancelText="取消" destroyOnClose>
      <Form form={form} layout="vertical">
        <Form.Item label="损坏原因" name="reason" rules={[{ required: true, message: '请填写损坏原因' }]}>
          <Input placeholder="描述损坏情况" />
        </Form.Item>
      </Form>
    </Modal>
  );
}

/** 替换手套：将该机器上所有绑定 SN 标记为损坏（与旧版 _replaceGlove 一致，不记流水） */
export async function replaceGloves(machineNumber: string, registry: any[]): Promise<void> {
  const bound = registry.filter(r => r.machineNumber === machineNumber && r.status === 'in_use');
  for (const r of bound) {
    await api.upsertSNRegistry({
      snCode: r.snCode, equipmentType: r.equipmentType, handType: r.handType,
      status: 'damaged', machineNumber, damageReason: '替换手套',
    });
  }
}
