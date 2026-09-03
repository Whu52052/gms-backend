// 数据分析（移植 OpsApp.renderDataAnalysis）：
// 任务完成统计 / 需求状态分布 / 每日任务趋势(近7天) / 优先级分布，数据来自 ops_tasks / ops_requirements
import { useMemo } from 'react';
import { Card, Col, Row } from 'antd';
import ReactECharts from 'echarts-for-react';
import { PageContainer } from '@common/components/PageContainer';
import { useUIStore } from '@common/stores/ui';
import { loadRequirements, loadTasks } from '../common/opsLocalData';

export default function DataAnalysisPage() {
  const dark = useUIStore(s => s.theme === 'dark');
  const { tasks, reqs } = useMemo(() => ({ tasks: loadTasks(), reqs: loadRequirements() }), []);

  const done = tasks.filter(t => t.done).length;
  const pending = tasks.filter(t => !t.done).length;

  // 近7天任务趋势（任务 date 存为 zh-CN 本地日期字符串）
  const days: string[] = [];
  const dayKeys: string[] = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    days.push(d.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' }));
    dayKeys.push(d.toLocaleDateString('zh-CN'));
  }
  const dailyData = dayKeys.map(key => tasks.filter(t => t.date === key).length);

  const barOption = (title: string, labels: string[], data: number[], color: string) => ({
    title: { text: title, textStyle: { fontSize: 13 } },
    grid: { top: 36, left: 36, right: 16, bottom: 24 },
    xAxis: { type: 'category', data: labels },
    yAxis: { type: 'value', minInterval: 1 },
    series: [{ type: 'bar', data, itemStyle: { color, borderRadius: [4, 4, 0, 0] }, barMaxWidth: 40 }],
    tooltip: { trigger: 'axis' },
  });

  const lineOption = {
    title: { text: '每日任务趋势 (近7天)', textStyle: { fontSize: 13 } },
    grid: { top: 36, left: 36, right: 16, bottom: 24 },
    xAxis: { type: 'category', data: days },
    yAxis: { type: 'value', minInterval: 1 },
    series: [{ type: 'line', data: dailyData, itemStyle: { color: dark ? '#fafafa' : '#0a0a0a' }, smooth: true }],
    tooltip: { trigger: 'axis' },
  };

  return (
    <PageContainer title="📊 数据分析">
      <Row gutter={[16, 16]}>
        <Col xs={24} lg={12}>
          <Card size="small">
            <ReactECharts style={{ height: 260 }} option={barOption('任务完成统计', ['已完成', '待完成'], [done, pending], '#10b981')} />
          </Card>
        </Col>
        <Col xs={24} lg={12}>
          <Card size="small">
            <ReactECharts style={{ height: 260 }} option={barOption('需求状态分布', ['待处理', '已通过', '已拒绝'], [
              reqs.filter(r => r.status === 'pending').length,
              reqs.filter(r => r.status === 'approved').length,
              reqs.filter(r => r.status === 'rejected').length,
            ], '#f59e0b')} />
          </Card>
        </Col>
        <Col xs={24} lg={12}>
          <Card size="small">
            <ReactECharts style={{ height: 260 }} option={lineOption} />
          </Card>
        </Col>
        <Col xs={24} lg={12}>
          <Card size="small">
            <ReactECharts style={{ height: 260 }} option={barOption('优先级分布', ['高', '中', '低'], [
              tasks.filter(t => t.priority === 'high').length,
              tasks.filter(t => t.priority === 'medium').length,
              tasks.filter(t => t.priority === 'low').length,
            ], '#8b5cf6')} />
          </Card>
        </Col>
      </Row>
    </PageContainer>
  );
}
