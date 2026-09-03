// 任务列表（移植 OpsApp.renderTaskList/addTask/toggleTask/deleteTask）：
// 数据存 localStorage ops_tasks
import { useState } from 'react';
import { App as AntApp, Button, Card, Checkbox, Empty, Input, Popconfirm, Select, Tag } from 'antd';
import { DeleteOutlined } from '@ant-design/icons';
import { PageContainer } from '@common/components/PageContainer';
import { loadTasks, saveTasks, PRIORITY_COLOR, type OpsTask } from '../common/opsLocalData';

export default function TaskListPage() {
  const { message } = AntApp.useApp();
  const [tasks, setTasks] = useState<OpsTask[]>(loadTasks);
  const [text, setText] = useState('');
  const [priority, setPriority] = useState<'high' | 'medium' | 'low'>('medium');

  const update = (next: OpsTask[]) => { saveTasks(next); setTasks([...next]); };

  const pending = tasks.filter(t => !t.done);
  const done = tasks.filter(t => t.done);

  const addTask = () => {
    const v = text.trim();
    if (!v) return;
    update([{
      id: 't' + Date.now(),
      text: v,
      priority,
      done: false,
      date: new Date().toLocaleDateString('zh-CN'),
    }, ...tasks]);
    setText('');
    message.success('任务已添加');
  };

  const toggleTask = (id: string) => {
    update(tasks.map(t => t.id === id ? { ...t, done: !t.done } : t));
  };

  const deleteTask = (id: string) => {
    update(tasks.filter(t => t.id !== id));
    message.success('任务已删除');
  };

  const renderList = (list: OpsTask[], isDone: boolean) => (
    <div>
      {list.map(t => (
        <div key={t.id} style={{
          display: 'flex', alignItems: 'center', gap: 10, padding: '10px 4px',
          borderBottom: '1px solid rgba(128,128,128,.08)', cursor: 'pointer',
          opacity: isDone ? 0.6 : 1,
        }} onClick={() => toggleTask(t.id)}>
          <Checkbox checked={t.done} onChange={() => toggleTask(t.id)} onClick={e => e.stopPropagation()} />
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: PRIORITY_COLOR[t.priority] || '#f59e0b', flexShrink: 0 }} />
          <span style={{
            flex: 1, minWidth: 0, textDecoration: t.done ? 'line-through' : undefined,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>{t.text}</span>
          <span style={{ fontSize: 12, opacity: 0.5 }}>{t.date || ''}</span>
          <Popconfirm title="删除该任务？" onConfirm={e => { e?.stopPropagation(); deleteTask(t.id); }}
            onCancel={e => e?.stopPropagation()} okText="删除" cancelText="取消" okButtonProps={{ danger: true }}>
            <Button size="small" type="text" danger icon={<DeleteOutlined />} onClick={e => e.stopPropagation()} />
          </Popconfirm>
        </div>
      ))}
    </div>
  );

  return (
    <PageContainer title="📋 任务列表" subtitle={`${pending.length} 待完成 / ${done.length} 已完成`}>
      <Card size="small" style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Input
            style={{ flex: 1, minWidth: 220 }}
            placeholder="添加新任务..."
            value={text}
            onChange={e => setText(e.target.value)}
            onPressEnter={addTask}
          />
          <Select value={priority} onChange={setPriority} style={{ width: 110 }}
            options={[
              { value: 'high', label: '高优先' },
              { value: 'medium', label: '中优先' },
              { value: 'low', label: '低优先' },
            ]} />
          <Button type="primary" onClick={addTask}>添加</Button>
        </div>
      </Card>

      {tasks.length === 0 && (
        <Card><Empty description="暂无任务，添加一个开始吧" /></Card>
      )}

      {pending.length > 0 && (
        <Card size="small" title={<span>待完成 <Tag color="blue">{pending.length}</Tag></span>} style={{ marginBottom: 16 }}>
          {renderList(pending, false)}
        </Card>
      )}

      {done.length > 0 && (
        <Card size="small" title={<span>已完成 <Tag color="green">{done.length}</Tag></span>}>
          {renderList(done.slice(0, 20), true)}
        </Card>
      )}
    </PageContainer>
  );
}
