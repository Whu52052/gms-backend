// 消息中心页（移植 js/ui/personal-center.js renderNotifications）：本地通知列表
import { useState } from 'react';
import { Button, Card, Empty, Flex, List, Space, Tag, message, theme } from 'antd';
import { PageContainer } from '@common/components/PageContainer';
import { getNotifications, saveNotifications } from '@common/api';
import { relativeTime } from '@common/utils/format';

const TYPE_META: Record<string, { icon: string; color: string; label: string }> = {
  system: { icon: '⚙️', color: 'purple', label: '系统' },
  info: { icon: 'ℹ️', color: 'blue', label: '通知' },
  success: { icon: '✅', color: 'green', label: '成功' },
  warning: { icon: '⚠️', color: 'orange', label: '警告' },
  error: { icon: '❌', color: 'red', label: '错误' },
};

// 首次进入时种子通知（移植 _seedNotifsIfEmpty）
function seedIfEmpty(list: any[]): any[] {
  if (list.length > 0) return list;
  const now = Date.now();
  const seed = [
    { id: 'seed-1', type: 'system', title: '欢迎使用 GMS 企业版', body: '感谢您使用 glove-management-system。如有任何问题，请前往"帮助中心"查看 FAQ。', time: now - 6 * 3600 * 1000, read: false },
    { id: 'seed-2', type: 'info', title: '新功能上线：个人中心', body: '现在您可以在右上角头像处进入「个人中心」，管理账号、通知与查看个人操作记录。', time: now - 2 * 3600 * 1000, read: false },
    { id: 'seed-3', type: 'warning', title: '建议启用强密码', body: '为了您的账号安全，建议定期修改密码并启用更强的密码策略。', time: now - 30 * 60 * 1000, read: false },
  ];
  saveNotifications(seed);
  return seed;
}

export default function NotificationsPage() {
  const { token } = theme.useToken();
  const [list, setList] = useState(() => seedIfEmpty(getNotifications()));
  const unread = list.filter(n => !n.read).length;

  const persist = (next: any[]) => {
    saveNotifications(next);
    setList([...next]);
  };

  const markRead = (id: string) => persist(list.map(n => (n.id === id ? { ...n, read: true } : n)));
  const markAllRead = () => { persist(list.map(n => ({ ...n, read: true }))); message.success('已将所有通知标记为已读'); };
  const clearAll = () => { persist([]); message.success('通知已清空'); };
  const removeOne = (id: string) => persist(list.filter(n => n.id !== id));

  return (
    <PageContainer
      title="🔔 消息中心"
      subtitle={unread > 0 ? `${unread} 条未读通知` : '所有通知均已读'}
      extra={
        <Space>
          <Button onClick={markAllRead} disabled={unread === 0}>全部标记已读</Button>
          <Button danger onClick={clearAll} disabled={list.length === 0}>清空</Button>
        </Space>
      }
    >
      {list.length === 0 ? (
        <Card size="small"><Empty description="暂无通知" /></Card>
      ) : (
        <List
          dataSource={list}
          renderItem={(n: any) => {
            const meta = TYPE_META[n.type] || TYPE_META.info;
            const time = n.time || (n.createdAt ? new Date(n.createdAt).getTime() : 0);
            return (
              <Card size="small" style={{
                marginBottom: 12,
                borderLeft: n.read ? undefined : `4px solid ${token.colorText}`,
                opacity: n.read ? 0.75 : 1,
              }}>
                <Flex gap={12} align="start">
                  <div style={{
                    width: 44, height: 44, borderRadius: 8, fontSize: 20, flexShrink: 0,
                    display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(128,128,128,.1)',
                  }}>{meta.icon}</div>
                  <div style={{ flex: 1 }}>
                    <Flex gap={8} align="center" style={{ marginBottom: 4 }}>
                      <strong>{n.title}</strong>
                      <Tag color={meta.color}>{meta.label}</Tag>
                      {!n.read && <Tag color="processing">NEW</Tag>}
                    </Flex>
                    <div style={{ fontSize: 13, opacity: 0.75 }}>{n.body}</div>
                    <div style={{ fontSize: 12, opacity: 0.45, marginTop: 6 }}>{time ? relativeTime(new Date(time).toISOString()) : ''}</div>
                  </div>
                  <Space>
                    {!n.read && <Button size="small" onClick={() => markRead(n.id)}>标记已读</Button>}
                    <Button size="small" type="text" danger onClick={() => removeOne(n.id)}>删除</Button>
                  </Space>
                </Flex>
              </Card>
            );
          }}
        />
      )}
    </PageContainer>
  );
}
