// 状态标签：基于状态元数据映射的 AntD Tag
import { Tag } from 'antd';
import { SN_STATUS_META, MACHINE_STATUS_META } from '../utils/domain';
import { tsBucket } from '../types';

export function SNStatusTag({ status }: { status?: string }) {
  const meta = SN_STATUS_META[status || ''];
  return <Tag color={meta?.color || 'default'}>{meta?.label || status || '-'}</Tag>;
}

export function MachineStatusTag({ status }: { status?: string }) {
  const meta = MACHINE_STATUS_META[status || ''];
  return <Tag color={meta?.color || 'default'}>{meta?.label || status || '-'}</Tag>;
}

const TS_BUCKET_META: Record<string, { label: string; color: string }> = {
  pending: { label: '待处理', color: 'orange' },
  responded: { label: '已响应', color: 'blue' },
  completed: { label: '已完成', color: 'green' },
};

export function TicketStatusTag({ status }: { status?: string }) {
  const bucket = tsBucket(status);
  const meta = TS_BUCKET_META[bucket];
  return <Tag color={meta?.color || 'default'}>{meta?.label || status || '-'}</Tag>;
}
