// 操作审计日志页（移植 js/ui/audit-log.js）
import { Table, Tag } from 'antd';
import { PageContainer } from '@common/components/PageContainer';
import { useAuditLog } from '@common/hooks/useData';
import { formatTime } from '@common/utils/format';

const ACTION_LABELS: Record<string, string> = {
  inventory_update: '库存更新',
  machine_add: '添加机器',
  machine_status: '机器上下线',
  machine_delete: '删除机器',
  transaction: '流水记录',
  transaction_delete: '删除流水',
  clear_all: '清空数据',
  user_add: '添加用户',
  user_delete: '删除用户',
  settings_update: '系统设置',
  equipment_config: '设备配置',
  inventory_config: '库存配置',
  backup_restore: '备份恢复',
};

const auditActionLabel = (action: string) => ACTION_LABELS[action] || action;

export default function AuditLogPage() {
  const { data: logs = [], isLoading } = useAuditLog();

  return (
    <PageContainer title="操作审计日志" subtitle="记录所有系统操作，最多保留1000条">
      <Table
        rowKey={(l: any) => l.id || `${l.timestamp}_${l.action}_${l.detail}`}
        size="small"
        loading={isLoading}
        dataSource={logs}
        pagination={{ pageSize: 20, showSizeChanger: true, showTotal: t => `共 ${t} 条` }}
        columns={[
          {
            title: '时间', dataIndex: 'timestamp', width: 180,
            render: (v: string) => formatTime(v),
            sorter: (a: any, b: any) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
            defaultSortOrder: 'descend',
          },
          {
            title: '操作类型', dataIndex: 'action', width: 140,
            render: (v: string) => <Tag color="blue">{auditActionLabel(v)}</Tag>,
            filters: Object.entries(ACTION_LABELS).map(([value, text]) => ({ value, text })),
            onFilter: (value: any, record: any) => record.action === value,
          },
          { title: '详情', dataIndex: 'detail', ellipsis: true },
          { title: '操作人', dataIndex: 'user', width: 120 },
        ]}
      />
    </PageContainer>
  );
}
