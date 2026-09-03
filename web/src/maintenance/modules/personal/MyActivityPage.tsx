// 我的操作记录页（移植 js/ui/personal-center.js renderMyActivity）：服务端 + 本地合并
import { useEffect, useMemo, useState } from 'react';
import { Button, Input, Select, Table, Tag, message } from 'antd';
import { DownloadOutlined } from '@ant-design/icons';
import { PageContainer } from '@common/components/PageContainer';
import { useAuthStore } from '@common/stores/auth';
import * as api from '@common/api';

const ACTIVITY_KEY = 'gms_activity_log';
function getLocalActivity(): any[] {
  try { return JSON.parse(localStorage.getItem(ACTIVITY_KEY) || '[]'); } catch { return []; }
}

export default function MyActivityPage() {
  const user = useAuthStore(s => s.user);
  const [list, setList] = useState<any[]>(getLocalActivity);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('');

  // 拉取服务端个人操作记录并与本地合并去重（移植 renderMyActivity）
  useEffect(() => {
    (async () => {
      try {
        const data = await api.getMyActivity(100);
        const serverItems = (data?.items || []).map((i: any) => ({
          id: i.id || `srv-${i.time}`,
          time: new Date(i.time).getTime(),
          action: i.action,
          detail: i.detail || '',
          user: i.user || user?.username || '',
          ip: i.ip || '—',
        }));
        if (serverItems.length > 0) {
          const merged = [...serverItems, ...getLocalActivity()];
          const seen = new Set<string>();
          const deduped = merged.filter(x => {
            const k = `${x.time}|${x.action}`;
            if (seen.has(k)) return false;
            seen.add(k);
            return true;
          }).sort((a, b) => b.time - a.time);
          setList(deduped);
        }
      } catch { /* 本地数据兜底 */ }
    })();
  }, [user?.username]);

  const filtered = useMemo(() => {
    const kw = search.trim().toLowerCase();
    return list.filter(l => {
      if (filter && !String(l.action).toLowerCase().includes(filter)) return false;
      if (kw && !`${l.action} ${l.detail}`.toLowerCase().includes(kw)) return false;
      return true;
    });
  }, [list, search, filter]);

  const exportCSV = () => {
    const rows = [
      '时间,操作,详情,用户,IP',
      ...filtered.map(l => [
        new Date(l.time).toLocaleString('zh-CN'), l.action, l.detail || '', l.user || '', l.ip || '',
      ].map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')),
    ];
    const blob = new Blob([`\uFEFF${rows.join('\n')}`], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `我的操作记录-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    message.success('CSV导出成功');
  };

  const columns: any[] = [
    {
      title: '时间', dataIndex: 'time', width: 170,
      render: (t: number) => new Date(t).toLocaleString('zh-CN'),
      sorter: (a: any, b: any) => a.time - b.time,
      defaultSortOrder: 'descend',
    },
    { title: '操作', dataIndex: 'action', width: 160, render: (a: string) => <Tag color="blue">{a}</Tag> },
    { title: '详情', dataIndex: 'detail' },
    { title: 'IP', dataIndex: 'ip', width: 120, render: (v: string) => v || '—' },
  ];

  return (
    <PageContainer
      title="📋 我的操作记录"
      subtitle="追踪您在系统中的所有操作，便于合规审计"
      extra={
        <>
          <Input placeholder="搜索操作或详情..." allowClear style={{ width: 200 }}
            value={search} onChange={e => setSearch(e.target.value)} />
          <Select style={{ width: 130 }} value={filter} onChange={setFilter} options={[
            { value: '', label: '所有操作' },
            { value: 'login', label: '登录相关' },
            { value: 'inventory', label: '库存' },
            { value: 'machine', label: '机器' },
            { value: 'user', label: '用户' },
            { value: 'settings', label: '设置' },
            { value: 'view', label: '查看' },
          ]} />
          <Button icon={<DownloadOutlined />} onClick={exportCSV}>导出 (CSV)</Button>
        </>
      }
    >
      <Table rowKey="id" size="middle" columns={columns} dataSource={filtered}
        pagination={{ pageSize: 30, showTotal: t => `共 ${t} 条记录` }} />
    </PageContainer>
  );
}
