// 流水操作：删除冲正（移植 app.deleteTransaction）+ CSV 导出（移植 app.exportCSV）
import { Modal, message } from 'antd';
import { useQueryClient } from '@tanstack/react-query';
import * as api from '@common/api';
import { useAuthStore, isAdmin } from '@common/stores/auth';
import { typeLabelOf } from '@common/utils/domain';
import { equipmentLabel } from '@common/utils/format';

/** 删除流水并自动冲正库存 */
export function useDeleteTransaction() {
  const qc = useQueryClient();
  const user = useAuthStore(s => s.user);

  return (tx: any, inventoryConfig?: any[]) => {
    if (!isAdmin(user)) { message.error('无删除权限，仅管理员可删除记录'); return; }
    // 计算库存冲正类型（移植旧版逻辑）
    let invType = tx.equipmentType === 'glove'
      ? (tx.handType === 'left' ? 'left_glove' : 'right_glove')
      : tx.equipmentType === 'dexterous_hand'
        ? (tx.handType === 'left' ? 'left_dexterous_hand' : 'right_dexterous_hand')
        : tx.equipmentType;
    // 动态库存类型：equipmentType 是基础类型，需要拼接 handType 后缀（与旧版一致）
    if (invType && invType !== 'glove' && invType !== 'dexterous_hand' && invType !== 'gripper'
      && !invType.startsWith('left_') && !invType.startsWith('right_')
      && !invType.endsWith('_left') && !invType.endsWith('_right')
      && (tx.handType === 'left' || tx.handType === 'right')) {
      invType = `${invType}_${tx.handType}`;
    }
    const reverseDelta = tx.direction === 'in' ? -tx.quantity : tx.quantity;
    const label = typeLabelOf(invType, inventoryConfig);

    Modal.confirm({
      title: '删除交易记录',
      content: `确认删除此记录并自动${reverseDelta > 0 ? '归还' : '扣减'}库存？${label}: ${tx.direction === 'in' ? '入库' : '出库'} ${tx.quantity}个 → 删除后${reverseDelta > 0 ? '增加' : '减少'} ${Math.abs(reverseDelta)}个`,
      okText: '删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        const reversalUser = tx.updatedBy || user?.username || '系统';
        try {
          // SN 化库存：带 SN 的流水按 SN 精准冲正（库存由服务端从注册表重算）；
          // adjustInventory 在 SN 模式下会随机删除/新建 ADJ 占位 SN，仅用于无 SN 的旧流水
          if (tx.snCode) {
            if (reverseDelta > 0) {
              // 撤销出库 → 该 SN 恢复为可用（自动归还在用/损坏/调出状态）
              await api.changeSNStatus({ snCode: tx.snCode, newStatus: 'available', reason: '删除流水记录自动冲正', machineNumber: '' }).catch(() => {});
            } else {
              // 撤销入库 → 该 SN 退役（不再计入库存，保留审计轨迹）
              await api.changeSNStatus({ snCode: tx.snCode, newStatus: 'scrapped', reason: '删除流水记录自动冲正' }).catch(() => {});
            }
          } else {
            await api.adjustInventory(invType, reverseDelta, reversalUser);
          }
          await api.addTransaction({
            equipmentType: tx.equipmentType, handType: tx.handType,
            direction: reverseDelta > 0 ? 'in' : 'out', quantity: Math.abs(reverseDelta),
            snCode: tx.snCode || '', machineNumber: tx.machineNumber || '',
            updatedBy: reversalUser, note: '删除流水记录自动冲正',
          });
          await api.deleteTransaction(tx.id);
          qc.invalidateQueries({ queryKey: ['transactions'] });
          qc.invalidateQueries({ queryKey: ['inventory'] });
          qc.invalidateQueries({ queryKey: ['sn-registry'] });
          message.success(`记录已删除，库存已自动${reverseDelta > 0 ? '归还' : '扣减'} ${Math.abs(reverseDelta)}个`);
        } catch (e) {
          message.error((e as Error).message || '删除失败');
        }
      },
    });
  };
}

/** 导出流水 CSV（带 BOM，Excel 直接打开） */
export function exportTransactionsCSV(transactions: any[]) {
  const header = ['时间', '设备类型', '操作', '数量', 'SN码', '机器编号', '操作人', '备注'];
  const rows = transactions.map(t => [
    t.timestamp ? new Date(t.timestamp).toLocaleString('zh-CN') : '',
    equipmentLabel(t.equipmentType, t.handType),
    t.direction === 'in' ? '入库' : '出库',
    t.quantity,
    t.snCode || '', t.machineNumber || '', t.updatedBy || '', t.note || '',
  ]);
  const csv = '\uFEFF' + [header, ...rows]
    .map(row => row.map(c => `"${String(c ?? '').replace(/"/g, '""')}"`).join(','))
    .join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `流水记录-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}
