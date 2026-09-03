/**
 * src/handlers/chat.js
 * 实时聊天/帮助中心
 *
 * 端点：
 *   POST /api/chat/send                → 发送消息
 *   GET  /api/chat/history?withUserId=X → 获取与某用户的聊天记录
 */
'use strict';

const crypto = require('crypto');

module.exports = function createChatHandlers(deps) {
  const { pool, sendJSON, broadcastSSE, _cached } = deps;

  // ============================================================
  // Handlers
  // ============================================================

  // 发送消息
  async function handleSendMessage(req, res, authUser, body) {
    const { recipientId, recipientName, message } = body || {};
    if (!recipientId || !message) {
      return sendJSON(res, { error: '缺少 recipientId 或 message' }, 400);
    }

    const id = 'chat-' + Date.now() + '-' + crypto.randomBytes(4).toString('hex');
    const createdAt = new Date().toISOString();

    await pool.execute(
      'INSERT INTO chat_messages (id, sender_id, sender_name, recipient_id, recipient_name, message, created_at) VALUES (?,?,?,?,?,?,?)',
      [id, authUser.userId, authUser.displayName || authUser.username, recipientId, recipientName, message.trim(), createdAt]
    );

    const msg = {
      id,
      senderId: authUser.userId,
      senderName: authUser.displayName || authUser.username,
      recipientId,
      recipientName,
      message: message.trim(),
      createdAt,
    };

    // 实时推送
    broadcastSSE('chat:message', msg);

    sendJSON(res, { success: true, msg });
  }

  // 获取聊天历史
  async function handleGetHistory(req, res, authUser) {
    const q = new URL(req.url, 'http://localhost').searchParams;
    const withUserId = q.get('withUserId');
    if (!withUserId) {
      return sendJSON(res, { error: '缺少 withUserId 参数' }, 400);
    }

    // 两人之间的所有消息
    const [rows] = await pool.execute(
      `SELECT id, sender_id, sender_name, recipient_id, recipient_name, message, created_at
       FROM chat_messages
       WHERE (sender_id = ? AND recipient_id = ?)
          OR (sender_id = ? AND recipient_id = ?)
       ORDER BY created_at ASC
       LIMIT 200`,
      [authUser.userId, withUserId, withUserId, authUser.userId]
    );

    const messages = rows.map(r => ({
      id: r.id,
      senderId: r.sender_id,
      senderName: r.sender_name,
      recipientId: r.recipient_id,
      recipientName: r.recipient_name,
      message: r.message,
      createdAt: r.created_at,
    }));

    sendJSON(res, messages);
  }

  // 获取当前用户未读的聊天消息 (最近的消息)
  async function handleGetUnread(req, res, authUser) {
    const [rows] = await pool.execute(
      `SELECT id, sender_id, sender_name, recipient_id, recipient_name, message, created_at
       FROM chat_messages
       WHERE recipient_id = ?
       ORDER BY created_at DESC
       LIMIT 50`,
      [authUser.userId]
    );

    const messages = rows.map(r => ({
      id: r.id,
      senderId: r.sender_id,
      senderName: r.sender_name,
      recipientId: r.recipient_id,
      recipientName: r.recipient_name,
      message: r.message,
      createdAt: r.created_at,
    }));

    sendJSON(res, messages);
  }

  // 获取当前用户的所有会话列表（按对方分组，含最后一条消息和未读计数）
  async function handleGetConversations(req, res, authUser) {
    const [rows] = await pool.execute(
      `SELECT id, sender_id, sender_name, recipient_id, recipient_name, message, created_at, read_at
       FROM chat_messages
       WHERE sender_id = ? OR recipient_id = ?
       ORDER BY created_at DESC`,
      [authUser.userId, authUser.userId]
    );

    const convMap = {};
    rows.forEach(r => {
      // 确定对方的信息
      const otherId = r.sender_id === authUser.userId ? r.recipient_id : r.sender_id;
      const otherName = r.sender_id === authUser.userId ? r.recipient_name : r.sender_name;
      if (!convMap[otherId]) {
        convMap[otherId] = { userId: otherId, userName: otherName, lastMessage: '', lastTime: '', unread: 0 };
      }
      // 第一条是最近的消息（DESC排序）
      if (!convMap[otherId].lastMessage) {
        convMap[otherId].lastMessage = r.message;
        convMap[otherId].lastTime = r.created_at;
      }
      // 未读：对方发送给我，且 read_at IS NULL
      if (r.recipient_id === authUser.userId && !r.read_at) {
        convMap[otherId].unread++;
      }
    });

    const conversations = Object.values(convMap).sort((a, b) => (b.lastTime||'').localeCompare(a.lastTime||''));
    sendJSON(res, conversations);
  }

  // 标记某用户的聊天为已读
  async function handleMarkRead(req, res, authUser, body) {
    const { userId } = body || {};
    if (!userId) {
      return sendJSON(res, { error: '缺少 userId 参数' }, 400);
    }
    const now = new Date().toISOString();
    await pool.execute(
      `UPDATE chat_messages SET read_at = ?
       WHERE sender_id = ? AND recipient_id = ? AND read_at IS NULL`,
      [now, userId, authUser.userId]
    );
    sendJSON(res, { success: true });
  }

  // 获取客服信息（任何用户都可调用）
  async function handleGetHelpdesk(req, res, authUser) {
    const [rows] = await pool.execute(
      'SELECT id, username, displayName FROM users WHERE username = ? LIMIT 1',
      ['Wuzhenyu']
    );
    if (rows.length === 0) {
      return sendJSON(res, { error: '未找到客服' }, 404);
    }
    sendJSON(res, {
      id: rows[0].id,
      username: rows[0].username,
      displayName: rows[0].displayName || rows[0].username,
    });
  }

  return {
    handleSendMessage,
    handleGetHistory,
    handleGetUnread,
    handleGetConversations,
    handleMarkRead,
    handleGetHelpdesk,
  };
};