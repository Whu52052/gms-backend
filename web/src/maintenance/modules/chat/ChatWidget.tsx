// 在线客服挂件（移植 index.html 内联 Chat Widget）：仅 Wuzhenyu 可见，
// 会话列表/聊天记录/发送，SSE chat:message 实时推送
import { useCallback, useEffect, useRef, useState } from 'react';
import { Badge, Button, Empty, Flex, Input, Spin } from 'antd';
import { MessageOutlined } from '@ant-design/icons';
import { useAuthStore } from '@common/stores/auth';
import * as api from '@common/api';

function formatChatTime(iso?: string): string {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    const now = new Date();
    const hm = d.toTimeString().slice(0, 5);
    if (d.toDateString() === now.toDateString()) return hm;
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    if (d.toDateString() === yesterday.toDateString()) return `昨天 ${hm}`;
    return `${d.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' })} ${hm}`;
  } catch { return iso; }
}

export function ChatWidget() {
  const user = useAuthStore(s => s.user);
  const isWuzhenyu = (user?.username || '').toLowerCase() === 'wuzhenyu';

  const [shown, setShown] = useState(false);       // 面板展开
  const [badge, setBadge] = useState(0);           // 未读角标
  const [convs, setConvs] = useState<any[]>([]);
  const [loadingConvs, setLoadingConvs] = useState(false);
  const [conv, setConv] = useState<{ userId: string; userName: string } | null>(null);
  const [msgs, setMsgs] = useState<any[]>([]);
  const [loadingMsgs, setLoadingMsgs] = useState(false);
  const [input, setInput] = useState('');
  const listRef = useRef<HTMLDivElement>(null);

  const myId = user ? String((user as any).userId || user.id || '') : '';

  const loadConversations = useCallback(async () => {
    setLoadingConvs(true);
    try {
      const list = (await api.getChatConversations()) || [];
      setConvs(list);
      const totalUnread = list.reduce((s, c) => s + (c.unread || 0), 0);
      setBadge(totalUnread);
    } catch { /* ignore */ }
    setLoadingConvs(false);
  }, []);

  const loadHistory = useCallback(async (userId: string) => {
    setLoadingMsgs(true);
    try {
      setMsgs((await api.getChatHistory(userId)) || []);
    } catch { setMsgs([]); }
    setLoadingMsgs(false);
  }, []);

  // 初始化：加载会话 + 监听 SSE chat:message
  useEffect(() => {
    if (!isWuzhenyu) return;
    loadConversations();
    const onMsg = (e: Event) => {
      const msg = (e as CustomEvent).detail;
      if (!msg || !myId || msg.recipientId !== myId) return;
      loadConversations();
      setConv(current => {
        if (current && current.userId === msg.senderId) {
          setMsgs(prev => [...prev, msg]);
        }
        return current;
      });
    };
    window.addEventListener('gms_event:chat:message', onMsg);
    return () => window.removeEventListener('gms_event:chat:message', onMsg);
  }, [isWuzhenyu, myId, loadConversations]);

  // 消息到达后滚动到底部
  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [msgs]);

  if (!isWuzhenyu) return null;

  const toggle = () => {
    const next = !shown;
    setShown(next);
    if (next) { setBadge(0); loadConversations(); }
  };

  const openConv = (userId: string, userName: string) => {
    setConv({ userId, userName });
    api.markChatRead(userId).catch(() => {});
    loadConversations();
    loadHistory(userId);
  };

  const backToList = () => {
    setConv(null);
    loadConversations();
  };

  const send = async () => {
    if (!conv) return;
    const text = input.trim();
    if (!text) return;
    const r: any = await api.sendChatMessage(conv.userId, conv.userName, text);
    if (r && r.success === false) return;
    setInput('');
    setMsgs(prev => [...prev, { senderId: myId, message: text, createdAt: new Date().toISOString() }]);
  };

  return (
    <div style={{ position: 'fixed', bottom: 24, right: 24, zIndex: 10000 }}>
      {shown && (
        <div style={{
          width: 340, height: 460, marginBottom: 12, borderRadius: 12, overflow: 'hidden',
          background: '#fff', color: '#1a1a1a', boxShadow: '0 8px 32px rgba(0,0,0,.25)',
          display: 'flex', flexDirection: 'column',
        }}>
          {/* 头部 */}
          <Flex justify="space-between" align="center" style={{
            padding: '10px 14px', background: '#0a0a0a', color: '#fff',
          }}>
            <strong>{conv ? `与 ${conv.userName} 的对话` : '在线客服'}</strong>
            <span>
              {conv && (
                <span style={{ cursor: 'pointer', fontSize: 18, marginRight: 10 }} onClick={backToList}>←</span>
              )}
              <span style={{ cursor: 'pointer', fontSize: 16 }} onClick={toggle}>✕</span>
            </span>
          </Flex>

          {/* 内容区 */}
          {!conv ? (
            <div style={{ flex: 1, overflowY: 'auto', padding: 8 }}>
              {loadingConvs && <div style={{ textAlign: 'center', padding: 20 }}><Spin /></div>}
              {!loadingConvs && convs.length === 0 && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无消息" />}
              {convs.map(c => (
                <Flex key={c.userId} gap={10} align="center" onClick={() => openConv(c.userId, c.userName || '未知')}
                  style={{ padding: '10px 8px', borderRadius: 8, cursor: 'pointer' }}
                  className="chat-conv-hover">
                  <div style={{
                    width: 36, height: 36, borderRadius: '50%', background: '#0a0a0a', color: '#fff',
                    display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                  }}>{(c.userName || '?')[0]}</div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 600, fontSize: 13 }}>{c.userName || '未知'}</div>
                    <div style={{
                      fontSize: 12, color: '#888', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                    }}>{c.lastMessage || ''}</div>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <div style={{ fontSize: 11, color: '#aaa' }}>{formatChatTime(c.lastTime)}</div>
                    {(c.unread || 0) > 0 && <Badge count={c.unread > 99 ? '99+' : c.unread} />}
                  </div>
                </Flex>
              ))}
            </div>
          ) : (
            <>
              <div ref={listRef} style={{ flex: 1, overflowY: 'auto', padding: 12, background: '#f5f6fa' }}>
                {loadingMsgs && <div style={{ textAlign: 'center', padding: 20 }}><Spin /></div>}
                {!loadingMsgs && msgs.length === 0 && (
                  <div style={{ textAlign: 'center', color: '#999', padding: 20 }}>暂无聊天记录</div>
                )}
                {msgs.map((m, i) => {
                  const mine = String(m.senderId) === myId;
                  return (
                    <div key={i} style={{ display: 'flex', justifyContent: mine ? 'flex-end' : 'flex-start', marginBottom: 10 }}>
                      <div style={{
                        maxWidth: '75%', padding: '8px 12px', borderRadius: 12, fontSize: 13,
                        background: mine ? '#0a0a0a' : '#fff', color: mine ? '#fff' : '#1a1a1a',
                        boxShadow: '0 1px 3px rgba(0,0,0,.08)',
                      }}>
                        <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{m.message}</div>
                        <div style={{ fontSize: 10, opacity: 0.6, marginTop: 2 }}>{formatChatTime(m.createdAt)}</div>
                      </div>
                    </div>
                  );
                })}
              </div>
              <Flex gap={6} style={{ padding: 10, borderTop: '1px solid #eee' }}>
                <Input size="small" placeholder="输入消息..." value={input}
                  onChange={e => setInput(e.target.value)}
                  onPressEnter={send} />
                <Button size="small" type="primary" onClick={send}>发送</Button>
              </Flex>
            </>
          )}
        </div>
      )}
      <Badge count={shown ? 0 : badge} offset={[-4, 4]}>
        <Button
          shape="circle" size="large" icon={<MessageOutlined />}
          onClick={toggle}
          style={{
            width: 52, height: 52, fontSize: 22,
            background: '#0a0a0a', color: '#fff', border: 'none',
            boxShadow: '0 4px 16px rgba(0,0,0,.25)',
          }}
        />
      </Badge>
    </div>
  );
}
