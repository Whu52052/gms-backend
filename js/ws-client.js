/**
 * ===================================================================
 *  Yunwei WebSocket Client — 微信级实时通信前端模块
 *
 *  功能:
 *    - 自动连接 WebSocket (带指数退避重连)
 *    - 实时接收服务端推送 (无延迟)
 *    - 连接状态管理 (connecting/connected/disconnected)
 *    - 事件分发 (注册回调处理特定事件)
 *    - 离线自动切换到 SSE 备用通道
 *    - Toast 通知 + 声音提醒
 * ===================================================================
 */

const WSClient = {
  // 状态
  _ws: null,
  _status: 'disconnected',  // connecting | connected | disconnected
  _reconnectTimer: null,
  _reconnectAttempts: 0,
  _maxReconnectDelay: 30000,
  _baseDelay: 1000,

  // 事件回调
  _handlers: {},

  // 心跳
  _pingInterval: null,
  _lastPong: 0,

  // ==================== INIT ====================
  /**
   * 初始化 WebSocket 连接
   * @param {string} token 登录 token
   */
  connect(token) {
    if (!token || this._ws?.readyState === WebSocket.OPEN) return;

    this._status = 'connecting';
    this._updateStatusDot();

    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${location.host}/ws`;

    try {
      this._ws = new WebSocket(wsUrl);
    } catch (e) {
      console.warn('[WS] WebSocket not available, using SSE fallback');
      this._status = 'disconnected';
      return;
    }

    this._ws.onopen = () => {
      console.log('[WS] ✅ 已连接');
      this._status = 'connected';
      this._reconnectAttempts = 0;
      this._updateStatusDot();

      // 鉴权
      this._send({ type: 'auth', token });

      // 心跳
      this._startPing();
    };

    this._ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        this._handleMessage(msg);
      } catch {}
    };

    this._ws.onclose = (event) => {
      console.warn(`[WS] 断开 (code: ${event.code})`);
      this._status = 'disconnected';
      this._updateStatusDot();
      this._stopPing();
      this._scheduleReconnect(token);
    };

    this._ws.onerror = () => {
      // onclose 会紧随其后触发
    };
  },

  /** 断开连接 */
  disconnect() {
    this._clearReconnect();
    this._stopPing();
    if (this._ws) {
      this._ws.onclose = null;  // 防止触发重连
      this._ws.close();
      this._ws = null;
    }
    this._status = 'disconnected';
    this._updateStatusDot();
  },

  // ==================== EVENT HANDLING ====================
  /**
   * 注册事件处理器
   * @param {string} event 事件类型 (如 'tech:new_request')
   * @param {Function} handler 回调函数
   */
  on(event, handler) {
    if (!this._handlers[event]) this._handlers[event] = [];
    this._handlers[event].push(handler);
  },

  /** 移除事件处理器 */
  off(event, handler) {
    if (!this._handlers[event]) return;
    this._handlers[event] = this._handlers[event].filter(h => h !== handler);
  },

  /** 发送消息到服务端 */
  send(type, data) {
    this._send({ type, ...data });
  },

  // ==================== INTERNAL ====================
  _send(data) {
    if (this._ws?.readyState === WebSocket.OPEN) {
      try { this._ws.send(JSON.stringify(data)); } catch {}
    }
  },

  _handleMessage(msg) {
    const { type, data, messages } = msg;

    // 鉴权确认
    if (type === 'auth_ok') {
      console.log('[WS] ✅ 已认证:', msg.user?.username);
      // 订阅感兴趣的实时事件
      this._send({ type: 'subscribe', events: [
        'tech:new_request', 'tech:responded', 'tech:completed',
        'data:changed', 'user:online', 'user:offline',
      ]});
      this._emit('connected', msg);
      return;
    }

    if (type === 'error') {
      console.error('[WS] 错误:', msg.code, msg.message);
      return;
    }

    // 离线消息批量投递
    if (type === 'offline:messages' && messages) {
      messages.forEach(m => this._handleMessage(m));
      return;
    }

    // 心跳
    if (type === 'pong') {
      this._lastPong = Date.now();
      return;
    }

    // 🔔 新维修请求 — 运维立即看到 (声音+通知)
    if (type === 'tech:new_request') {
      this._playNotificationSound();
      this._showToast('🔔 新维修请求', `${data.submitterName} 提交了 ${data.faultType}`, 'info');
      this._emit('tech:new_request', data);
    }

    // 🔔 已响应 — 运营提交人立即看到
    if (type === 'tech:responded') {
      this._playNotificationSound();
      this._showToast('🔧 已有响应', `${data.responderName} 开始处理`, 'success');
      this._emit('tech:responded', data);
    }

    // 🔔 维修完成 — 运营提交人立即看到
    if (type === 'tech:completed') {
      this._playNotificationSound();
      this._showToast('✅ 维修完成', data.result || '设备已恢复正常', 'success');
      this._emit('tech:completed', data);
    }

    // 数据变更
    if (type === 'data:changed') {
      this._emit('data:changed', data);
    }

    // 用户上线/下线
    if (type === 'user:online' || type === 'user:offline') {
      this._emit(type, data);
    }

    // 通用事件
    this._emit(type, data);
  },

  _emit(event, data) {
    const handlers = this._handlers[event] || [];
    handlers.forEach(h => {
      try { h(data); } catch {}
    });
    // 也触发通配符 '*'
    (this._handlers['*'] || []).forEach(h => {
      try { h(event, data); } catch {}
    });
  },

  // ==================== RECONNECT ====================
  _scheduleReconnect(token) {
    if (this._reconnectTimer) return;
    const delay = Math.min(
      this._baseDelay * Math.pow(2, this._reconnectAttempts),
      this._maxReconnectDelay
    );
    this._reconnectAttempts++;
    console.log(`[WS] ${delay}ms 后重连 (第 ${this._reconnectAttempts} 次)`);
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this.connect(token);
    }, delay);
  },

  _clearReconnect() {
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
  },

  // ==================== PING ====================
  _startPing() {
    this._stopPing();
    this._lastPong = Date.now();
    this._pingInterval = setInterval(() => {
      if (this._ws?.readyState === WebSocket.OPEN) {
        this._send({ type: 'ping' });
      }
      // 超过 45 秒没 pong → 断开重连
      if (Date.now() - this._lastPong > 45000) {
        console.warn('[WS] 心跳超时, 断开重连');
        this._ws?.close();
      }
    }, 10000);
  },

  _stopPing() {
    if (this._pingInterval) {
      clearInterval(this._pingInterval);
      this._pingInterval = null;
    }
  },

  // ==================== UI HELPER ====================
  _updateStatusDot() {
    const dot = document.getElementById('ws-status-dot');
    if (dot) {
      dot.className = 'ws-status-dot ' + this._status;
      dot.title = {
        connecting: '实时连接中...',
        connected: '实时已连接',
        disconnected: '实时未连接',
      }[this._status] || '';
    }
  },

  /** 播放通知声音 */
  _playNotificationSound() {
    try {
      // 使用 Web Audio API 生成简短提示音 (无需外部文件)
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.frequency.value = 880;
      osc.type = 'sine';
      gain.gain.value = 0.1;
      gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.3);
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + 0.3);
    } catch {}
  },

  /** 显示 Toast 通知 */
  _showToast(title, body, type) {
    // 检查浏览器 Notification API
    if (Notification.permission === 'granted' && document.hidden) {
      new Notification(title, { body, icon: '/favicon.ico' });
    }

    // 触发自定义事件 (由 app.js / operations.js 处理)
    window.dispatchEvent(new CustomEvent('yunwei:toast', {
      detail: { title, body, type },
    }));
  },
};

// ==================== SSE FALLBACK ====================
/**
 * 如果浏览器不支持 WebSocket, 自动切换到 SSE
 */
const SSEFallback = {
  _es: null,
  _handlers: {},

  connect(token) {
    const url = `${location.protocol}//${location.host}/api/events`;
    this._es = new EventSource(url);

    this._es.onopen = () => console.log('[SSE] 已连接');
    this._es.onerror = () => {
      console.warn('[SSE] 错误, 将自动重连');
    };

    // 监听所有 SSE 事件
    const events = [
      'tech:new_request', 'tech:responded', 'tech:completed',
      'data:changed', 'user:online', 'user:offline',
      'inventory_updated', 'machines_updated', 'tech_support_updated',
      'transactions_updated', 'users_updated', 'sn_registry_updated',
    ];
    events.forEach(event => {
      this._es.addEventListener(event, (e) => {
        try {
          const data = JSON.parse(e.data);
          (this._handlers[event] || []).forEach(h => h(data));
        } catch {}
      });
    });
  },

  on(event, handler) {
    if (!this._handlers[event]) this._handlers[event] = [];
    this._handlers[event].push(handler);
  },

  disconnect() {
    if (this._es) { this._es.close(); this._es = null; }
  },
};

// ==================== UNIFIED API ====================
/**
 * 智能通道选择: WebSocket 优先, SSE 备用
 * 外部统一使用 Realtime.on(event, handler)
 */
const Realtime = {
  _token: null,
  _connected: false,

  /** 启动实时连接 */
  init(token) {
    if (!token) return;
    this._token = token;

    // 检测 WebSocket 支持
    if (typeof WebSocket !== 'undefined') {
      WSClient.connect(token);
      WSClient.on('connected', () => { this._connected = true; });
    } else {
      // 降级到 SSE
      console.warn('[Realtime] WebSocket 不可用, 使用 SSE');
      SSEFallback.connect(token);
    }
  },

  /** 注册事件监听 (自动路由到 WS 或 SSE) */
  on(event, handler) {
    if (typeof WebSocket !== 'undefined') {
      WSClient.on(event, handler);
    }
    // SSE 也注册 (双保险)
    SSEFallback.on(event, handler);
  },

  /** 断开 */
  disconnect() {
    WSClient.disconnect();
    SSEFallback.disconnect();
    this._connected = false;
  },

  /** 获取连接状态 */
  isConnected() {
    return WSClient._status === 'connected' || this._connected;
  },

  /** 请求桌面通知权限 */
  requestNotificationPermission() {
    if (Notification.permission === 'default') {
      Notification.requestPermission();
    }
  },
};

// 导出给全局
window.Realtime = Realtime;
window.WSClient = WSClient;
