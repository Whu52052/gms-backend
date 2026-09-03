/**
 * src/handlers/push.js
 * Web Push 通知处理模块
 *
 * 端点：
 *   GET  /api/vapid-public-key  → 返回VAPID公钥（前端订阅推送用）
 *   POST /api/push/subscribe     → 保存用户的推送订阅
 *   POST /api/push/unsubscribe    → 取消推送订阅
 *   POST /api/push/test           → 发送测试通知（管理员）
 *
 * 依赖：web-push npm 包
 */
'use strict';

module.exports = function createPushHandlers(deps) {
  const { pool, redisClient, sendJSON, broadcastSSE } = deps;

  // 初始化 web-push
  let webpush = null;
  let vapidKeys = null;

  function initWebPush() {
    if (webpush) return true;
    try {
      webpush = require('web-push');
      vapidKeys = {
        publicKey: process.env.VAPID_PUBLIC_KEY,
        privateKey: process.env.VAPID_PRIVATE_KEY,
        subject: process.env.VAPID_SUBJECT || 'mailto:admin@gms-system.com',
      };
      if (!vapidKeys.publicKey || !vapidKeys.privateKey) {
        console.warn('[Push] VAPID keys not configured in .env');
        return false;
      }
      webpush.setVapidDetails(
        vapidKeys.subject,
        vapidKeys.publicKey,
        vapidKeys.privateKey
      );
      console.log('[Push] web-push initialized with VAPID keys');
      return true;
    } catch (e) {
      console.error('[Push] Failed to init web-push:', e.message);
      return false;
    }
  }

  // ============== GET /api/vapid-public-key ==============
  async function handleGetVapidPublicKey(req, res) {
    if (!initWebPush()) {
      return sendJSON(res, { error: '推送服务未配置' }, 503);
    }
    sendJSON(res, { publicKey: vapidKeys.publicKey });
  }

  // ============== POST /api/push/subscribe ==============
  async function handlePushSubscribe(req, res, user, body) {
    if (!initWebPush()) {
      return sendJSON(res, { error: '推送服务未配置' }, 503);
    }
    const { endpoint, keys } = body || {};
    if (!endpoint || !keys || !keys.p256dh || !keys.auth) {
      return sendJSON(res, { error: '无效的订阅数据' }, 400);
    }

    try {
      // 存储到 Redis（按用户ID分组）
      if (redisClient) {
        const subKey = `push:sub:${user.userId}`;
        await redisClient.hSet(subKey, {
          endpoint,
          p256dh: keys.p256dh,
          auth: keys.auth,
          createdAt: Date.now().toString(),
        });
        // 添加到用户集合
        await redisClient.sAdd('push:users', user.userId);
      }

      // 也存到数据库（持久化）
      if (pool) {
        try {
          await pool.execute(
            `INSERT INTO push_subscriptions (userId, endpoint, p256dh, auth, createdAt)
             VALUES (?, ?, ?, ?, NOW())
             ON DUPLICATE KEY UPDATE p256dh=VALUES(p256dh), auth=VALUES(auth), updatedAt=NOW()`,
            [user.userId, endpoint, keys.p256dh, keys.auth]
          );
        } catch (dbErr) {
          // 表可能不存在，忽略
          console.warn('[Push] DB insert skipped:', dbErr.message);
        }
      }

      console.log(`[Push] User ${user.userId} subscribed: ${endpoint.slice(0, 50)}...`);
      sendJSON(res, { success: true, message: '推送订阅成功' });
    } catch (e) {
      console.error('[Push] Subscribe error:', e.message);
      sendJSON(res, { error: '订阅失败' }, 500);
    }
  }

  // ============== POST /api/push/unsubscribe ==============
  async function handlePushUnsubscribe(req, res, user, body) {
    try {
      if (redisClient) {
        const subKey = `push:sub:${user.userId}`;
        await redisClient.del(subKey);
        await redisClient.sRem('push:users', user.userId);
      }
      sendJSON(res, { success: true, message: '已取消推送订阅' });
    } catch (e) {
      sendJSON(res, { error: '取消订阅失败' }, 500);
    }
  }

  // ============== POST /api/push/test ==============
  async function handlePushTest(req, res, user, body) {
    if (!initWebPush()) {
      return sendJSON(res, { error: '推送服务未配置' }, 503);
    }
    if (user.role !== 'admin' && user.role !== 'superadmin') {
      return sendJSON(res, { error: '无权限' }, 403);
    }

    const targetUserId = body?.userId || user.userId;
    const payload = JSON.stringify({
      title: '🔔 GMS 测试通知',
      body: `这是来自 GMS 系统的测试推送通知\n发送时间：${new Date().toLocaleString('zh-CN')}`,
      icon: '/icons/icon-192.png',
      tag: 'gms-test',
      url: '/',
    });

    try {
      const result = await sendPushToUser(targetUserId, payload);
      if (result.sent > 0) {
        sendJSON(res, { success: true, sent: result.sent, message: '测试通知已发送' });
      } else {
        sendJSON(res, { success: false, message: '该用户未订阅推送通知' });
      }
    } catch (e) {
      console.error('[Push] Test send error:', e.message);
      sendJSON(res, { error: `发送失败: ${e.message}` }, 500);
    }
  }

  // ============== 发送推送给指定用户 ==============
  async function sendPushToUser(userId, payload) {
    let sent = 0;
    let failed = 0;

    if (!redisClient) return { sent, failed };

    const subKey = `push:sub:${userId}`;
    const sub = await redisClient.hGetAll(subKey);
    if (!sub || !sub.endpoint) return { sent, failed };

    const subscription = {
      endpoint: sub.endpoint,
      keys: { p256dh: sub.p256dh, auth: sub.auth },
    };

    try {
      await webpush.sendNotification(subscription, payload);
      sent++;
    } catch (e) {
      failed++;
      // 410 Gone = 订阅已失效，清理
      if (e.statusCode === 410 || e.statusCode === 404) {
        await redisClient.del(subKey);
        await redisClient.sRem('push:users', userId);
        console.log(`[Push] Cleaned stale subscription for user ${userId}`);
      } else {
        console.error('[Push] Send failed:', e.message);
      }
    }

    return { sent, failed };
  }

  // ============== 广播推送给所有用户 ==============
  async function broadcastPush(payload) {
    if (!initWebPush() || !redisClient) return { sent: 0, failed: 0 };

    const userIds = await redisClient.sMembers('push:users');
    let totalSent = 0;
    let totalFailed = 0;

    for (const userId of userIds) {
      const result = await sendPushToUser(userId, payload);
      totalSent += result.sent;
      totalFailed += result.failed;
    }

    console.log(`[Push] Broadcast: ${totalSent} sent, ${totalFailed} failed`);
    return { sent: totalSent, failed: totalFailed };
  }

  return {
    handleGetVapidPublicKey,
    handlePushSubscribe,
    handlePushUnsubscribe,
    handlePushTest,
    sendPushToUser,
    broadcastPush,
    initWebPush,
  };
};
