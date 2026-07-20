/**
 * ===================================================================
 *  开发者后台 (DevConsole) — 前端逻辑
 *
 *  功能:
 *    - 系统概览 (process/memory/cpu/network/sessions)
 *    - 数据库监控 (pool/table sizes)
 *    - Redis 监控 (INFO + key stats)
 *    - 在线会话
 *    - 缓存管理 (static + redis)
 *    - 日志查看 (app/audit/crash/dev)
 *    - 表结构查看
 *    - 版本管理 (bump version.json)
 *    - 快速操作 (clear cache / restart / etc.)
 *
 *  权限: 仅 superadmin 可访问
 * ===================================================================
 */

const DevApp = {
  currentTab: 'overview',
  autoRefresh: true,
  refreshTimer: null,
  refreshInterval: 5000,
  healthTimer: null,
  currentUser: null,
  token: null,
  baseURL: '',
  // Cache for trends
  _prevStats: null,
  _logState: { type: 'app', lines: 200, search: '' },
  _versionCache: null,

  // ==================== INIT ====================
  async init() {
    // Restore theme
    const savedTheme = localStorage.getItem('gms_theme') || 'dark';
    document.documentElement.setAttribute('data-theme', savedTheme);

    // Restore auto-refresh setting
    const savedAuto = localStorage.getItem('dev_auto_refresh');
    if (savedAuto === 'false') this.autoRefresh = false;

    // Load token
    this.token = localStorage.getItem('gms_token') || sessionStorage.getItem('gms_token');
    this.currentUser = JSON.parse(localStorage.getItem('gms_user') || sessionStorage.getItem('gms_user') || 'null');
    this.baseURL = window.__GMS_SERVER_URL__ || window.location.origin;

    // Setup sidebar navigation
    document.querySelectorAll('.dev-sidebar .nav-item[data-tab]').forEach(btn => {
      btn.addEventListener('click', () => this.switchTab(btn.dataset.tab));
    });

    // Theme toggle
    document.getElementById('theme-toggle').addEventListener('click', () => this.toggleTheme());

    // Auto-refresh toggle
    const arBtn = document.getElementById('auto-refresh-toggle');
    arBtn.addEventListener('click', () => this.toggleAutoRefresh());
    this._updateAutoRefreshBtn();

    // Modal close handlers
    document.getElementById('modal-close').addEventListener('click', () => this.closeModal());
    document.getElementById('modal-close-btn').addEventListener('click', () => this.closeModal());
    document.getElementById('modal-overlay').addEventListener('click', (e) => {
      if (e.target.id === 'modal-overlay') this.closeModal();
    });

    // Check server health first
    const online = await this._checkServer();
    if (!online) {
      this.renderLogin('无法连接到服务器，请检查网络后重试');
      return;
    }

    // If we have a token, validate it
    if (this.token) {
      const valid = await this._validateToken();
      if (valid) {
        // Verify superadmin
        if (this.currentUser?.role !== 'superadmin') {
          this.renderAccessDenied();
          return;
        }
        this.enterConsole();
        return;
      }
    }
    this.renderLogin();
  },

  async _checkServer() {
    try {
      const res = await this._fetchWithTimeout(this.baseURL + '/api/health', {}, 5000);
      return res.ok;
    } catch { return false; }
  },

  async _validateToken() {
    try {
      const res = await this._fetchWithTimeout(this.baseURL + '/api/settings', {
        headers: { 'Authorization': 'Bearer ' + this.token }
      }, 3000);
      if (!res.ok) return false;
      // Refresh user info from server
      const userRes = await this._fetchWithTimeout(this.baseURL + '/api/online-users', {
        headers: { 'Authorization': 'Bearer ' + this.token }
      }, 3000);
      if (userRes.ok) {
        // If we can fetch admin endpoint, role is OK — but we still rely on stored role
        return true;
      }
      return false;
    } catch { return false; }
  },

  async _fetchWithTimeout(url, options = {}, timeout = 8000) {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeout);
    try {
      const res = await fetch(url, { ...options, signal: controller.signal });
      clearTimeout(id);
      return res;
    } catch (e) {
      clearTimeout(id);
      throw e;
    }
  },

  // ==================== LOGIN ====================
  renderLogin(errorMsg = '') {
    document.body.classList.remove('logged-in');
    document.querySelector('.dev-sidebar').style.display = 'none';
    document.querySelector('.dev-topbar').style.display = 'none';

    const html = `
      <div class="dev-login">
        <div class="dev-login-card">
          <div class="dev-login-icon">⚡</div>
          <div class="dev-login-title">DEVCONSOLE</div>
          <div class="dev-login-subtitle">开发者后台 · 仅超级管理员</div>
          ${errorMsg ? `<div class="dev-login-error">${this._esc(errorMsg)}</div>` : '<div class="dev-login-error"></div>'}
          <div class="dev-form-group">
            <label>用户名</label>
            <input type="text" id="dev-username" placeholder="输入超级管理员用户名" autocomplete="username" autofocus>
          </div>
          <div class="dev-form-group">
            <label>密码</label>
            <input type="password" id="dev-password" placeholder="输入密码" autocomplete="current-password">
          </div>
          <button class="dev-login-btn" id="dev-login-btn" onclick="DevApp.doLogin()">登 录</button>
          <div class="dev-login-info">
            ⚠ 该后台为开发者工具，提供系统监控、缓存管理、日志查看、版本控制等高级功能。<br>
            所有操作均会记录到 audit-dev.log。
          </div>
        </div>
      </div>
    `;
    document.getElementById('main-content').innerHTML = html;

    // Enter key to login
    const pwEl = document.getElementById('dev-password');
    if (pwEl) pwEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') this.doLogin(); });
    const unEl = document.getElementById('dev-username');
    if (unEl) unEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') document.getElementById('dev-password').focus(); });
  },

  async doLogin() {
    const username = document.getElementById('dev-username')?.value.trim();
    const password = document.getElementById('dev-password')?.value.trim();
    const errorEl = document.querySelector('.dev-login-error');
    if (!username || !password) {
      if (errorEl) errorEl.textContent = '请输入用户名和密码';
      return;
    }
    const btn = document.getElementById('dev-login-btn');
    if (btn) { btn.disabled = true; btn.textContent = '登录中...'; }
    try {
      const res = await this._fetchWithTimeout(this.baseURL + '/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      }, 8000);
      const data = await res.json();
      if (!res.ok || data.error) {
        if (errorEl) errorEl.textContent = data.error || '登录失败';
        if (btn) { btn.disabled = false; btn.textContent = '登 录'; }
        return;
      }
      // Check role
      if (data.user.role !== 'superadmin') {
        if (errorEl) errorEl.textContent = '访问被拒绝：仅超级管理员可进入开发者后台';
        if (btn) { btn.disabled = false; btn.textContent = '登 录'; }
        return;
      }
      // Save credentials
      this.token = data.token;
      this.currentUser = data.user;
      localStorage.setItem('gms_token', this.token);
      localStorage.setItem('gms_user', JSON.stringify(this.currentUser));
      // Enter console
      this.enterConsole();
    } catch (e) {
      if (errorEl) errorEl.textContent = '网络错误: ' + e.message;
      if (btn) { btn.disabled = false; btn.textContent = '登 录'; }
    }
  },

  renderAccessDenied() {
    document.body.classList.remove('logged-in');
    document.querySelector('.dev-sidebar').style.display = 'none';
    document.querySelector('.dev-topbar').style.display = 'none';
    document.getElementById('main-content').innerHTML = `
      <div class="dev-access-denied">
        <div class="dev-access-denied-card">
          <div class="dev-access-denied-icon">⛔</div>
          <div class="dev-access-denied-title">ACCESS DENIED</div>
          <div class="dev-access-denied-msg">
            当前账户 (${this._esc(this.currentUser?.username || 'unknown')}) 无权访问开发者后台。<br>
            仅 <strong style="color:var(--dev-accent)">超级管理员</strong> 可进入。
          </div>
          <button class="dev-login-btn" onclick="DevApp.logout()">切换账户</button>
        </div>
      </div>
    `;
  },

  logout() {
    localStorage.removeItem('gms_token');
    localStorage.removeItem('gms_user');
    sessionStorage.removeItem('gms_token');
    sessionStorage.removeItem('gms_user');
    this.token = null;
    this.currentUser = null;
    window.location.reload();
  },

  enterConsole() {
    document.body.classList.add('logged-in');
    document.querySelector('.dev-sidebar').style.display = '';
    document.querySelector('.dev-topbar').style.display = '';
    // Render user chip
    document.getElementById('topbar-user').textContent = '⚡ ' + (this.currentUser?.username || '?');
    // Initial render
    this.switchTab(this.currentTab);
    this.startHealthCheck();
    if (this.autoRefresh) this.startAutoRefresh();
    // Try to load version info for sidebar tag
    this._loadVersionTag();
  },

  // ==================== TABS ====================
  switchTab(tab) {
    this.currentTab = tab;
    // Update nav
    document.querySelectorAll('.dev-sidebar .nav-item[data-tab]').forEach(b => {
      b.classList.toggle('active', b.dataset.tab === tab);
    });
    // Update title
    const names = {
      overview: '系统概览', database: '数据库', redis: 'Redis',
      sessions: '在线会话', cache: '缓存管理', logs: '日志查看',
      tables: '表结构', version: '版本管理', actions: '快速操作',
    };
    document.getElementById('dev-section-name').textContent = names[tab] || tab;
    // Render
    this.renderTab(tab);
  },

  renderTab(tab) {
    switch (tab) {
      case 'overview': this.renderOverview(); break;
      case 'database': this.renderDatabase(); break;
      case 'redis': this.renderRedis(); break;
      case 'sessions': this.renderSessions(); break;
      case 'cache': this.renderCache(); break;
      case 'logs': this.renderLogs(); break;
      case 'tables': this.renderTables(); break;
      case 'version': this.renderVersion(); break;
      case 'actions': this.renderActions(); break;
    }
  },

  refresh() {
    this.renderTab(this.currentTab);
  },

  // ==================== AUTO REFRESH ====================
  toggleAutoRefresh() {
    this.autoRefresh = !this.autoRefresh;
    localStorage.setItem('dev_auto_refresh', this.autoRefresh);
    this._updateAutoRefreshBtn();
    if (this.autoRefresh) this.startAutoRefresh();
    else this.stopAutoRefresh();
    this.notify(this.autoRefresh ? '自动刷新已开启' : '自动刷新已关闭', 'info');
  },

  _updateAutoRefreshBtn() {
    const btn = document.getElementById('auto-refresh-toggle');
    if (!btn) return;
    btn.textContent = '⏱ 自动刷新: ' + (this.autoRefresh ? '开' : '关');
    btn.classList.toggle('active', this.autoRefresh);
  },

  startAutoRefresh() {
    this.stopAutoRefresh();
    this.refreshTimer = setInterval(() => {
      // Only refresh if document is visible and current tab is data-driven
      if (document.visibilityState === 'visible') {
        const autoTabs = ['overview', 'database', 'redis', 'sessions', 'cache'];
        if (autoTabs.includes(this.currentTab)) this.renderTab(this.currentTab);
      }
    }, this.refreshInterval);
  },

  stopAutoRefresh() {
    if (this.refreshTimer) { clearInterval(this.refreshTimer); this.refreshTimer = null; }
  },

  startHealthCheck() {
    const check = async () => {
      const dot = document.getElementById('health-dot');
      try {
        const res = await this._fetchWithTimeout(this.baseURL + '/api/health', {}, 3000);
        if (res.ok) {
          dot.classList.remove('offline');
          dot.classList.add('online');
          dot.title = '服务器在线';
        } else { throw new Error(); }
      } catch {
        dot.classList.remove('online');
        dot.classList.add('offline');
        dot.title = '服务器离线';
      }
    };
    check();
    this.healthTimer = setInterval(check, 10000);
  },

  // ==================== THEME ====================
  toggleTheme() {
    const current = document.documentElement.getAttribute('data-theme') || 'dark';
    const next = current === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem('gms_theme', next);
  },

  // ==================== API WRAPPER ====================
  async api(path, options = {}) {
    const res = await this._fetchWithTimeout(this.baseURL + path, {
      ...options,
      headers: {
        'Authorization': 'Bearer ' + this.token,
        'Content-Type': 'application/json',
        ...(options.headers || {}),
      },
    }, 12000);
    if (res.status === 401) {
      this.notify('登录已过期，请重新登录', 'error');
      setTimeout(() => this.logout(), 1500);
      throw new Error('Unauthorized');
    }
    if (res.status === 403) {
      this.notify('权限不足', 'error');
      throw new Error('Forbidden');
    }
    return res.json();
  },

  // ==================== OVERVIEW TAB ====================
  async renderOverview() {
    document.getElementById('main-content').innerHTML = `
      <div class="dev-section-header">
        <div class="dev-section-title">📊 系统概览 <span class="num">/ overview</span></div>
        <div class="dev-section-actions">
          <span class="dev-badge info" id="overview-timestamp">--</span>
        </div>
      </div>
      <div class="dev-content-loading"><span class="dev-loading"></span> 加载中...</div>
    `;
    try {
      const d = await this.api('/api/dev/overview');
      this._prevStats = d;
      const memPct = parseFloat(d.memory.heapUtilization);
      const heapPctColor = memPct > 80 ? 'danger' : memPct > 60 ? 'warn' : '';
      const loadPct = (d.cpu.loadAvg1 / d.cpu.cores * 100).toFixed(0);
      const loadColor = loadPct > 80 ? 'danger' : loadPct > 60 ? 'warn' : '';
      const osMemPct = ((d.os.totalMem - d.os.freeMem) / d.os.totalMem * 100).toFixed(1);
      const sessions = d.sessions;
      const html = `
        <div class="dev-section-header">
          <div class="dev-section-title">📊 系统概览 <span class="num">/ overview</span></div>
          <div class="dev-section-actions">
            <span class="dev-badge info" title="${d.timestamp}">${this._formatTime(d.timestamp)}</span>
          </div>
        </div>

        <div class="dev-grid dev-grid-4" style="margin-bottom:18px;">
          <div class="dev-stat">
            <div class="dev-stat-label">⏱ 进程运行时长</div>
            <div class="dev-stat-value accent">${d.process.uptimeHuman}</div>
            <div class="dev-stat-sub">PID ${d.process.pid} ${d.process.pm_id ? '· PM2 #' + d.process.pm_id : '· standalone'}</div>
          </div>
          <div class="dev-stat">
            <div class="dev-stat-label">⚡ 在线会话</div>
            <div class="dev-stat-value accent-2">${sessions.total}</div>
            <div class="dev-stat-sub">
              运维 ${sessions.bySystem.maintenance || 0} · 运营 ${sessions.bySystem.operations || 0}
            </div>
          </div>
          <div class="dev-stat">
            <div class="dev-stat-label">💾 堆内存</div>
            <div class="dev-stat-value ${heapPctColor}">${d.memory.heapUsedHuman}</div>
            <div class="dev-stat-sub">/ ${d.memory.heapTotalHuman} · ${memPct}%</div>
            <div class="dev-progress"><div class="dev-progress-fill ${heapPctColor}" style="width:${memPct}%"></div></div>
          </div>
          <div class="dev-stat">
            <div class="dev-stat-label">🖥 系统负载</div>
            <div class="dev-stat-value ${loadColor}">${d.cpu.loadAvg1.toFixed(2)}</div>
            <div class="dev-stat-sub">${d.cpu.cores} 核 · ${loadPct}%</div>
            <div class="dev-progress"><div class="dev-progress-fill ${loadColor}" style="width:${Math.min(100, loadPct)}%"></div></div>
          </div>
        </div>

        <div class="dev-grid dev-grid-3" style="margin-bottom:18px;">
          <div class="dev-card">
            <div class="dev-card-header">
              <div class="dev-card-title"><span class="icon">🧠</span> 内存详情</div>
            </div>
            <div class="dev-kv">
              <div class="k">RSS</div><div class="v">${d.memory.rssHuman}</div>
              <div class="k">Heap Used</div><div class="v accent">${d.memory.heapUsedHuman}</div>
              <div class="k">Heap Total</div><div class="v">${d.memory.heapTotalHuman}</div>
              <div class="k">External</div><div class="v">${d.memory.externalHuman}</div>
              <div class="k">ArrayBuffers</div><div class="v">${this._formatBytes(d.memory.arrayBuffers)}</div>
              <div class="k">堆利用率</div><div class="v ${heapPctColor === 'danger' ? 'danger' : 'accent'}">${memPct}%</div>
            </div>
            <div class="dev-divider"></div>
            <div class="dev-kv">
              <div class="k">系统总内存</div><div class="v">${d.os.totalMemHuman}</div>
              <div class="k">系统空闲</div><div class="v">${d.os.freeMemHuman}</div>
              <div class="k">系统使用率</div><div class="v warn">${osMemPct}%</div>
            </div>
          </div>

          <div class="dev-card">
            <div class="dev-card-header">
              <div class="dev-card-title"><span class="icon">⚙️</span> 进程信息</div>
            </div>
            <div class="dev-kv">
              <div class="k">Node 版本</div><div class="v accent-2">${d.process.nodeVersion}</div>
              <div class="k">平台</div><div class="v">${d.process.platform}</div>
              <div class="k">PID</div><div class="v">${d.process.pid}</div>
              <div class="k">PPID</div><div class="v">${d.process.ppid}</div>
              <div class="k">主机名</div><div class="v">${d.os.hostname}</div>
              <div class="k">OS</div><div class="v">${d.os.type} ${d.os.release}</div>
              <div class="k">OS 运行</div><div class="v">${d.os.uptimeHuman}</div>
            </div>
            <div class="dev-divider"></div>
            <div class="dev-kv">
              <div class="k">CPU 型号</div><div class="v" style="font-size:0.74rem">${d.cpu.model}</div>
              <div class="k">CPU 核心</div><div class="v accent">${d.cpu.cores} cores</div>
              <div class="k">Load Avg</div><div class="v" style="font-size:0.74rem">${d.cpu.loadAvg1.toFixed(2)} / ${d.cpu.loadAvg5.toFixed(2)} / ${d.cpu.loadAvg15.toFixed(2)}</div>
            </div>
          </div>

          <div class="dev-card">
            <div class="dev-card-header">
              <div class="dev-card-title"><span class="icon">🌐</span> 环境与网络</div>
            </div>
            <div class="dev-kv">
              <div class="k">端口</div><div class="v accent-2">${d.environment.PORT}</div>
              <div class="k">数据库</div><div class="v">${d.environment.DB_HOST} / ${d.environment.DB_NAME}</div>
              <div class="k">Redis</div>
              <div class="v ${d.environment.REDIS_AVAILABLE ? 'accent' : 'danger'}">
                ${d.environment.REDIS_AVAILABLE ? '✓ 在线' : '✗ 离线'}
              </div>
              <div class="k">NODE_ENV</div><div class="v">${d.environment.NODE_ENV}</div>
              <div class="k">LOG_LEVEL</div><div class="v">${d.environment.LOG_LEVEL}</div>
              <div class="k">版本</div><div class="v accent">${d.version}</div>
            </div>
            <div class="dev-divider"></div>
            <div class="dev-kv">
              <div class="k">网络接口</div>
              <div class="v" style="font-size:0.74rem">
                ${d.network.map(n => `${n.iface}: ${n.ipv4}`).join('<br>')}
              </div>
            </div>
          </div>
        </div>

        <div class="dev-grid dev-grid-4">
          <div class="dev-card">
            <div class="dev-card-header">
              <div class="dev-card-title"><span class="icon">📦</span> 静态缓存</div>
              <div class="dev-card-actions">
                <button onclick="DevApp.switchTab('cache')">查看</button>
              </div>
            </div>
            <div class="dev-kv">
              <div class="k">条目数</div><div class="v accent">${d.staticCache.entries}</div>
              <div class="k">占用</div><div class="v">${d.staticCache.sizeHuman}</div>
            </div>
          </div>

          <div class="dev-card">
            <div class="dev-card-header">
              <div class="dev-card-title"><span class="icon">⚠️</span> 崩溃记录</div>
              <div class="dev-card-actions">
                <button onclick="DevApp.viewCrashLog()">查看</button>
              </div>
            </div>
            <div class="dev-kv">
              <div class="k">崩溃次数</div>
              <div class="v ${d.crashLog.count > 0 ? 'danger' : 'accent'}">${d.crashLog.count}</div>
              <div class="k">最近崩溃</div>
              <div class="v" style="font-size:0.74rem">${d.crashLog.lastCrash ? this._formatTime(d.crashLog.lastCrash) : '无'}</div>
            </div>
          </div>

          <div class="dev-card">
            <div class="dev-card-header">
              <div class="dev-card-title"><span class="icon">👥</span> 会话分布</div>
              <div class="dev-card-actions">
                <button onclick="DevApp.switchTab('sessions')">详情</button>
              </div>
            </div>
            <div class="dev-kv">
              <div class="k">运维系统</div><div class="v accent">${sessions.bySystem.maintenance || 0}</div>
              <div class="k">运营系统</div><div class="v accent-2">${sessions.bySystem.operations || 0}</div>
              <div class="k">超级管理员</div><div class="v warn">${sessions.byRole.superadmin || 0}</div>
              <div class="k">普通管理员</div><div class="v">${sessions.byRole.admin || 0}</div>
            </div>
          </div>

          <div class="dev-card">
            <div class="dev-card-header">
              <div class="dev-card-title"><span class="icon">🚀</span> 快速操作</div>
              <div class="dev-card-actions">
                <button onclick="DevApp.switchTab('actions')">更多</button>
              </div>
            </div>
            <div style="display:flex;flex-direction:column;gap:6px;">
              <button class="btn btn-outline" onclick="DevApp.clearCache('static')" style="text-align:left;">🧹 清理静态缓存</button>
              <button class="btn btn-outline" onclick="DevApp.clearCache('redis')" style="text-align:left;">⚡ 清理 Redis 缓存</button>
              <button class="btn btn-outline" onclick="DevApp.viewLog('app')" style="text-align:left;">📄 查看应用日志</button>
            </div>
          </div>
        </div>
      `;
      document.getElementById('main-content').innerHTML = html;
      // Update topbar uptime
      const upEl = document.getElementById('dev-uptime');
      if (upEl) upEl.textContent = '⏱ ' + d.process.uptimeHuman;
    } catch (e) {
      document.getElementById('main-content').innerHTML = `<div class="dev-empty">加载失败: ${this._esc(e.message)}</div>`;
    }
  },

  // ==================== DATABASE TAB ====================
  async renderDatabase() {
    document.getElementById('main-content').innerHTML = `
      <div class="dev-section-header">
        <div class="dev-section-title">🗄️ 数据库监控 <span class="num">/ database</span></div>
      </div>
      <div class="dev-content-loading"><span class="dev-loading"></span> 加载中...</div>
    `;
    try {
      const d = await this.api('/api/dev/db-stats');
      const poolUtil = d.pool.connectionLimit ? (d.pool.activeConnections / d.pool.connectionLimit * 100).toFixed(1) : 0;
      const poolColor = poolUtil > 80 ? 'danger' : poolUtil > 60 ? 'warn' : '';
      const html = `
        <div class="dev-section-header">
          <div class="dev-section-title">🗄️ 数据库监控 <span class="num">/ database</span></div>
          <div class="dev-section-actions">
            <span class="dev-badge info">${this._esc(d.database)} @ ${this._esc(d.host)}</span>
            <span class="dev-badge purple">总大小 ${d.totalSizeHuman}</span>
          </div>
        </div>

        <div class="dev-grid dev-grid-4" style="margin-bottom:18px;">
          <div class="dev-stat">
            <div class="dev-stat-label">活跃连接</div>
            <div class="dev-stat-value accent-2 ${poolColor}">${d.pool.activeConnections}</div>
            <div class="dev-stat-sub">/ ${d.pool.connectionLimit} limit · ${poolUtil}%</div>
            <div class="dev-progress"><div class="dev-progress-fill ${poolColor}" style="width:${poolUtil}%"></div></div>
          </div>
          <div class="dev-stat">
            <div class="dev-stat-label">空闲连接</div>
            <div class="dev-stat-value accent">${d.pool.idleConnections}</div>
            <div class="dev-stat-sub">总连接 ${d.pool.totalConnections}</div>
          </div>
          <div class="dev-stat">
            <div class="dev-stat-label">排队请求</div>
            <div class="dev-stat-value ${d.pool.queuedRequests > 0 ? 'warm' : ''}">${d.pool.queuedRequests}</div>
            <div class="dev-stat-sub">${d.pool.queuedRequests > 0 ? '⚠ 有请求排队' : '无排队'}</div>
          </div>
          <div class="dev-stat">
            <div class="dev-stat-label">表数量</div>
            <div class="dev-stat-value accent">${d.tables.length}</div>
            <div class="dev-stat-sub">总占用 ${d.totalSizeHuman}</div>
          </div>
        </div>

        <div class="dev-card">
          <div class="dev-card-header">
            <div class="dev-card-title"><span class="icon">📋</span> 表清单 (${d.tables.length})</div>
            <div class="dev-card-actions">
              <button onclick="DevApp.switchTab('tables')">查看表结构</button>
            </div>
          </div>
          <div class="dev-table-wrap">
            <table class="dev-table">
              <thead>
                <tr>
                  <th>表名</th>
                  <th>引擎</th>
                  <th class="num">行数</th>
                  <th class="num">数据大小</th>
                  <th class="num">索引大小</th>
                  <th class="num">空闲空间</th>
                  <th>Auto Increment</th>
                  <th>更新时间</th>
                </tr>
              </thead>
              <tbody>
                ${d.tables.map(t => `
                  <tr>
                    <td class="mono">${this._esc(t.name)}</td>
                    <td><span class="dev-badge muted">${t.engine}</span></td>
                    <td class="num">${t.rows.toLocaleString()}</td>
                    <td class="num">${t.dataHuman}</td>
                    <td class="num">${t.indexHuman}</td>
                    <td class="num">${t.freeHuman}</td>
                    <td>${t.autoIncrement ? t.autoIncrement.toLocaleString() : '-'}</td>
                    <td style="font-size:0.74rem;color:var(--dev-text-dim)">${t.updatedAt ? this._formatTime(t.updatedAt) : '-'}</td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>
        </div>
      `;
      document.getElementById('main-content').innerHTML = html;
    } catch (e) {
      document.getElementById('main-content').innerHTML = `<div class="dev-empty">加载失败: ${this._esc(e.message)}</div>`;
    }
  },

  // ==================== REDIS TAB ====================
  async renderRedis() {
    document.getElementById('main-content').innerHTML = `
      <div class="dev-section-header">
        <div class="dev-section-title">⚡ Redis 监控 <span class="num">/ redis</span></div>
      </div>
      <div class="dev-content-loading"><span class="dev-loading"></span> 加载中...</div>
    `;
    try {
      const d = await this.api('/api/dev/redis-stats');
      if (!d.available) {
        document.getElementById('main-content').innerHTML = `
          <div class="dev-section-header">
            <div class="dev-section-title">⚡ Redis 监控 <span class="num">/ redis</span></div>
          </div>
          <div class="dev-card" style="text-align:center;padding:60px 20px;">
            <div style="font-size:3rem;margin-bottom:12px;">🔌</div>
            <div style="font-family:var(--dev-mono);color:var(--dev-text-dim);font-size:0.9rem;">
              Redis 未连接或未配置
            </div>
            <div style="font-family:var(--dev-mono);color:var(--dev-text-mute);font-size:0.78rem;margin-top:8px;">
              ${d.error ? this._esc(d.error) : (d.message || '服务器未启用 Redis 支持')}
            </div>
          </div>
        `;
        return;
      }
      const hitRate = d.stats.hitRate;
      const memPct = d.memory.max ? (d.memory.used / d.memory.max * 100).toFixed(1) : null;
      const html = `
        <div class="dev-section-header">
          <div class="dev-section-title">⚡ Redis 监控 <span class="num">/ redis</span></div>
          <div class="dev-section-actions">
            <span class="dev-badge online">● ONLINE</span>
            <span class="dev-badge info">${d.server.version} · ${d.server.mode}</span>
            <span class="dev-badge muted">uptime ${d.server.uptimeHuman}</span>
          </div>
        </div>

        <div class="dev-grid dev-grid-4" style="margin-bottom:18px;">
          <div class="dev-stat">
            <div class="dev-stat-label">已连接客户端</div>
            <div class="dev-stat-value accent-2">${d.clients.connected}</div>
            <div class="dev-stat-sub">阻塞 ${d.clients.blocked}</div>
          </div>
          <div class="dev-stat">
            <div class="dev-stat-label">内存使用</div>
            <div class="dev-stat-value accent">${d.memory.usedHuman}</div>
            <div class="dev-stat-sub">峰值 ${d.memory.peakHuman} ${memPct ? '· ' + memPct + '%' : ''}</div>
            ${memPct ? `<div class="dev-progress"><div class="dev-progress-fill ${memPct > 80 ? 'danger' : memPct > 60 ? 'warn' : ''}" style="width:${memPct}%"></div></div>` : ''}
          </div>
          <div class="dev-stat">
            <div class="dev-stat-label">缓存命中率</div>
            <div class="dev-stat-value accent">${hitRate}</div>
            <div class="dev-stat-sub">命中 ${d.stats.keyspaceHits.toLocaleString()} · 未命中 ${d.stats.keyspaceMisses.toLocaleString()}</div>
          </div>
          <div class="dev-stat">
            <div class="dev-stat-label">实时 OPS</div>
            <div class="dev-stat-value warm">${d.stats.opsPerSec}</div>
            <div class="dev-stat-sub">总命令 ${d.stats.totalCommands.toLocaleString()}</div>
          </div>
        </div>

        <div class="dev-grid dev-grid-3" style="margin-bottom:18px;">
          <div class="dev-card">
            <div class="dev-card-header">
              <div class="dev-card-title"><span class="icon">🖥</span> 服务器</div>
            </div>
            <div class="dev-kv">
              <div class="k">Redis 版本</div><div class="v accent-2">${d.server.version}</div>
              <div class="k">模式</div><div class="v">${d.server.mode}</div>
              <div class="k">OS</div><div class="v" style="font-size:0.74rem">${d.server.os}</div>
              <div class="k">运行时长</div><div class="v accent">${d.server.uptimeHuman}</div>
            </div>
          </div>

          <div class="dev-card">
            <div class="dev-card-header">
              <div class="dev-card-title"><span class="icon">💾</span> 内存</div>
            </div>
            <div class="dev-kv">
              <div class="k">已用</div><div class="v accent">${d.memory.usedHuman}</div>
              <div class="k">峰值</div><div class="v warn">${d.memory.peakHuman}</div>
              <div class="k">最大限制</div><div class="v">${d.memory.maxHuman}</div>
              <div class="k">碎片率</div><div class="v">${d.memory.fragmentationRatio}</div>
              <div class="k">分配器</div><div class="v" style="font-size:0.74rem">${d.memory.allocator || '-'}</div>
            </div>
          </div>

          <div class="dev-card">
            <div class="dev-card-header">
              <div class="dev-card-title"><span class="icon">📊</span> 统计</div>
            </div>
            <div class="dev-kv">
              <div class="k">总连接数</div><div class="v">${d.stats.totalConnections.toLocaleString()}</div>
              <div class="k">总命令数</div><div class="v">${d.stats.totalCommands.toLocaleString()}</div>
              <div class="k">拒绝连接</div>
              <div class="v ${d.stats.rejectedConnections > 0 ? 'danger' : ''}">${d.stats.rejectedConnections.toLocaleString()}</div>
              <div class="k">已过期键</div><div class="v">${d.stats.expiredKeys.toLocaleString()}</div>
              <div class="k">已淘汰键</div>
              <div class="v ${d.stats.evictedKeys > 0 ? 'warn' : ''}">${d.stats.evictedKeys.toLocaleString()}</div>
            </div>
          </div>
        </div>

        <div class="dev-card">
          <div class="dev-card-header">
            <div class="dev-card-title"><span class="icon">🔑</span> 键统计</div>
            <div class="dev-card-actions">
              <button onclick="DevApp.clearCache('redis')">清理缓存键</button>
            </div>
          </div>
          <div class="dev-grid dev-grid-4">
            <div class="dev-stat">
              <div class="dev-stat-label">总键数</div>
              <div class="dev-stat-value accent">${d.keyStats.total}</div>
            </div>
            <div class="dev-stat">
              <div class="dev-stat-label">Token (tk:)</div>
              <div class="dev-stat-value accent-2">${d.keyStats.tokens}</div>
            </div>
            <div class="dev-stat">
              <div class="dev-stat-label">缓存 (cache:)</div>
              <div class="dev-stat-value warm">${d.keyStats.cache}</div>
            </div>
            <div class="dev-stat">
              <div class="dev-stat-label">其他</div>
              <div class="dev-stat-value">${d.keyStats.other}</div>
            </div>
          </div>
        </div>
      `;
      document.getElementById('main-content').innerHTML = html;
    } catch (e) {
      document.getElementById('main-content').innerHTML = `<div class="dev-empty">加载失败: ${this._esc(e.message)}</div>`;
    }
  },

  // ==================== SESSIONS TAB ====================
  async renderSessions() {
    document.getElementById('main-content').innerHTML = `
      <div class="dev-section-header">
        <div class="dev-section-title">👥 在线会话 <span class="num">/ sessions</span></div>
      </div>
      <div class="dev-content-loading"><span class="dev-loading"></span> 加载中...</div>
    `;
    try {
      const d = await this.api('/api/dev/online-sessions');
      const bySystem = d.sessions.reduce((a, s) => { a[s.system] = (a[s.system] || 0) + 1; return a; }, {});
      const byRole = d.sessions.reduce((a, s) => { a[s.role] = (a[s.role] || 0) + 1; return a; }, {});
      const html = `
        <div class="dev-section-header">
          <div class="dev-section-title">👥 在线会话 <span class="num">/ sessions</span></div>
          <div class="dev-section-actions">
            <span class="dev-badge online">总 ${d.total}</span>
            <span class="dev-badge info">运维 ${bySystem.maintenance || 0}</span>
            <span class="dev-badge purple">运营 ${bySystem.operations || 0}</span>
            <span class="dev-badge warn">超管 ${byRole.superadmin || 0}</span>
          </div>
        </div>

        <div class="dev-card">
          <div class="dev-card-header">
            <div class="dev-card-title"><span class="icon">📋</span> 会话列表 (${d.sessions.length})</div>
            <div class="dev-card-actions">
              <input class="dev-input" type="text" id="session-search" placeholder="搜索用户名..." style="width:200px;padding:4px 8px;font-size:0.74rem;" oninput="DevApp._filterSessions(this.value)">
            </div>
          </div>
          <div class="dev-table-wrap">
            <table class="dev-table" id="session-table">
              <thead>
                <tr>
                  <th>用户名</th>
                  <th>角色</th>
                  <th>系统</th>
                  <th>登录时间</th>
                  <th>IP</th>
                  <th class="num">剩余 (秒)</th>
                  <th>状态</th>
                </tr>
              </thead>
              <tbody>
                ${d.sessions.map(s => {
                  const remaining = s.remaining;
                  const remainingPct = Math.min(100, (remaining / 7200) * 100);
                  const remColor = remaining < 600 ? 'danger' : remaining < 1800 ? 'warn' : '';
                  return `
                    <tr>
                      <td class="mono">${this._esc(s.username)}</td>
                      <td><span class="dev-badge ${s.role === 'superadmin' ? 'warn' : s.role === 'admin' ? 'info' : 'muted'}">${s.role}</span></td>
                      <td><span class="dev-badge ${s.system === 'operations' ? 'purple' : 'info'}">${s.system}</span></td>
                      <td style="font-size:0.74rem;color:var(--dev-text-dim)">${s.loginAt ? this._formatTime(new Date(s.loginAt).toISOString()) : '-'}</td>
                      <td style="font-size:0.74rem">${s.ip || '-'}</td>
                      <td class="num ${remColor}">${remaining}</td>
                      <td><span class="dev-badge online">● ACTIVE</span></td>
                    </tr>
                  `;
                }).join('')}
              </tbody>
            </table>
          </div>
        </div>
      `;
      document.getElementById('main-content').innerHTML = html;
    } catch (e) {
      document.getElementById('main-content').innerHTML = `<div class="dev-empty">加载失败: ${this._esc(e.message)}</div>`;
    }
  },

  _filterSessions(query) {
    const q = (query || '').toLowerCase();
    document.querySelectorAll('#session-table tbody tr').forEach(tr => {
      const txt = tr.textContent.toLowerCase();
      tr.style.display = q && !txt.includes(q) ? 'none' : '';
    });
  },

  // ==================== CACHE TAB ====================
  async renderCache() {
    document.getElementById('main-content').innerHTML = `
      <div class="dev-section-header">
        <div class="dev-section-title">🧹 缓存管理 <span class="num">/ cache</span></div>
      </div>
      <div class="dev-content-loading"><span class="dev-loading"></span> 加载中...</div>
    `;
    try {
      const d = await this.api('/api/dev/cache');
      const html = `
        <div class="dev-section-header">
          <div class="dev-section-title">🧹 缓存管理 <span class="num">/ cache</span></div>
          <div class="dev-section-actions">
            <button class="btn btn-outline" onclick="DevApp.clearCache('static')">清理静态缓存</button>
            <button class="btn btn-outline" onclick="DevApp.clearCache('redis')">清理 Redis 缓存</button>
            <button class="btn btn-outline" onclick="DevApp.clearCache('all')">全部清理</button>
          </div>
        </div>

        <div class="dev-grid dev-grid-3" style="margin-bottom:18px;">
          <div class="dev-stat">
            <div class="dev-stat-label">静态缓存条目</div>
            <div class="dev-stat-value accent">${d.staticCache.entries}</div>
            <div class="dev-stat-sub">总占用 ${d.staticCache.totalSizeHuman}</div>
          </div>
          <div class="dev-stat">
            <div class="dev-stat-label">内存 Token 数</div>
            <div class="dev-stat-value accent-2">${d.memoryTokens}</div>
            <div class="dev-stat-sub">fallback 用，Redis 不可用时</div>
          </div>
          <div class="dev-stat">
            <div class="dev-stat-label">Redis 状态</div>
            <div class="dev-stat-value ${d.redisAvailable ? 'accent' : 'danger'}">
              ${d.redisAvailable ? '✓ ONLINE' : '✗ OFFLINE'}
            </div>
            <div class="dev-stat-sub">${d.redisAvailable ? '可清理 cache:* 前缀' : 'Redis 不可用'}</div>
          </div>
        </div>

        <div class="dev-card">
          <div class="dev-card-header">
            <div class="dev-card-title"><span class="icon">📦</span> 静态缓存条目 (Top ${d.staticCache.entries_list.length})</div>
            <div class="dev-card-actions">
              <button onclick="DevApp.clearCache('static')">清空</button>
            </div>
          </div>
          ${d.staticCache.entries_list.length === 0 ? `
            <div class="dev-empty">无缓存条目</div>
          ` : `
            <div class="dev-table-wrap">
              <table class="dev-table">
                <thead>
                  <tr>
                    <th>路径</th>
                    <th>类型</th>
                    <th class="num">大小</th>
                    <th class="num">年龄 (秒)</th>
                  </tr>
                </thead>
                <tbody>
                  ${d.staticCache.entries_list.map(e => `
                    <tr>
                      <td class="mono" style="font-size:0.74rem">${this._esc(e.key.replace(/^.*?\/(js|css|images|uploads|fonts)\//, '$1/'))}</td>
                      <td><span class="dev-badge muted">${e.contentType.split(';')[0]}</span></td>
                      <td class="num">${e.sizeHuman}</td>
                      <td class="num">${Math.floor(e.ageMs / 1000)}</td>
                    </tr>
                  `).join('')}
                </tbody>
              </table>
            </div>
          `}
        </div>
      `;
      document.getElementById('main-content').innerHTML = html;
    } catch (e) {
      document.getElementById('main-content').innerHTML = `<div class="dev-empty">加载失败: ${this._esc(e.message)}</div>`;
    }
  },

  async clearCache(target) {
    if (!confirm(`确认清理 ${target === 'all' ? '所有' : target} 缓存?`)) return;
    try {
      const d = await this.api('/api/dev/cache/clear', {
        method: 'POST',
        body: JSON.stringify({ target }),
      });
      if (d.error) { this.notify(d.error, 'error'); return; }
      this.notify(`已清理: 静态 ${d.cleared.static} · Redis ${d.cleared.redis}`, 'success');
      if (this.currentTab === 'cache') this.renderCache();
    } catch (e) {
      this.notify('清理失败: ' + e.message, 'error');
    }
  },

  // ==================== LOGS TAB ====================
  async renderLogs() {
    const state = this._logState;
    document.getElementById('main-content').innerHTML = `
      <div class="dev-section-header">
        <div class="dev-section-title">📄 日志查看 <span class="num">/ logs</span></div>
        <div class="dev-section-actions">
          <select class="dev-select" id="log-type" onchange="DevApp._changeLogType(this.value)" style="width:auto;">
            <option value="app" ${state.type === 'app' ? 'selected' : ''}>app (应用)</option>
            <option value="audit" ${state.type === 'audit' ? 'selected' : ''}>audit (审计)</option>
            <option value="crash" ${state.type === 'crash' ? 'selected' : ''}>crash (崩溃)</option>
            <option value="dev" ${state.type === 'dev' ? 'selected' : ''}>dev (开发者操作)</option>
          </select>
          <select class="dev-select" id="log-lines" onchange="DevApp._changeLogLines(this.value)" style="width:auto;">
            <option value="100" ${state.lines === 100 ? 'selected' : ''}>100 行</option>
            <option value="200" ${state.lines === 200 ? 'selected' : ''}>200 行</option>
            <option value="500" ${state.lines === 500 ? 'selected' : ''}>500 行</option>
            <option value="1000" ${state.lines === 1000 ? 'selected' : ''}>1000 行</option>
          </select>
          <button class="btn btn-outline" onclick="DevApp.renderLogs()">⟳ 刷新</button>
        </div>
      </div>
      <div class="dev-card" style="padding:12px;">
        <input class="dev-input" type="text" id="log-search" placeholder="🔍 过滤日志内容..." value="${this._esc(state.search)}" oninput="DevApp._filterLogs(this.value)" style="margin-bottom:10px;">
        <div class="dev-log-viewer" id="log-viewer">
          <span class="dev-loading"></span> 加载中...
        </div>
      </div>
    `;
    try {
      const d = await this.api(`/api/dev/logs?type=${state.type}&lines=${state.lines}`);
      const viewer = document.getElementById('log-viewer');
      if (!d.lines || d.lines.length === 0) {
        viewer.innerHTML = `<div class="dev-empty">暂无日志（来源: ${this._esc(d.source || '无')})</div>`;
        return;
      }
      viewer.innerHTML = d.lines.map(line => this._renderLogLine(line, state.search)).join('');
      // Scroll to bottom
      viewer.scrollTop = viewer.scrollHeight;
    } catch (e) {
      document.getElementById('log-viewer').innerHTML = `<div class="dev-empty">加载失败: ${this._esc(e.message)}</div>`;
    }
  },

  _renderLogLine(line, search) {
    // Try to parse JSON log entry
    let time = '', level = '', msg = line;
    try {
      const obj = JSON.parse(line);
      time = obj.timestamp || obj.time || '';
      level = obj.level || '';
      msg = obj.message || obj.msg || line;
      if (obj.requestId) msg = `[${obj.requestId}] ${msg}`;
    } catch {
      // Plain text — try to detect leading timestamp and level
      const m = line.match(/^(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}[.\d]*)\s*(\[?\w+\]?)\s*(.*)$/);
      if (m) { time = m[1]; level = m[2].replace(/[\[\]]/g, ''); msg = m[3]; }
    }
    const levelCls = level ? `log-level-${level.toUpperCase()}` : '';
    const isMatch = search && line.toLowerCase().includes(search.toLowerCase());
    return `<div class="log-line ${isMatch ? 'dev-log-line-search' : ''}">
      <span class="log-time">${time ? this._esc(time) : ''}</span>
      ${level ? `<span class="${levelCls}">[${this._esc(level)}]</span> ` : ''}
      <span class="log-msg">${this._esc(msg)}</span>
    </div>`;
  },

  _changeLogType(t) { this._logState.type = t; this.renderLogs(); },
  _changeLogLines(n) { this._logState.lines = parseInt(n); this.renderLogs(); },
  _filterLogs(q) {
    this._logState.search = q;
    // Re-render existing lines without refetch (already in DOM)
    const viewer = document.getElementById('log-viewer');
    if (!viewer) return;
    viewer.querySelectorAll('.log-line').forEach(el => {
      const match = !q || el.textContent.toLowerCase().includes(q.toLowerCase());
      el.classList.toggle('dev-log-line-search', !!q && match);
      el.style.display = (!q || match) ? '' : 'none';
    });
  },

  viewLog(type) {
    this._logState.type = type;
    this.switchTab('logs');
  },

  viewCrashLog() {
    this._logState.type = 'crash';
    this.switchTab('logs');
  },

  // ==================== TABLES TAB ====================
  async renderTables() {
    document.getElementById('main-content').innerHTML = `
      <div class="dev-section-header">
        <div class="dev-section-title">📐 表结构 <span class="num">/ tables</span></div>
      </div>
      <div class="dev-content-loading"><span class="dev-loading"></span> 加载中...</div>
    `;
    try {
      const d = await this.api('/api/dev/tables');
      const tableNames = Object.keys(d.schemas);
      const html = `
        <div class="dev-section-header">
          <div class="dev-section-title">📐 表结构 <span class="num">/ tables</span></div>
          <div class="dev-section-actions">
            <span class="dev-badge info">${tableNames.length} 张表</span>
          </div>
        </div>
        <div class="dev-tabs">
          ${tableNames.map((t, i) => `<button class="dev-tab ${i === 0 ? 'active' : ''}" onclick="DevApp._showTableSchema(this, '${this._esc(t)}')">${this._esc(t)}</button>`).join('')}
        </div>
        <div class="dev-card" id="table-schema-card">
          ${this._renderTableSchema(d.schemas[tableNames[0]])}
        </div>
      `;
      document.getElementById('main-content').innerHTML = html;
      // Store schemas for switching
      this._schemasCache = d.schemas;
    } catch (e) {
      document.getElementById('main-content').innerHTML = `<div class="dev-empty">加载失败: ${this._esc(e.message)}</div>`;
    }
  },

  _showTableSchema(btn, name) {
    document.querySelectorAll('.dev-tab').forEach(t => t.classList.remove('active'));
    btn.classList.add('active');
    const card = document.getElementById('table-schema-card');
    if (card && this._schemasCache) {
      card.innerHTML = this._renderTableSchema(this._schemasCache[name]);
    }
  },

  _renderTableSchema(schema) {
    if (!Array.isArray(schema)) {
      return `<div class="dev-empty">无表结构信息: ${this._esc(schema.error || '')}</div>`;
    }
    return `
      <div class="dev-table-wrap">
        <table class="dev-table">
          <thead>
            <tr>
              <th>字段</th>
              <th>类型</th>
              <th>可空</th>
              <th>键</th>
              <th>默认值</th>
              <th>额外</th>
            </tr>
          </thead>
          <tbody>
            ${schema.map(c => `
              <tr>
                <td class="mono accent-2">${this._esc(c.name)}</td>
                <td>${this._esc(c.type)}</td>
                <td>${c.nullable === 'YES' ? '<span class="dev-badge warn">NULL</span>' : '<span class="dev-badge muted">NOT NULL</span>'}</td>
                <td>${c.keyType ? `<span class="dev-badge info">${c.keyType}</span>` : '-'}</td>
                <td style="font-size:0.74rem;color:var(--dev-text-dim)">${c.defaultVal === null ? '<i style="color:var(--dev-text-mute)">NULL</i>' : this._esc(c.defaultVal)}</td>
                <td style="font-size:0.74rem">${this._esc(c.extra || '')}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `;
  },

  // ==================== VERSION TAB ====================
  async renderVersion() {
    document.getElementById('main-content').innerHTML = `
      <div class="dev-section-header">
        <div class="dev-section-title">🏷️ 版本管理 <span class="num">/ version</span></div>
      </div>
      <div class="dev-content-loading"><span class="dev-loading"></span> 加载中...</div>
    `;
    try {
      const d = await this.api('/api/dev/version');
      this._versionCache = d;
      const html = `
        <div class="dev-section-header">
          <div class="dev-section-title">🏷️ 版本管理 <span class="num">/ version</span></div>
          <div class="dev-section-actions">
            <span class="dev-badge online">server ${d.serverVersion}</span>
            <span class="dev-badge info">${d.nodeVersion}</span>
            <span class="dev-badge purple">pkg ${d.packageVersion}</span>
          </div>
        </div>

        <div class="dev-grid dev-grid-3" style="margin-bottom:18px;">
          <div class="dev-card">
            <div class="dev-card-header">
              <div class="dev-card-title"><span class="icon">📦</span> package.json</div>
            </div>
            <div class="dev-kv">
              <div class="k">版本号</div><div class="v accent">${d.packageVersion}</div>
              <div class="k">服务器版本</div><div class="v">${d.serverVersion}</div>
              <div class="k">Node 版本</div><div class="v">${d.nodeVersion}</div>
              <div class="k">启动时间</div><div class="v" style="font-size:0.74rem">${this._formatTime(d.startedAt)}</div>
            </div>
          </div>

          ${d.git ? `
          <div class="dev-card">
            <div class="dev-card-header">
              <div class="dev-card-title"><span class="icon">🌿</span> Git 信息</div>
            </div>
            <div class="dev-kv">
              <div class="k">分支</div><div class="v accent-2">${this._esc(d.git.branch)}</div>
              <div class="k">最新提交</div><div class="v mono">${this._esc(d.git.commit)}</div>
              <div class="k">提交时间</div><div class="v" style="font-size:0.74rem">${this._esc(d.git.lastCommit)}</div>
              <div class="k">未提交变更</div>
              <div class="v ${d.git.status > 0 ? 'warn' : 'accent'}">${d.git.status} 个文件</div>
            </div>
          </div>
          ` : ''}

          <div class="dev-card">
            <div class="dev-card-header">
              <div class="dev-card-title"><span class="icon">⏱</span> 启动信息</div>
            </div>
            <div class="dev-kv">
              <div class="k">启动时刻</div><div class="v accent" style="font-size:0.78rem">${this._formatTime(d.startedAt)}</div>
              <div class="k">运行时长</div><div class="v">${this._calcDuration(d.startedAt)}</div>
            </div>
          </div>
        </div>

        <div class="dev-card">
          <div class="dev-card-header">
            <div class="dev-card-title"><span class="icon">🔢</span> 前端版本号 (js/version.json)</div>
            <div class="dev-card-actions">
              <button onclick="DevApp._bumpAllVersions()">全部 +1</button>
            </div>
          </div>
          <div class="dev-table-wrap">
            <table class="dev-table">
              <thead>
                <tr>
                  <th>组件</th>
                  <th class="num">当前版本</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                ${Object.entries(d.versionJson).map(([k, v]) => `
                  <tr>
                    <td class="mono accent-2">${this._esc(k)}</td>
                    <td class="num"><span class="dev-badge info">${v}</span></td>
                    <td>
                      <button class="btn btn-outline" onclick="DevApp.bumpVersion('${this._esc(k)}', 1)" style="padding:3px 10px;font-size:0.72rem;">+1</button>
                      <button class="btn btn-outline" onclick="DevApp.bumpVersion('${this._esc(k)}', 5)" style="padding:3px 10px;font-size:0.72rem;">+5</button>
                    </td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>
          <div style="margin-top:14px;padding:12px;background:var(--dev-bg);border:1px solid var(--dev-border);border-radius:6px;">
            <div style="font-family:var(--dev-mono);font-size:0.72rem;color:var(--dev-text-mute);margin-bottom:6px;">📋 当前 version.json 内容:</div>
            <pre class="dev-code" style="margin:0;">${this._esc(JSON.stringify(d.versionJson, null, 2))}</pre>
          </div>
        </div>
      `;
      document.getElementById('main-content').innerHTML = html;
    } catch (e) {
      document.getElementById('main-content').innerHTML = `<div class="dev-empty">加载失败: ${this._esc(e.message)}</div>`;
    }
  },

  async bumpVersion(component, inc = 1) {
    try {
      const d = await this.api('/api/dev/version', {
        method: 'POST',
        body: JSON.stringify({ component, increment: inc }),
      });
      if (d.error) { this.notify(d.error, 'error'); return; }
      this.notify(`${component}: ${d.from} → ${d.to}`, 'success');
      // Re-render version tab
      this.renderVersion();
      // Update sidebar tag
      this._loadVersionTag();
    } catch (e) {
      this.notify('版本更新失败: ' + e.message, 'error');
    }
  },

  async _bumpAllVersions() {
    if (!this._versionCache) return;
    if (!confirm('确认将所有组件版本号 +1? 这会让所有客户端强制刷新缓存。')) return;
    for (const k of Object.keys(this._versionCache.versionJson)) {
      try {
        await this.api('/api/dev/version', {
          method: 'POST',
          body: JSON.stringify({ component: k, increment: 1 }),
        });
      } catch (e) { console.error('Bump failed for', k, e); }
    }
    this.notify('所有版本号已 +1，客户端将刷新缓存', 'success');
    this.renderVersion();
    this._loadVersionTag();
  },

  async _loadVersionTag() {
    try {
      const d = await this.api('/api/dev/version');
      const tag = document.getElementById('dev-version-tag');
      if (tag) tag.textContent = `v${d.packageVersion}`;
    } catch {}
  },

  // ==================== ACTIONS TAB ====================
  async renderActions() {
    document.getElementById('main-content').innerHTML = `
      <div class="dev-section-header">
        <div class="dev-section-title">🚀 快速操作 <span class="num">/ actions</span></div>
      </div>

      <div class="dev-grid dev-grid-3">
        <div class="dev-card">
          <div class="dev-card-header">
            <div class="dev-card-title"><span class="icon">🧹</span> 缓存操作</div>
          </div>
          <div style="display:flex;flex-direction:column;gap:8px;">
            <button class="btn btn-outline" onclick="DevApp.clearCache('static')" style="text-align:left;">🧹 清理静态文件缓存</button>
            <button class="btn btn-outline" onclick="DevApp.clearCache('redis')" style="text-align:left;">⚡ 清理 Redis 业务缓存</button>
            <button class="btn btn-outline" onclick="DevApp.clearCache('all')" style="text-align:left;">💥 清理全部缓存</button>
          </div>
          <div class="dev-divider"></div>
          <div style="font-family:var(--dev-mono);font-size:0.74rem;color:var(--dev-text-dim);line-height:1.6;">
            说明：清理静态缓存后，下次访问将重新读取磁盘文件。清理 Redis 缓存仅删除 <span class="mono">cache:*</span> 前缀键，不会影响登录 token。
          </div>
        </div>

        <div class="dev-card">
          <div class="dev-card-header">
            <div class="dev-card-title"><span class="icon">📄</span> 日志查看</div>
          </div>
          <div style="display:flex;flex-direction:column;gap:8px;">
            <button class="btn btn-outline" onclick="DevApp.viewLog('app')" style="text-align:left;">📄 应用日志</button>
            <button class="btn btn-outline" onclick="DevApp.viewLog('audit')" style="text-align:left;">📝 审计日志</button>
            <button class="btn btn-outline" onclick="DevApp.viewLog('crash')" style="text-align:left;">💥 崩溃日志</button>
            <button class="btn btn-outline" onclick="DevApp.viewLog('dev')" style="text-align:left;">⚡ 开发者操作日志</button>
          </div>
          <div class="dev-divider"></div>
          <div style="font-family:var(--dev-mono);font-size:0.74rem;color:var(--dev-text-dim);line-height:1.6;">
            日志按类型分类存储。崩溃日志位于 <span class="mono">data/crash.log</span>，开发者操作日志位于 <span class="mono">data/audit-dev.log</span>。
          </div>
        </div>

        <div class="dev-card">
          <div class="dev-card-header">
            <div class="dev-card-title"><span class="icon">🏷️</span> 版本管理</div>
          </div>
          <div style="display:flex;flex-direction:column;gap:8px;">
            <button class="btn btn-outline" onclick="DevApp.switchTab('version')" style="text-align:left;">📈 查看版本详情</button>
            <button class="btn btn-outline" onclick="DevApp._bumpAllVersions()" style="text-align:left;">⬆ 全部版本 +1</button>
          </div>
          <div class="dev-divider"></div>
          <div style="font-family:var(--dev-mono);font-size:0.74rem;color:var(--dev-text-dim);line-height:1.6;">
            版本号变更会自动失效静态缓存，客户端下次加载会拉取新文件。
          </div>
        </div>

        <div class="dev-card">
          <div class="dev-card-header">
            <div class="dev-card-title"><span class="icon">🗄️</span> 数据库</div>
          </div>
          <div style="display:flex;flex-direction:column;gap:8px;">
            <button class="btn btn-outline" onclick="DevApp.switchTab('database')" style="text-align:left;">📊 数据库监控</button>
            <button class="btn btn-outline" onclick="DevApp.switchTab('tables')" style="text-align:left;">📐 查看表结构</button>
          </div>
        </div>

        <div class="dev-card">
          <div class="dev-card-header">
            <div class="dev-card-title"><span class="icon">👥</span> 会话</div>
          </div>
          <div style="display:flex;flex-direction:column;gap:8px;">
            <button class="btn btn-outline" onclick="DevApp.switchTab('sessions')" style="text-align:left;">📋 查看在线会话</button>
          </div>
        </div>

        <div class="dev-card" style="border-color:var(--dev-danger);">
          <div class="dev-card-header">
            <div class="dev-card-title" style="color:var(--dev-danger);"><span class="icon">⚠️</span> 危险操作</div>
          </div>
          <div style="display:flex;flex-direction:column;gap:8px;">
            <button class="btn btn-danger" onclick="DevApp.restartServer()" style="text-align:left;">🔄 重启服务器</button>
          </div>
          <div class="dev-divider"></div>
          <div style="font-family:var(--dev-mono);font-size:0.74rem;color:var(--dev-danger);line-height:1.6;">
            ⚠ 重启操作会触发优雅关闭流程：关闭 SSE / MySQL pool / Redis 连接，然后退出进程。若使用 PM2，进程会自动重启。
          </div>
        </div>
      </div>

      <div class="dev-card" style="margin-top:18px;">
        <div class="dev-card-header">
          <div class="dev-card-title"><span class="icon">📚</span> 系统架构速览</div>
        </div>
        <div class="dev-kv">
          <div class="k">后端</div><div class="v">Node.js ${this._versionCache?.nodeVersion || ''} + HTTP + cluster</div>
          <div class="k">数据库</div><div class="v">MySQL (mysql2/promise)</div>
          <div class="k">缓存</div><div class="v">Redis (token + cache + pub/sub)</div>
          <div class="k">实时通信</div><div class="v">WebSocket + SSE (双通道)</div>
          <div class="k">部署</div><div class="v">PM2 / Docker / k8s</div>
          <div class="k">目标并发</div><div class="v accent">500 users</div>
        </div>
      </div>
    `;
  },

  async restartServer() {
    if (!confirm('⚠ 确认重启服务器?\n\n所有在线用户的会话将保持（token 存在 Redis 中），但 SSE 连接会断开几秒。\n\n继续?')) return;
    const delay = prompt('延迟秒数 (1-60):', '3');
    if (delay === null) return;
    const d = parseInt(delay);
    if (isNaN(d) || d < 1 || d > 60) { this.notify('延迟秒数无效', 'error'); return; }
    try {
      this.notify(`服务器将在 ${d} 秒后重启...`, 'warning');
      const res = await this.api('/api/dev/restart', {
        method: 'POST',
        body: JSON.stringify({ delay: d }),
      });
      if (res.error) { this.notify(res.error, 'error'); return; }
      this.notify(res.message || '重启已触发', 'success');
      // Poll for revival
      setTimeout(() => {
        this.notify('等待服务器恢复...', 'info');
        const poll = async () => {
          try {
            const r = await this._fetchWithTimeout(this.baseURL + '/api/health', {}, 3000);
            if (r.ok) {
              this.notify('✓ 服务器已恢复', 'success');
              this.refresh();
              return;
            }
          } catch {}
          setTimeout(poll, 2000);
        };
        setTimeout(poll, (d + 1) * 1000);
      }, d * 1000);
    } catch (e) {
      this.notify('重启请求失败: ' + e.message, 'error');
    }
  },

  // ==================== MODAL ====================
  closeModal() {
    document.getElementById('modal-overlay').classList.remove('active');
  },

  openModal(title, bodyHtml, options = {}) {
    document.getElementById('modal-title').textContent = title;
    document.getElementById('modal-body').innerHTML = bodyHtml;
    document.getElementById('modal-save').textContent = options.saveText || '确认';
    document.getElementById('modal-save').style.display = options.hideSave ? 'none' : '';
    document.getElementById('modal-close-btn').style.display = options.hideClose ? 'none' : '';
    document.getElementById('modal-overlay').classList.add('active');
  },

  // ==================== NOTIFY ====================
  notify(msg, type = 'info', duration = 3000) {
    const container = document.getElementById('notification-container');
    if (!container) { console.log(`[${type}]`, msg); return; }
    const el = document.createElement('div');
    el.className = `dev-notify ${type}`;
    el.textContent = msg;
    container.appendChild(el);
    setTimeout(() => {
      el.style.transition = 'opacity 0.3s ease, transform 0.3s ease';
      el.style.opacity = '0';
      el.style.transform = 'translateX(20px)';
      setTimeout(() => el.remove(), 300);
    }, duration);
  },

  // ==================== HELPERS ====================
  _esc(s) {
    if (s === null || s === undefined) return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  },

  _formatTime(iso) {
    if (!iso) return '-';
    try {
      const d = new Date(iso);
      if (isNaN(d.getTime())) return iso;
      return d.toLocaleString('zh-CN', {
        year: '2-digit', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        hour12: false,
      });
    } catch { return iso; }
  },

  _formatBytes(bytes) {
    if (!bytes) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return (bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 2) + ' ' + units[i];
  },

  _calcDuration(iso) {
    if (!iso) return '-';
    try {
      const start = new Date(iso).getTime();
      const sec = Math.floor((Date.now() - start) / 1000);
      const d = Math.floor(sec / 86400);
      const h = Math.floor((sec % 86400) / 3600);
      const m = Math.floor((sec % 3600) / 60);
      const s = sec % 60;
      if (d > 0) return `${d}d ${h}h ${m}m`;
      if (h > 0) return `${h}h ${m}m ${s}s`;
      if (m > 0) return `${m}m ${s}s`;
      return `${s}s`;
    } catch { return '-'; }
  },
};

// ==================== BOOTSTRAP ====================
document.addEventListener('DOMContentLoaded', () => {
  DevApp.init();
});
