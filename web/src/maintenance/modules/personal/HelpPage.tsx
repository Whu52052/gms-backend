// 帮助中心页（移植 js/ui/personal-center.js renderHelp）：FAQ + 快速指南 + 联系方式
import { useMemo, useState } from 'react';
import { Button, Card, Col, Collapse, Empty, Input, Row } from 'antd';
import { useNavigate } from 'react-router-dom';
import { PageContainer } from '@common/components/PageContainer';
import { useAuthStore } from '@common/stores/auth';

const FAQS = [
  { q: '如何重置密码？', a: '点击右上角用户头像 → 修改密码。管理员可在"用户管理"中为下属重置密码。' },
  { q: '如何绑定机器编码？', a: '在"机器管理"页面点击"添加机器"，选择或输入机器编码（J 代表左手，K 代表右手），然后绑定手套。' },
  { q: '手套状态如何流转？', a: '库存 → 投入使用 → 使用中；使用中 → 退回库存；使用中 → 报修损坏 → 已损坏；已损坏 → 发货维修 → 售后中 → 维修完成 → 库存。' },
  { q: '为什么不能同时绑定两只左手手套？', a: '系统规则：每台机器在使用状态下仅允许同时关联一只左手和一只右手手套。请解绑后再绑定新手套。' },
  { q: '数据如何保存？', a: '所有数据保存在服务器数据库中，浏览器通过实时通道（SSE）自动同步最新数据，无需手动刷新。' },
  { q: '如何导出报表？', a: '进入"报表统计"页面，选择时间范围后点击"导出CSV"或"打印"。' },
  { q: '什么是 CSRF 保护？', a: '系统已启用双重 Cookie 防护（Double-Submit Cookie），所有写操作需携带 CSRF Token。Token 自动注入，无需手动处理。' },
];

export default function HelpPage() {
  const navigate = useNavigate();
  const user = useAuthStore(s => s.user);
  const [search, setSearch] = useState('');

  const faqs = useMemo(() => {
    const kw = search.trim().toLowerCase();
    if (!kw) return FAQS;
    return FAQS.filter(f => f.q.toLowerCase().includes(kw) || f.a.toLowerCase().includes(kw));
  }, [search]);

  const openBugReport = () => {
    const body = encodeURIComponent(
      `【GMS 问题反馈】\n\n用户名：${user?.username || ''}\n系统：${user?.system || 'maintenance'}\n` +
      `时间：${new Date().toLocaleString('zh-CN')}\n浏览器：${navigator.userAgent}\n\n问题描述：\n`,
    );
    window.location.href = `mailto:support@gms-system.com?subject=GMS问题反馈&body=${body}`;
  };

  const guides = [
    { label: '🖥️ 机器管理入门', path: '/machines' },
    { label: '📦 库存盘点流程', path: '/inventory/glove' },
    { label: '📋 查看流水记录', path: '/transactions' },
    { label: '🔧 提交技术支持', path: '/tech-support' },
    { label: '📈 生成绩效报表', path: '/reports' },
  ];

  return (
    <PageContainer title="💡 帮助中心" subtitle="常见问题、操作指南与联系方式">
      <Row gutter={[16, 16]}>
        <Col xs={24} lg={14}>
          <Card size="small" title="📖 常见问题 FAQ">
            <Input placeholder="搜索问题..." allowClear value={search}
              onChange={e => setSearch(e.target.value)} style={{ marginBottom: 12 }} />
            {faqs.length === 0 ? (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="未找到相关问题" />
            ) : (
              <Collapse
                accordion
                items={faqs.map((f, i) => ({
                  key: String(i),
                  label: <span>Q：{f.q}</span>,
                  children: <div style={{ opacity: 0.8 }}>{f.a}</div>,
                }))}
              />
            )}
          </Card>
        </Col>
        <Col xs={24} lg={10}>
          <Card size="small" title="📚 快速指南" style={{ marginBottom: 16 }}>
            {guides.map(g => (
              <Button key={g.path} type="link" block style={{ textAlign: 'left', padding: '4px 0' }}
                onClick={() => navigate(g.path)}>
                {g.label}
              </Button>
            ))}
          </Card>
          <Card size="small" title="📞 联系我们">
            <div style={{ lineHeight: 2, fontSize: 13 }}>
              <div>📧 <strong>邮箱</strong>：support@gms-system.com</div>
              <div>📞 <strong>电话</strong>：400-888-8888（工作日 9:00 - 18:00）</div>
              <div>💬 <strong>在线支持</strong>：进入「技术支持」页面提交工单</div>
            </div>
            <div style={{
              marginTop: 12, padding: 12, borderRadius: 8, fontSize: 12, opacity: 0.7,
              background: 'rgba(128,128,128,.08)',
            }}>
              提交反馈时请附上：问题发生时间 · 操作步骤 · 截图或错误信息 · 浏览器与系统版本
            </div>
            <Button type="primary" block style={{ marginTop: 12 }} onClick={openBugReport}>
              🐛 报告一个问题
            </Button>
          </Card>
        </Col>
      </Row>
    </PageContainer>
  );
}
