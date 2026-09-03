// 个人分析（移植 OpsApp.renderPersonalAnalysis）：问候 + 概览卡片 + 近期任务/需求
import { useMemo } from 'react';
import { Card, Col, Empty, Row, Tag } from 'antd';
import { useNavigate } from 'react-router-dom';
import { useAuthStore } from '@common/stores/auth';
import { useUIStore } from '@common/stores/ui';
import { loadRequirements, loadTasks, PRIORITY_COLOR } from '../common/opsLocalData';

export default function PersonalAnalysisPage() {
  const user = useAuthStore(s => s.user);
  const dark = useUIStore(s => s.theme === 'dark');
  const navigate = useNavigate();
  const neutral = dark ? '#fafafa' : '#0a0a0a';

  const { tasks, reqs } = useMemo(() => ({ tasks: loadTasks(), reqs: loadRequirements() }), []);
  const tasksDone = tasks.filter(t => t.done).length;

  const overview = [
    { label: '总任务数', value: tasks.length, color: '#3b82f6', to: '/tasks' },
    { label: '已完成', value: tasksDone, color: '#10b981', to: '/tasks' },
    { label: '需求数', value: reqs.length, color: '#f59e0b', to: '/requirements' },
    { label: '待处理', value: tasks.filter(t => !t.done).length, color: '#8b5cf6', to: '/analysis' },
  ];

  return (
    <div style={{ padding: '20px 24px' }}>
      {/* 问候区 */}
      <Card style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
          <div style={{
            width: 56, height: 56, borderRadius: '50%', flexShrink: 0,
            background: neutral, color: dark ? '#0a0a0a' : '#fff',
            display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 24, fontWeight: 700,
          }}>{(user?.username || '?')[0].toUpperCase()}</div>
          <div>
            <h2 style={{ margin: 0, fontSize: 20 }}>你好，{user?.username || '--'}</h2>
            <div style={{ opacity: 0.6, fontSize: 13, marginTop: 4 }}>欢迎回到运营管理系统</div>
          </div>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 24 }}>
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: 20, fontWeight: 700, color: neutral }}>{tasksDone}/{tasks.length}</div>
              <div style={{ fontSize: 12, opacity: 0.6 }}>任务完成</div>
            </div>
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: 20, fontWeight: 700, color: '#f59e0b' }}>{reqs.length}</div>
              <div style={{ fontSize: 12, opacity: 0.6 }}>需求总数</div>
            </div>
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: 20, fontWeight: 700, color: neutral }}>{tasks.length}</div>
              <div style={{ fontSize: 12, opacity: 0.6 }}>待办事项</div>
            </div>
          </div>
        </div>
      </Card>

      {/* 概览卡片 */}
      <Row gutter={[16, 16]} style={{ marginBottom: 16 }}>
        {overview.map(o => (
          <Col xs={12} sm={6} key={o.label}>
            <Card hoverable onClick={() => navigate(o.to)} style={{ borderLeft: `4px solid ${o.color}` }}>
              <div style={{ fontSize: 26, fontWeight: 700 }}>{o.value}</div>
              <div style={{ fontSize: 13, opacity: 0.6 }}>{o.label}</div>
            </Card>
          </Col>
        ))}
      </Row>

      {/* 近期任务 / 近期需求 */}
      <Row gutter={[16, 16]}>
        <Col xs={24} lg={12}>
          <Card size="small" title="📋 近期任务">
            {tasks.length === 0 ? (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无任务" />
            ) : tasks.slice(0, 6).map(t => (
              <div key={t.id} style={{
                display: 'flex', alignItems: 'center', gap: 8, padding: '8px 0',
                borderBottom: '1px solid rgba(128,128,128,.08)',
                opacity: t.done ? 0.5 : 1, textDecoration: t.done ? 'line-through' : undefined,
              }}>
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: PRIORITY_COLOR[t.priority] || '#f59e0b', flexShrink: 0 }} />
                <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.text}</span>
                <span style={{ fontSize: 12, opacity: 0.5 }}>{t.date || ''}</span>
              </div>
            ))}
          </Card>
        </Col>
        <Col xs={24} lg={12}>
          <Card size="small" title="💡 近期需求">
            {reqs.length === 0 ? (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无需求" />
            ) : reqs.slice(0, 6).map(r => (
              <div key={r.id} style={{
                display: 'flex', alignItems: 'center', gap: 8, padding: '8px 0',
                borderBottom: '1px solid rgba(128,128,128,.08)',
              }}>
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: PRIORITY_COLOR[r.priority] || '#f59e0b', flexShrink: 0 }} />
                <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.title}</span>
                <Tag style={{ marginInlineEnd: 0 }}>{r.date || ''}</Tag>
              </div>
            ))}
          </Card>
        </Col>
      </Row>
    </div>
  );
}
