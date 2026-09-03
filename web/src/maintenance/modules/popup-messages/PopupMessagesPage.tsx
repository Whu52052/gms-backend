// 弹窗句子管理页（移植 js/ui/popup-messages.js）：提交后/维修完成鼓励语管理
import { useState } from 'react';
import { Button, Card, Col, Empty, Flex, Input, List, Popconfirm, Row, Tag, message } from 'antd';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { PageContainer } from '@common/components/PageContainer';
import { useAuthStore, isAdmin } from '@common/stores/auth';
import * as api from '@common/api';

function CategoryPanel({ category, title, placeholder }: { category: string; title: string; placeholder: string }) {
  const qc = useQueryClient();
  const [text, setText] = useState('');
  const { data: msgs = [] } = useQuery({
    queryKey: ['popup-messages', category],
    queryFn: () => api.getPopupMessages(category).catch(() => []),
  });

  const doAdd = async () => {
    const t = text.trim();
    if (!t) { message.warning('请输入句子内容'); return; }
    try {
      const result: any = await api.addPopupMessage(category, t);
      if (result && result.success === false) {
        message.error(result.error || result.message || '添加失败');
        return;
      }
      message.success('句子已添加');
      setText('');
      qc.invalidateQueries({ queryKey: ['popup-messages', category] });
    } catch (e: any) {
      message.error(e?.message || '添加失败');
    }
  };

  const doDelete = async (id: string | number) => {
    try {
      const result: any = await api.deletePopupMessage(id);
      if (result && result.success === false) {
        message.error(result.error || result.message || '删除失败');
        return;
      }
      message.success('句子已删除');
      qc.invalidateQueries({ queryKey: ['popup-messages', category] });
    } catch (e: any) {
      message.error(e?.message || '删除失败');
    }
  };

  return (
    <Card size="small" title={<>{title} <Tag>{msgs.length}条</Tag></>}>
      <Flex gap={8} style={{ marginBottom: 12 }}>
        <Input placeholder={placeholder} value={text} onChange={e => setText(e.target.value)}
          onPressEnter={doAdd} />
        <Button type="primary" onClick={doAdd}>添加</Button>
      </Flex>
      {msgs.length === 0 ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无句子" />
      ) : (
        <List
          size="small"
          dataSource={msgs}
          renderItem={(m: any) => (
            <List.Item
              actions={[
                <Popconfirm key="del" title="确认删除此句子？" onConfirm={() => doDelete(m.id)} okText="删除" cancelText="取消">
                  <Button size="small" danger type="text">✕</Button>
                </Popconfirm>,
              ]}
            >
              {m.text}
            </List.Item>
          )}
        />
      )}
    </Card>
  );
}

export default function PopupMessagesPage() {
  const user = useAuthStore(s => s.user);
  if (!isAdmin(user)) {
    return <PageContainer title="弹窗句子管理"><Empty description="无权限访问" /></PageContainer>;
  }
  return (
    <PageContainer title="💬 弹窗句子管理" subtitle="管理提交成功和维修完成后的鼓励性消息">
      <Row gutter={[16, 16]}>
        <Col xs={24} lg={12}>
          <CategoryPanel category="submit" title="提交后弹窗句子" placeholder="输入新的提交后鼓励语..." />
        </Col>
        <Col xs={24} lg={12}>
          <CategoryPanel category="complete" title="维修完成弹窗句子" placeholder="输入新的维修完成鼓励语..." />
        </Col>
      </Row>
    </PageContainer>
  );
}
