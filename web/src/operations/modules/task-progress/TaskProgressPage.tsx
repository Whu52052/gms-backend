// 任务进度：聚合本地任务/需求完成情况（后端无 /api/task-progress 路由，旧版该 tab 无实现，
// 此处基于 ops_tasks / ops_requirements 给出进度总览）
import { useMemo } from 'react';
import { Card, Col, Empty, Progress, Row, Tag } from 'antd';
import { PageContainer } from '@common/components/PageContainer';
import { useUIStore } from '@common/stores/ui';
import {
  loadRequirements, loadTasks, PRIORITY_COLOR, PRIORITY_LABEL, REQ_STATUS_COLOR, REQ_STATUS_LABEL,
} from '../common/opsLocalData';

export default function TaskProgressPage() {
  const dark = useUIStore(s => s.theme === 'dark');
  const { tasks, reqs } = useMemo(() => ({ tasks: loadTasks(), reqs: loadRequirements() }), []);

  const done = tasks.filter(t => t.done).length;
  const percent = tasks.length ? Math.round((done / tasks.length) * 100) : 0;
  const high = tasks.filter(t => t.priority === 'high' && !t.done);
  const approved = reqs.filter(r => r.status === 'approved').length;
  const reqPercent = reqs.length ? Math.round((approved / reqs.length) * 100) : 0;

  return (
    <PageContainer title="📈 任务进度" subtitle="本地任务与需求的完成进度总览">
      <Row gutter={[16, 16]}>
        <Col xs={24} md={12}>
          <Card size="small" title="任务完成率">
            <div style={{ textAlign: 'center', padding: '12px 0' }}>
              <Progress type="dashboard" percent={percent}
                strokeColor={dark ? '#fafafa' : '#0a0a0a'} />
              <div style={{ marginTop: 8, opacity: 0.7, fontSize: 13 }}>{done} / {tasks.length} 已完成</div>
            </div>
          </Card>
        </Col>
        <Col xs={24} md={12}>
          <Card size="small" title="需求通过率">
            <div style={{ textAlign: 'center', padding: '12px 0' }}>
              <Progress type="dashboard" percent={reqPercent}
                strokeColor={{ '0%': '#f59e0b', '100%': '#10b981' }} />
              <div style={{ marginTop: 8, opacity: 0.7, fontSize: 13 }}>{approved} / {reqs.length} 已通过</div>
            </div>
          </Card>
        </Col>

        <Col xs={24}>
          <Card size="small" title={`高优先未完成（${high.length}）`}>
            {high.length === 0 ? (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有高优先级待办，干得漂亮" />
            ) : high.map(t => (
              <div key={t.id} style={{
                display: 'flex', alignItems: 'center', gap: 8, padding: '8px 0',
                borderBottom: '1px solid rgba(128,128,128,.08)',
              }}>
                <Tag color="red">{PRIORITY_LABEL[t.priority]}</Tag>
                <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.text}</span>
                <span style={{ fontSize: 12, opacity: 0.5 }}>{t.date}</span>
              </div>
            ))}
          </Card>
        </Col>

        <Col xs={24}>
          <Card size="small" title="需求状态明细">
            {reqs.length === 0 ? (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无需求" />
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column' }}>
                {reqs.map(r => (
                  <div key={r.id} style={{
                    display: 'flex', alignItems: 'center', gap: 8, padding: '8px 0',
                    borderBottom: '1px solid rgba(128,128,128,.08)',
                  }}>
                    <span style={{ width: 8, height: 8, borderRadius: '50%', background: PRIORITY_COLOR[r.priority] || '#f59e0b', flexShrink: 0 }} />
                    <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.title}</span>
                    <Tag color={REQ_STATUS_COLOR[r.status]}>{REQ_STATUS_LABEL[r.status]}</Tag>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </Col>
      </Row>
    </PageContainer>
  );
}
