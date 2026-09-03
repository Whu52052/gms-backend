// 顶栏全局搜索：搜索 SN 码 / 更新人 / 机器编号（旧版 Ctrl+S）
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AutoComplete, Input } from 'antd';
import { SearchOutlined } from '@ant-design/icons';
import { useMachines, useSNRegistry } from '@common/hooks/useData';

export function GlobalSearch() {
  const navigate = useNavigate();
  const [keyword, setKeyword] = useState('');
  const machines = useMachines();
  const snRegistry = useSNRegistry();

  // Ctrl+S 聚焦（旧版行为）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && (e.key === 's' || e.key === 'S')) {
        const el = document.getElementById('global-search-input') as HTMLInputElement | null;
        if (el) { e.preventDefault(); el.focus(); }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const q = keyword.trim().toLowerCase();
  const options = !q ? [] : [
    ...(snRegistry.data || [])
      .filter((r: any) => String(r.snCode || '').toLowerCase().includes(q))
      .slice(0, 5)
      .map((r: any) => ({
        value: `sn:${r.snCode}`,
        label: `SN码: ${r.snCode}（${r.status || '-'}）`,
      })),
    ...(machines.data || [])
      .filter((m: any) => String(m.machineNumber || '').toLowerCase().includes(q))
      .slice(0, 5)
      .map((m: any) => ({
        value: `machine:${m.machineNumber}`,
        label: `机器: ${m.machineNumber}`,
      })),
    { value: `tx:${keyword}`, label: `在流水记录中搜索 "${keyword}"` },
  ];

  return (
    <AutoComplete
      options={options}
      value={keyword}
      onChange={setKeyword}
      onSelect={(val: string) => {
        if (val.startsWith('sn:')) navigate(`/sn-codes?q=${encodeURIComponent(val.slice(3))}`);
        else if (val.startsWith('machine:')) navigate(`/machines?q=${encodeURIComponent(val.slice(8))}`);
        else if (val.startsWith('tx:')) navigate(`/transactions?q=${encodeURIComponent(val.slice(3))}`);
        setKeyword('');
      }}
      style={{ width: 260 }}
    >
      <Input
        id="global-search-input"
        placeholder="搜索SN码、机器编号 (Ctrl+S)"
        prefix={<SearchOutlined style={{ opacity: 0.45 }} />}
        allowClear
      />
    </AutoComplete>
  );
}
