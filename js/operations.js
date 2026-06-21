/**
 * Operations System - 运营管理系统
 */
const OpsApp = {
  currentTab: 'personal-analysis',
  _tasks: [],
  _requirements: [],

  // ==================== INITIALIZATION ====================
  async init() {
    this.applyTheme();
    this.bindNavigation();

    const online = await API.init();
    if (!API.currentUser) {
      // Show login form directly (no redirect)
      this.showLogin(online ? '' : '离线模式 — 数据保存在本地浏览器');
    } else {
      // Kick maintenance users back (except superadmin who can access both)
      const uSys = API.currentUser.system || 'maintenance';
      if (uSys === 'maintenance' && API.currentUser.role !== 'superadmin') {
        window.location.replace('index.html');
        return;
      }
      if (online) { await this._syncFromServer(); }
      document.body.classList.add('logged-in');
      const sidebar = document.querySelector('.sidebar');
      if (sidebar) sidebar.style.display = '';
      const topbarRight = document.querySelector('.topbar-right');
      if (topbarRight) topbarRight.style.display = '';
      const hamburger = document.getElementById('hamburger-btn');
      if (hamburger) hamburger.style.display = '';
      // Show tech support nav only for normal users (role=user) in operations system
      this._updateTechSupportNav();
      // Show user management nav only for admin/superadmin
      this._updateUserManagementNav();
      this._loadLocalData();
      this.updateSidebarUser();
      this.updateUserDisplay();
      this.updateHealthDot();
      this.renderCurrentTab();
      this.startAutoRefresh();
      this.startHealthCheck();
      this.initStatusBar();
    }
  },

  // ==================== LOCAL DATA ====================
  _loadLocalData() {
    try {
      this._tasks = JSON.parse(localStorage.getItem('ops_tasks') || '[]');
      this._requirements = JSON.parse(localStorage.getItem('ops_requirements') || '[]');
    } catch { this._tasks = []; this._requirements = []; }
  },
  _saveTasks() { localStorage.setItem('ops_tasks', JSON.stringify(this._tasks)); },
  _saveRequirements() { localStorage.setItem('ops_requirements', JSON.stringify(this._requirements)); },

  // ==================== AUTH ====================
  showLogin(errorMsg) {
    const html = `
      <div class="login-screen">
        <div class="login-box">
          <div class="login-icon">📊</div>
          <h1>运营系统</h1>
          <p class="login-subtitle">请登录以继续</p>
          ${errorMsg ? '<div class="alert-banner info" style="margin-bottom:16px;">ℹ '+errorMsg+'</div>' : ''}
          <div class="form-group">
            <label>用户名</label>
            <input type="text" id="login-username" placeholder="输入用户名" autocomplete="username" required>
          </div>
          <div class="form-group">
            <label>密码</label>
            <input type="password" id="login-password" placeholder="输入密码" autocomplete="current-password" required>
          </div>
          <div id="login-error" style="color:var(--color-danger);font-size:0.85rem;min-height:20px;text-align:center;"></div>
          <button class="btn btn-primary" id="login-btn" style="width:100%;padding:12px;" onclick="OpsApp.doLogin()">登录</button>
        </div>
      </div>
    `;
    document.getElementById('main-content').innerHTML = html;
    document.body.classList.remove('logged-in');
    document.body.classList.remove('sidebar-open');
    const topbarRight = document.querySelector('.topbar-right');
    if (topbarRight) topbarRight.style.display = 'none';
    const sidebar = document.querySelector('.sidebar');
    if (sidebar) sidebar.style.display = 'none';
    const hamburger = document.getElementById('hamburger-btn');
    if (hamburger) hamburger.style.display = 'none';
    const pwEl = document.getElementById('login-password');
    if (pwEl) pwEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') this.doLogin(); });
  },

  async doLogin() {
    const username = document.getElementById('login-username')?.value.trim();
    const password = document.getElementById('login-password')?.value.trim();
    const errorEl = document.getElementById('login-error');
    if (!username || !password) { if (errorEl) errorEl.textContent = '请输入用户名和密码'; return; }
    const btn = document.getElementById('login-btn');
    if (btn) { btn.disabled = true; btn.textContent = '登录中...'; }
    const result = await API.login(username, password);
    if (!result.success) {
      if (errorEl) errorEl.textContent = result.message;
      if (btn) { btn.disabled = false; btn.textContent = '登录'; }
      return;
    }
    const userSystem = result.user.system || 'maintenance';
    if (userSystem === 'maintenance' && result.user.role !== 'superadmin') {
      window.location.href = 'index.html';
      return;
    }
    document.body.classList.add('logged-in');
    const topbarRight = document.querySelector('.topbar-right');
    if (topbarRight) topbarRight.style.display = '';
    const sidebar = document.querySelector('.sidebar');
    if (sidebar) sidebar.style.display = '';
    const hamburger = document.getElementById('hamburger-btn');
    if (hamburger) hamburger.style.display = '';
    await this._syncFromServer();
    this._loadLocalData();
    this.updateSidebarUser();
    this.updateUserDisplay();
    this.updateHealthDot();
    this.renderCurrentTab();
    this.startAutoRefresh();
    this.startHealthCheck();
    this.initStatusBar();
    this._updateTechSupportNav();
    this._updateUserManagementNav();
    this.notify('欢迎，' + result.user.username + '！');
  },

  async doLogout() {
    if (API.online) {
      await fetch(API.baseURL + '/api/logout', { method: 'POST', headers: API._headers() }).catch(() => {});
    }
    API.logout();
    document.body.classList.remove('logged-in');
    this.showLogin();
  },

  // ==================== SIDEBAR ====================
  updateSidebarUser() {
    const user = API.currentUser;
    if (!user) return;
    const avatar = document.getElementById('sidebar-avatar');
    const username = document.getElementById('sidebar-username');
    const role = document.getElementById('sidebar-role');
    if (avatar) avatar.textContent = (user.username || '?')[0].toUpperCase();
    if (username) username.textContent = user.username || '--';
    if (role) {
      const roleMap = { superadmin: '超级管理员', admin: '管理员' };
      role.textContent = roleMap[user.role] || '普通用户';
    }
  },

  toggleNavGroup(groupId) {
    const group = document.querySelector('.nav-group:has(#group-' + groupId + ')');
    if (group) group.classList.toggle('collapsed');
  },

  globalSearch(query) {
    // Filter nav items or search content based on query
    if (!query) {
      document.querySelectorAll('.nav-group-items .nav-item').forEach(el => el.style.display = '');
      return;
    }
    const q = query.toLowerCase();
    document.querySelectorAll('.nav-group-items .nav-item').forEach(el => {
      el.style.display = el.textContent.toLowerCase().includes(q) ? '' : 'none';
    });
  },

  // ==================== NAVIGATION ====================
  bindNavigation() {
    document.querySelectorAll('.nav-group-items .nav-item').forEach(item => {
      item.addEventListener('click', () => {
        this.switchTab(item.dataset.tab);
      });
    });
    document.getElementById('theme-toggle').addEventListener('click', () => this.toggleTheme());
    // Close mobile sidebar when clicking outside
    document.addEventListener('click', (e) => {
      if (!document.body.classList.contains('sidebar-open')) return;
      const sidebar = document.querySelector('.sidebar');
      const hamburger = document.getElementById('hamburger-btn');
      if (sidebar && !sidebar.contains(e.target) && hamburger && !hamburger.contains(e.target)) {
        document.body.classList.remove('sidebar-open');
      }
    });
  },


  _setCookie(name, value, days) {
    var d = new Date(); d.setTime(d.getTime() + (days * 86400000));
    document.cookie = name + "=" + encodeURIComponent(value) + ";expires=" + d.toUTCString() + ";path=/";
  },
  _getCookie(name) {
    var m = document.cookie.match("(^|;)\\s*" + name + "\\s*=\\s*([^;]+)");
    return m ? decodeURIComponent(m[2]) : null;
  },
  switchTab(tab) {
    this.currentTab = tab;
    document.body.classList.remove('sidebar-open');
    document.querySelectorAll('.nav-group-items .nav-item').forEach(i => i.classList.remove('active'));
    const navItem = document.querySelector('.nav-item[data-tab="' + tab + '"]');
    if (navItem) navItem.classList.add('active');

    // Update topbar title
    const titleMap = {
      'personal-analysis': '个人分析与个人数据',
      'task-list': '任务列表',
      'data-analysis': '数据分析',
      'team-members': '组员',
      'requirements': '需求',
      'tech-support-submit': '提交技术支持请求',
      'tech-support-my': '我的技术支持请求',
      'user-management': '账户管理',
      'popup-messages': '弹窗句子管理',
    };
    const titleEl = document.getElementById('topbar-page-title');
    if (titleEl) titleEl.textContent = titleMap[tab] || '运营系统';

    this.renderCurrentTab();
  },

  renderCurrentTab() {
    const tab = this.currentTab;
    const user = API.currentUser;
    // Normal users (role='user') can only access tech-support-submit and personal-analysis
    const allowedTabs = ['personal-analysis', 'tech-support-submit'];
    if (user && user.role === 'user' && !allowedTabs.includes(tab)) {
      document.getElementById('main-content').innerHTML = `<div style="display:flex;align-items:center;justify-content:center;min-height:60vh;">
        <div style="text-align:center;">
          <div style="font-size:3.5rem;margin-bottom:20px;">🚧</div>
          <p style="font-size:1.2rem;color:var(--text-secondary);font-weight:500;">该页面正在装修，请耐心等待</p>
        </div>
      </div>`;
      return;
    }
    switch (tab) {
      case 'personal-analysis': this.renderPersonalAnalysis(); break;
      case 'task-list': this.renderTaskList(); break;
      case 'data-analysis': this.renderDataAnalysis(); break;
      case 'team-members': this.renderTeamMembers(); break;
      case 'requirements': this.renderRequirements(); break;
      case 'tech-support-submit': this.renderTechSupportSubmit(); break;
      case 'tech-support-my': this.renderTechSupportMy(); break;
      case 'user-management': this.renderUserManagement(); break;
      case 'popup-messages': this.renderPopupMessages(); break;
      default: this.renderPersonalAnalysis(); break;
    }
  },

  refreshCurrentTab() { this.renderCurrentTab(); },

  // ==================== PERSONAL ANALYSIS ====================
  renderPersonalAnalysis() {
    const user = API.currentUser || {};
    const tasksDone = this._tasks.filter(t => t.done).length;
    const tasksTotal = this._tasks.length;
    const reqsTotal = this._requirements.length;

    const html = `
      <div class="ops-dashboard">
        <div class="personal-header">
          <div class="personal-avatar-lg">${(user.username || '?')[0].toUpperCase()}</div>
          <div>
            <h2 style="margin:0;font-size:1.3rem;">你好，${user.username || '--'}</h2>
            <p style="color:var(--text-secondary);font-size:0.85rem;margin:4px 0 0;">欢迎回到运营管理系统</p>
          </div>
          <div class="personal-stats-mini" style="margin-left:auto;">
            <div class="personal-stat-mini"><div class="psm-value">${tasksDone}/${tasksTotal}</div><div class="psm-label">任务完成</div></div>
            <div class="personal-stat-mini"><div class="psm-value">${reqsTotal}</div><div class="psm-label">需求总数</div></div>
            <div class="personal-stat-mini"><div class="psm-value">${this._tasks.length}</div><div class="psm-label">待办事项</div></div>
          </div>
        </div>

        <div class="ops-overview-row">
          <div class="ops-overview-card" onclick="OpsApp.switchTab('task-list')">
            <div class="ov-icon blue">✅</div>
            <div class="ov-info"><div class="ov-value">${tasksTotal}</div><div class="ov-label">总任务数</div></div>
          </div>
          <div class="ops-overview-card" onclick="OpsApp.switchTab('task-list')">
            <div class="ov-icon green">✓</div>
            <div class="ov-info"><div class="ov-value">${tasksDone}</div><div class="ov-label">已完成</div></div>
          </div>
          <div class="ops-overview-card" onclick="OpsApp.switchTab('requirements')">
            <div class="ov-icon orange">📝</div>
            <div class="ov-info"><div class="ov-value">${reqsTotal}</div><div class="ov-label">需求数</div></div>
          </div>
          <div class="ops-overview-card" onclick="OpsApp.switchTab('data-analysis')">
            <div class="ov-icon purple">📈</div>
            <div class="ov-info"><div class="ov-value">${this._tasks.filter(t => !t.done).length}</div><div class="ov-label">待处理</div></div>
          </div>
        </div>

        <div class="ops-content-grid">
          <div class="ops-card">
            <h3>📋 近期任务</h3>
            <div class="task-list">
              ${this._tasks.slice(0, 6).map(t => `
                <div class="task-item ${t.done ? 'done' : ''}">
                  <span class="task-priority ${t.priority || 'medium'}"></span>
                  <span class="task-text">${t.text}</span>
                  <span class="task-date">${t.date || ''}</span>
                </div>
              `).join('') || '<p class="empty-text">暂无任务</p>'}
            </div>
          </div>
          <div class="ops-card">
            <h3>📝 近期需求</h3>
            <div class="task-list">
              ${this._requirements.slice(0, 6).map(r => `
                <div class="task-item">
                  <span class="task-priority ${r.priority || 'medium'}"></span>
                  <span class="task-text">${r.title}</span>
                  <span class="task-date">${r.date || ''}</span>
                </div>
              `).join('') || '<p class="empty-text">暂无需求</p>'}
            </div>
          </div>
        </div>
      </div>
    `;
    document.getElementById('main-content').innerHTML = html;
  },

  // ==================== TASK LIST ====================
  renderTaskList() {
    const pending = this._tasks.filter(t => !t.done);
    const done = this._tasks.filter(t => t.done);
    const html = `
      <div class="page-header">
        <h2>✅ 任务列表</h2>
        <span style="color:var(--text-secondary);font-size:0.85rem;">${pending.length} 待完成 / ${done.length} 已完成</span>
      </div>

      <div class="task-form">
        <input type="text" id="new-task-text" placeholder="添加新任务..." onkeydown="if(event.key==='Enter')OpsApp.addTask()">
        <select id="new-task-priority">
          <option value="high">高优先</option>
          <option value="medium" selected>中优先</option>
          <option value="low">低优先</option>
        </select>
        <button class="btn btn-primary btn-sm" onclick="OpsApp.addTask()">添加</button>
      </div>

      ${pending.length > 0 ? `
      <div class="ops-card" style="margin-bottom:16px;">
        <h3>待完成 (${pending.length})</h3>
        <div class="task-list">
          ${pending.map(t => `
            <div class="task-item" onclick="OpsApp.toggleTask('${t.id}')">
              <div class="task-check"></div>
              <span class="task-priority ${t.priority || 'medium'}"></span>
              <span class="task-text">${t.text}</span>
              <span class="task-date">${t.date || ''}</span>
              <button class="btn btn-xs btn-danger" onclick="event.stopPropagation();OpsApp.deleteTask('${t.id}')" style="margin-left:auto;">✕</button>
            </div>
          `).join('')}
        </div>
      </div>
      ` : ''}

      ${done.length > 0 ? `
      <div class="ops-card">
        <h3>已完成 (${done.length})</h3>
        <div class="task-list">
          ${done.slice(0, 20).map(t => `
            <div class="task-item done" onclick="OpsApp.toggleTask('${t.id}')">
              <div class="task-check">✓</div>
              <span class="task-priority ${t.priority || 'medium'}"></span>
              <span class="task-text">${t.text}</span>
              <span class="task-date">${t.date || ''}</span>
              <button class="btn btn-xs btn-danger" onclick="event.stopPropagation();OpsApp.deleteTask('${t.id}')" style="margin-left:auto;">✕</button>
            </div>
          `).join('')}
        </div>
      </div>
      ` : ''}

      ${this._tasks.length === 0 ? '<p class="empty-text">暂无任务，添加一个开始吧</p>' : ''}
    `;
    document.getElementById('main-content').innerHTML = html;
  },

  addTask() {
    const textEl = document.getElementById('new-task-text');
    const priEl = document.getElementById('new-task-priority');
    const text = textEl?.value.trim();
    if (!text) return;
    this._tasks.unshift({
      id: 't' + Date.now(),
      text: text,
      priority: priEl?.value || 'medium',
      done: false,
      date: new Date().toLocaleDateString('zh-CN'),
    });
    this._saveTasks();
    if (textEl) textEl.value = '';
    this.renderTaskList();
    this.notify('任务已添加');
  },

  toggleTask(id) {
    const task = this._tasks.find(t => t.id === id);
    if (task) { task.done = !task.done; this._saveTasks(); }
    this.renderTaskList();
  },

  deleteTask(id) {
    this._tasks = this._tasks.filter(t => t.id !== id);
    this._saveTasks();
    this.renderTaskList();
    this.notify('任务已删除');
  },

  // ==================== DATA ANALYSIS ====================
  renderDataAnalysis() {
    const html = `
      <div class="page-header">
        <h2>📈 数据分析</h2>
      </div>
      <div class="analysis-grid">
        <div class="analysis-card">
          <h4>📊 任务完成统计</h4>
          <div class="chart-wrap"><canvas id="chart-task-stats"></canvas></div>
        </div>
        <div class="analysis-card">
          <h4>📈 需求状态分布</h4>
          <div class="chart-wrap"><canvas id="chart-req-stats"></canvas></div>
        </div>
        <div class="analysis-card">
          <h4>📅 每日任务趋势 (近7天)</h4>
          <div class="chart-wrap"><canvas id="chart-daily-tasks"></canvas></div>
        </div>
        <div class="analysis-card">
          <h4>📋 优先级分布</h4>
          <div class="chart-wrap"><canvas id="chart-priority-dist"></canvas></div>
        </div>
      </div>
    `;
    document.getElementById('main-content').innerHTML = html;
    setTimeout(() => {
      this._drawTaskStatsChart();
      this._drawReqStatsChart();
      this._drawDailyTasksChart();
      this._drawPriorityDistChart();
    }, 100);
  },

  _drawTaskStatsChart() {
    const canvas = document.getElementById('chart-task-stats');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const done = this._tasks.filter(t => t.done).length;
    const pending = this._tasks.filter(t => !t.done).length;
    this._drawBarChart(ctx, ['已完成', '待完成'], [
      { label: '数量', data: [done, pending], color: '#10b981' },
    ]);
  },

  _drawReqStatsChart() {
    const canvas = document.getElementById('chart-req-stats');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const pending = this._requirements.filter(r => r.status === 'pending').length;
    const approved = this._requirements.filter(r => r.status === 'approved').length;
    const rejected = this._requirements.filter(r => r.status === 'rejected').length;
    this._drawBarChart(ctx, ['待处理', '已通过', '已拒绝'], [
      { label: '数量', data: [pending, approved, rejected], color: '#f59e0b' },
    ]);
  },

  _drawDailyTasksChart() {
    const canvas = document.getElementById('chart-daily-tasks');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const days = [];
    const dayKeys = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      days.push(d.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' }));
      dayKeys.push(d.toLocaleDateString('zh-CN'));
    }
    const data = dayKeys.map(key => this._tasks.filter(t => t.date === key).length);
    this._drawLineChart(ctx, days, [
      { label: '任务数', data: data, color: '#6366f1' },
    ]);
  },

  _drawPriorityDistChart() {
    const canvas = document.getElementById('chart-priority-dist');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const high = this._tasks.filter(t => t.priority === 'high').length;
    const med = this._tasks.filter(t => t.priority === 'medium').length;
    const low = this._tasks.filter(t => t.priority === 'low').length;
    this._drawBarChart(ctx, ['高', '中', '低'], [
      { label: '数量', data: [high, med, low], color: '#8b5cf6' },
    ]);
  },

  // ==================== TEAM MEMBERS ====================
  // ==================== GROUP & TEAM MANAGEMENT ====================
  async _loadGroupData() {
    this._groupMembers = await API.getGroupMembers();
    this._groupTransfers = await API.getGroupTransfers();
    this._mySubordinates = await API.getSubordinates();
  },

  async renderTeamMembers() {
    const user = API.currentUser;
    const isLeader = user && (user.role === 'admin' || user.role === 'superadmin');
    if (!isLeader) {
      document.getElementById('main-content').innerHTML = '<p class="empty-text">仅组长和管理员可查看组员管理</p>';
      return;
    }

    await this._loadGroupData();
    const groups = this._groupMembers || [];
    const transfers = this._groupTransfers || [];
    const myUsers = this._mySubordinates || [];

    const myGroup = groups.find(g => g.adminId === user.id) || { adminName: user.username, members: myUsers };

    const pendingTransfers = transfers.filter(t => t.status === 'pending');
    const historyTransfers = transfers.filter(t => t.status !== 'pending');

    const html = `
      <div class="page-header">
        <h2>👥 组员管理</h2>
        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          <button class="btn btn-primary btn-sm" onclick="OpsApp._showTransferForm()">🔄 跨组调配</button>
          <button class="btn btn-outline btn-sm" onclick="OpsApp.renderTeamMembers()">🔄 刷新</button>
        </div>
      </div>

      <!-- My Group -->
      <div style="margin-bottom:24px;">
        <h3 style="margin:0 0 12px 0;font-size:0.95rem;">📋 我的组员 <span style="color:var(--text-secondary);font-size:0.8rem;">（组长：${myGroup.adminName || user.username}）</span></h3>
        <div class="team-grid">
          ${myGroup.members.length === 0 ? '<p class="empty-text" style="grid-column:1/-1;">暂无组员。通过"添加用户"功能创建用户后自动加入此组。</p>' : ''}
          ${myGroup.members.map((m, i) => `
            <div class="team-member-card">
              <div class="member-avatar" style="background:${['#6366f1','#10b981','#f59e0b','#ef4444','#8b5cf6','#ec4899'][i % 6]};">
                ${(m.username || '?')[0].toUpperCase()}
              </div>
              <div class="member-info">
                <div class="member-name">${m.username}</div>
                <div class="member-role">${m.role === 'admin' ? '组长' : '组员'}</div>
              </div>
              ${isLeader ? `<button class="btn btn-xs btn-outline" style="margin-left:4px;"
                onclick="OpsApp._startOutTransfer('${m.id}','${m.username}')"
                title="调出到其他组">📤 调出</button>` : ''}
            </div>
          `).join('')}
        </div>
      </div>

      <!-- Other Groups (for cross-group visibility) -->
      ${isLeader && groups.length > 0 ? `
      <div style="margin-bottom:24px;">
        <h3 style="margin:0 0 12px 0;font-size:0.95rem;">🌐 其他组 <span style="color:var(--text-secondary);font-size:0.8rem;">（可申请调入）</span></h3>
        ${groups.filter(g => g.adminId !== user.id).map(g => `
          <div class="transfer-card" style="margin-bottom:10px;">
            <div class="transfer-header">
              <strong>👤 ${g.adminName || g.adminId}</strong>
              <span style="color:var(--text-secondary);font-size:0.8rem;">${g.members.length} 名组员</span>
            </div>
            <div style="display:flex;flex-wrap:wrap;gap:6px;">
              ${g.members.map(m => `
                <span class="transfer-card" style="padding:4px 10px;font-size:0.8rem;display:inline-flex;align-items:center;gap:6px;">
                  ${m.username}
                  <button class="btn btn-xs btn-primary" style="padding:1px 6px;font-size:0.7rem;"
                    onclick="OpsApp._startInTransfer('${m.id}','${m.username}','${g.adminId}','${g.adminName || g.adminId}')">
                    📥 调入
                  </button>
                </span>
              `).join('')}
              ${g.members.length === 0 ? '<span style="color:var(--text-secondary);font-size:0.8rem;">暂无组员</span>' : ''}
            </div>
          </div>
        `).join('')}
      </div>
      ` : ''}

      <!-- Pending Transfers -->
      ${pendingTransfers.length > 0 ? `
      <div style="margin-bottom:24px;">
        <h3 style="margin:0 0 12px 0;font-size:0.95rem;">⏳ 待处理调配</h3>
        ${pendingTransfers.map(t => {
          const isFromMe = t.fromAdminId === user.id;
          const needsMyApproval = (isFromMe && t.status === 'pending') || (!isFromMe && t.toAdminId === user.id);
          return `
          <div class="transfer-card">
            <div class="transfer-header">
              <span class="transfer-type ${t.direction}">${t.direction === 'out' ? '📤 调出' : '📥 调入'}</span>
              <span class="transfer-status pending">⏳ 待审批</span>
              <span style="font-size:0.75rem;color:var(--text-secondary);">${new Date(t.createdAt).toLocaleString('zh-CN')}</span>
            </div>
            <div class="transfer-body">
              <strong>${t.username}</strong>：
              ${t.direction === 'out' ? `从 <strong>${t.fromAdminName}</strong> 调出至 <strong>${t.toAdminName}</strong>` : `从 <strong>${t.toAdminName}</strong> 调入至 <strong>${t.fromAdminName}</strong>`}
              ${t.reason ? `<br>原因：${t.reason}` : ''}
            </div>
            ${!isFromMe ? `
            <div class="transfer-actions">
              <button class="btn btn-sm btn-primary" onclick="OpsApp._approveTransfer('${t.id}')">✅ 同意</button>
              <button class="btn btn-sm btn-danger" onclick="OpsApp._rejectTransfer('${t.id}')">❌ 拒绝</button>
            </div>
            ` : `
            <div class="transfer-actions">
              <button class="btn btn-xs btn-outline" onclick="OpsApp._cancelTransfer('${t.id}')">取消请求</button>
            </div>`}
          </div>`;
        }).join('')}
      </div>
      ` : ''}

      <!-- Transfer History -->
      ${historyTransfers.length > 0 ? `
      <div>
        <h3 style="margin:0 0 12px 0;font-size:0.95rem;">📜 调配记录</h3>
        ${historyTransfers.slice(0, 20).map(t => `
          <div class="transfer-card" style="opacity:0.7;">
            <div class="transfer-header">
              <span class="transfer-type ${t.direction}">${t.direction === 'out' ? '📤 调出' : '📥 调入'}</span>
              <span class="transfer-status ${t.status}">${t.status === 'completed' ? '✅ 已完成' : t.status === 'rejected' ? '❌ 已拒绝' : '⊗ 已取消'}</span>
              <span style="font-size:0.75rem;color:var(--text-secondary);">${new Date(t.updatedAt).toLocaleString('zh-CN')}</span>
            </div>
            <div class="transfer-body">
              <strong>${t.username}</strong>：
              ${t.direction === 'out' ? `从 <strong>${t.fromAdminName}</strong> → <strong>${t.toAdminName}</strong>` : `从 <strong>${t.toAdminName}</strong> → <strong>${t.fromAdminName}</strong>`}
              ${t.status === 'completed' ? ' — 调配已完成' : t.rejectedByName ? ` — 被 ${t.rejectedByName} 拒绝` : ''}
            </div>
          </div>
        `).join('')}
      </div>
      ` : ''}
    `;
    document.getElementById('main-content').innerHTML = html;
  },

  // Cross-group transfer actions
  _startOutTransfer(userId, username) {
    const user = API.currentUser;
    API.getGroupMembers().then(groups => {
      // Find other admins
      const otherAdmins = [];
      groups.forEach(g => {
        if (g.adminId !== user.id) {
          otherAdmins.push({ id: g.adminId, name: g.adminName || g.adminId, count: g.members.length });
        }
      });
      if (otherAdmins.length === 0) {
        this.notify('暂无其他组长可调配', 'warning');
        return;
      }
      const options = otherAdmins.map(a =>
        `<option value="${a.id}">${a.name}（${a.count}名组员）</option>`
      ).join('');
      const html = `
        <div class="form-group">
          <label>调出组员 <span class="required">*</span></label>
          <input class="form-input" value="${username}" disabled>
        </div>
        <div class="form-group">
          <label>目标组长 <span class="required">*</span></label>
          <select id="transfer-target-admin" class="form-select">${options}</select>
        </div>
        <div class="form-group">
          <label>调配原因</label>
          <textarea id="transfer-reason" class="form-textarea" rows="2" placeholder="可选：调配原因说明"></textarea>
        </div>
      `;
      this.showModal('📤 调出组员', html, async () => {
        const toAdminId = document.getElementById('transfer-target-admin')?.value;
        const reason = document.getElementById('transfer-reason')?.value?.trim() || '';
        if (!toAdminId) { this.notify('请选择目标组长', 'warning'); return false; }
        const result = await API.createGroupTransfer({
          toAdminId, userId, username, direction: 'out', reason
        });
        if (result?.success) {
          this.notify('调配请求已发送，等待对方组长审批');
          this.renderTeamMembers();
        } else {
          this.notify(result?.message || result?.error || '发送失败', 'error');
        }
        return true;
      });
    });
  },

  _startInTransfer(userId, username, fromAdminId, fromAdminName) {
    const html = `
      <div class="form-group">
        <label>调入组员 <span class="required">*</span></label>
        <input class="form-input" value="${username}" disabled>
      </div>
      <div class="form-group">
        <label>来源组长 <span class="required">*</span></label>
        <input class="form-input" value="${fromAdminName}" disabled>
      </div>
      <div class="form-group">
        <label>调配原因</label>
        <textarea id="transfer-reason" class="form-textarea" rows="2" placeholder="可选：调配原因说明"></textarea>
      </div>
    `;
    this.showModal('📥 调入组员', html, async () => {
      const reason = document.getElementById('transfer-reason')?.value?.trim() || '';
      const result = await API.createGroupTransfer({
        toAdminId: fromAdminId, userId, username, direction: 'in', reason
      });
      if (result?.success) {
        this.notify('调配请求已发送，等待对方组长审批');
        this.renderTeamMembers();
      } else {
        this.notify(result?.message || result?.error || '发送失败', 'error');
      }
      return true;
    });
  },

  async _approveTransfer(id) {
    const result = await API.approveGroupTransfer(id);
    if (result?.success) {
      this.notify('调配已批准，组员已转移');
      this.renderTeamMembers();
    } else {
      this.notify(result?.message || result?.error || '审批失败', 'error');
    }
  },

  async _rejectTransfer(id) {
    const result = await API.rejectGroupTransfer(id);
    if (result?.success) {
      this.notify('调配已拒绝');
      this.renderTeamMembers();
    } else {
      this.notify(result?.message || result?.error || '操作失败', 'error');
    }
  },

  async _cancelTransfer(id) {
    const result = await API.cancelGroupTransfer(id);
    if (result?.success) {
      this.notify('调配请求已取消');
      this.renderTeamMembers();
    } else {
      this.notify(result?.message || result?.error || '取消失败', 'error');
    }
  },

  _showTransferForm() {
    this.renderTeamMembers();
  },

  // ==================== REQUIREMENTS ====================
  renderRequirements() {
    const reqs = this._requirements;
    const html = `
      <div class="page-header">
        <h2>📝 需求</h2>
        <button class="btn btn-primary btn-sm" onclick="OpsApp.showAddRequirementForm()">+ 添加需求</button>
      </div>
      ${reqs.length === 0 ? '<p class="empty-text">暂无需求</p>' : ''}
      <div class="req-list">
        ${reqs.map((r, i) => `
          <div class="req-card" onclick="OpsApp.showRequirementDetail(${i})">
            <div class="req-header">
              <span class="req-title">${r.title}</span>
              <span class="req-status ${r.status || 'pending'}">${this._reqStatusLabel(r.status)}</span>
            </div>
            <div class="req-meta">
              <span>👤 ${r.requester || '-'}</span>
              <span>📅 ${r.date || '-'}</span>
              <span>🔴 ${r.priority === 'high' ? '高优先' : r.priority === 'low' ? '低优先' : '中优先'}</span>
            </div>
          </div>
        `).join('')}
      </div>
    `;
    document.getElementById('main-content').innerHTML = html;
  },

  _reqStatusLabel(s) { return { pending: '待处理', approved: '已通过', rejected: '已拒绝' }[s] || '待处理'; },

  showAddRequirementForm() {
    const html = `
      <div class="form-group">
        <label>需求标题 <span class="required">*</span></label>
        <input type="text" id="new-req-title" placeholder="输入需求标题" required>
      </div>
      <div class="form-group">
        <label>提出人</label>
        <input type="text" id="new-req-requester" placeholder="输入提出人姓名">
      </div>
      <div class="form-group">
        <label>优先级</label>
        <select id="new-req-priority">
          <option value="high">高优先</option>
          <option value="medium" selected>中优先</option>
          <option value="low">低优先</option>
        </select>
      </div>
      <div class="form-group">
        <label>状态</label>
        <select id="new-req-status">
          <option value="pending" selected>待处理</option>
          <option value="approved">已通过</option>
          <option value="rejected">已拒绝</option>
        </select>
      </div>
    `;
    this.showModal('添加需求', html, () => {
      const title = document.getElementById('new-req-title')?.value.trim();
      if (!title) { this.notify('请输入需求标题', 'warning'); return false; }
      this._requirements.unshift({
        id: 'r' + Date.now(),
        title: title,
        requester: document.getElementById('new-req-requester')?.value.trim() || '-',
        priority: document.getElementById('new-req-priority')?.value || 'medium',
        status: document.getElementById('new-req-status')?.value || 'pending',
        date: new Date().toLocaleDateString('zh-CN'),
      });
      this._saveRequirements();
      this.renderRequirements();
      this.notify('需求已添加');
      return true;
    });
  },

  showRequirementDetail(index) {
    const r = this._requirements[index];
    if (!r) return;
    const html = `
      <div style="display:flex;flex-direction:column;gap:14px;">
        <div class="form-group"><label>标题</label><input type="text" id="detail-req-title" value="${r.title}"></div>
        <div class="form-group"><label>提出人</label><input type="text" id="detail-req-requester" value="${r.requester || ''}"></div>
        <div class="form-group">
          <label>优先级</label>
          <select id="detail-req-priority">
            <option value="high" ${r.priority === 'high' ? 'selected' : ''}>高优先</option>
            <option value="medium" ${r.priority === 'medium' ? 'selected' : ''}>中优先</option>
            <option value="low" ${r.priority === 'low' ? 'selected' : ''}>低优先</option>
          </select>
        </div>
        <div class="form-group">
          <label>状态</label>
          <select id="detail-req-status">
            <option value="pending" ${r.status === 'pending' ? 'selected' : ''}>待处理</option>
            <option value="approved" ${r.status === 'approved' ? 'selected' : ''}>已通过</option>
            <option value="rejected" ${r.status === 'rejected' ? 'selected' : ''}>已拒绝</option>
          </select>
        </div>
      </div>
    `;
    this.showModal('需求详情', html, () => {
      r.title = document.getElementById('detail-req-title')?.value.trim() || r.title;
      r.requester = document.getElementById('detail-req-requester')?.value.trim() || '';
      r.priority = document.getElementById('detail-req-priority')?.value || 'medium';
      r.status = document.getElementById('detail-req-status')?.value || 'pending';
      this._saveRequirements();
      this.renderRequirements();
      this.notify('需求已更新');
      return true;
    });
  },

  // ==================== USER MANAGEMENT ====================
  _updateUserManagementNav() {
    const user = API.currentUser;
    const navGroup = document.getElementById('nav-group-user-management');
    if (navGroup) {
      // Show user management nav only for admin or superadmin
      navGroup.style.display = (user && (user.role === 'admin' || user.role === 'superadmin')) ? '' : 'none';
    }
  },

  async renderUserManagement() {
    const user = API.currentUser;
    if (!user || (user.role !== 'admin' && user.role !== 'superadmin')) {
      document.getElementById('main-content').innerHTML = '<p class="empty-text">无权限访问</p>';
      return;
    }

    let users = [];
    try {
      users = await API.getUsers();
    } catch {}

    const isSuper = user.role === 'superadmin';
    const onlineCount = users.filter(u => u.online).length;
    const offlineCount = users.filter(u => !u.online).length;

    const html = `
      <div class="page-header">
        <h2>👥 账户管理</h2>
        <div style="display:flex;gap:8px;align-items:center;">
          <select id="um-status-filter" onchange="OpsApp._filterUserTable()" style="padding:6px 10px;border:1px solid var(--border-color);border-radius:6px;font-size:0.8rem;">
            <option value="all">全部 (${users.length})</option>
            <option value="online">🟢 在线 (${onlineCount})</option>
            <option value="offline">⚫ 离线 (${offlineCount})</option>
          </select>
          <button class="btn btn-primary btn-sm" onclick="OpsApp.showAddUserForm()">+ 创建账户</button>
        </div>
      </div>
      <div class="ops-card">
        <table class="um-table" id="um-user-table">
          <thead>
            <tr>
              <th>用户名</th>
              <th>账号</th>
              <th>系统</th>
              <th>角色</th>
              <th>状态</th>
              <th>创建时间</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            ${users.map(u => {
              const roleMap = { superadmin: '超级管理员', admin: '管理员', user: '普通用户' };
              const sysMap = { maintenance: '运维', operations: '运营' };
              const isSelf = u.id === user.id;
              const dname = u.displayName || u.username;
              const sysName = sysMap[u.system] || u.system || '运维';
              return '<tr data-user-status="' + (u.online ? 'online' : 'offline') + '">'
                + '<td><strong>' + dname + '</strong>' + (isSelf ? ' <span style="color:var(--text-tertiary);font-size:0.75rem;">(我)</span>' : '') + '</td>'
                + '<td style="font-size:0.8rem;color:var(--text-secondary);">' + (u.username || '-') + '</td>'
                + '<td><span class="um-sys-badge um-sys-' + (u.system || 'maintenance') + '">' + sysName + '</span></td>'
                + '<td><span class="um-role-badge um-role-' + u.role + '">' + (roleMap[u.role] || u.role) + '</span></td>'
                + '<td><span class="um-status-dot ' + (u.online ? 'online' : 'offline') + '"></span> ' + (u.online ? '在线' : '离线') + '</td>'
                + '<td style="font-size:0.8rem;color:var(--text-secondary);">' + (u.createdAt ? new Date(u.createdAt).toLocaleDateString('zh-CN') : '-') + '</td>'
                + '<td class="um-actions">'
                + (isSuper && u.role !== 'superadmin' ? '<button class="btn btn-xs btn-outline" onclick="OpsApp.doPromoteUser(\'' + u.id + '\', \'' + u.username + '\', \'' + u.role + '\')">' + (u.role === 'admin' ? '降级为用户' : '晋升为管理员') + '</button>' : '')
                + (!isSelf && u.role !== 'superadmin' && (isSuper || u.role === 'user') ? '<button class="btn btn-xs btn-outline" onclick="OpsApp.showResetPasswordForm(\'' + u.id + '\', \'' + (u.displayName || u.username) + '\')" title="重置密码" style="color:var(--color-warning,#f59e0b);">🔑 密码</button>' : '')
                + (!isSelf && u.role !== 'superadmin' ? '<button class="btn btn-xs btn-danger" onclick="OpsApp.doDeleteUser(\'' + u.id + '\', \'' + u.username + '\')">删除</button>' : '')
                + '</td>'
                + '</tr>';
            }).join('')}
          </tbody>
        </table>
      </div>
    `;
    document.getElementById('main-content').innerHTML = html;
  },

  _filterUserTable() {
    const sel = document.getElementById('um-status-filter');
    if (!sel) return;
    const val = sel.value;
    const rows = document.querySelectorAll('#um-user-table tbody tr');
    rows.forEach(row => {
      if (val === 'all') { row.style.display = ''; }
      else { row.style.display = row.getAttribute('data-user-status') === val ? '' : 'none'; }
    });
  },

  showAddUserForm() {
    const html = `
      <div class="form-group">
        <label>中文名 <span class="required">*</span></label>
        <input type="text" id="new-user-displayname" placeholder="输入中文姓名（用于显示）" required>
      </div>
      <div class="form-group">
        <label>用户名 <span class="required">*</span></label>
        <input type="text" id="new-user-username" placeholder="输入登录用户名" required>
      </div>
      <div class="form-group">
        <label>密码 <span class="required">*</span></label>
        <input type="password" id="new-user-password" placeholder="输入密码" required>
      </div>
    `;
    this.showModal('创建新账户', html, async () => {
      const displayName = document.getElementById('new-user-displayname')?.value.trim();
      const username = document.getElementById('new-user-username')?.value.trim();
      const password = document.getElementById('new-user-password')?.value.trim();
      if (!displayName) { this.notify('请输入中文名', 'warning'); return false; }
      if (!username || !password) { this.notify('请填写用户名和密码', 'warning'); return false; }
      if (password.length < 4) { this.notify('密码至少4个字符', 'warning'); return false; }
      const result = await API.addUser({ username, password, role: 'user', system: 'operations', displayName });
      if (result && result.success) {
        this.notify(`${displayName} 账户创建成功`);
        this.renderUserManagement();
        return true;
      } else {
        this.notify(result?.error || result?.message || '创建失败', 'error');
        return false;
      }
    });
  },

  async doPromoteUser(userId, username, currentRole) {
    const action = currentRole === 'admin' ? '降级为普通用户' : '晋升为管理员';
    if (!confirm('确认将 ' + username + ' ' + action + '？')) return;
    const result = await API.promoteUser(userId);
    if (result && result.success) {
      this.notify(result.message || '操作成功');
      this.renderUserManagement();
    } else {
      this.notify(result?.error || result?.message || '操作失败', 'error');
    }
  },

  async doDeleteUser(userId, username) {
    if (!confirm('确认删除用户 ' + username + '？此操作不可撤销。')) return;
    const result = await API.deleteUser(userId);
    if (result && result.success) {
      this.notify('用户已删除');
      this.renderUserManagement();
    } else {
      this.notify(result?.error || result?.message || '删除失败', 'error');
    }
  },

  // ==================== RESET USER PASSWORD ====================
  showResetPasswordForm(userId, displayName) {
    const user = API.currentUser;
    const html = `
      <div class="form-group">
        <label>目标用户</label>
        <input type="text" value="${displayName}" disabled style="width:100%;padding:8px;background:var(--bg-secondary,#f8f9fb);border:1px solid var(--border-color);border-radius:8px;">
      </div>
      <div class="form-group">
        <label>新密码 <span class="required">*</span></label>
        <input type="password" id="reset-pwd-new" placeholder="输入新密码（至少4个字符）" required minlength="4">
      </div>
      <div class="form-group">
        <label>确认新密码 <span class="required">*</span></label>
        <input type="password" id="reset-pwd-confirm" placeholder="再次输入新密码" required minlength="4">
      </div>
      <p style="font-size:0.78rem;color:var(--text-tertiary);">💡 重置后该用户需使用新密码重新登录</p>
    `;
    this.showModal('🔑 重置密码 — ' + displayName, html, async () => {
      const newPw = document.getElementById('reset-pwd-new')?.value;
      const confirmPw = document.getElementById('reset-pwd-confirm')?.value;
      if (!newPw || !confirmPw) { this.notify('请填写新密码和确认密码', 'warning'); return false; }
      if (newPw !== confirmPw) { this.notify('两次输入的新密码不一致', 'warning'); return false; }
      if (newPw.length < 4) { this.notify('新密码至少4个字符', 'warning'); return false; }
      return await this.doResetPassword(userId, displayName, newPw);
    });
  },

  async doResetPassword(userId, displayName, newPassword) {
    const result = await API.resetPassword(userId, newPassword);
    if (result && result.success) {
      this.notify(displayName + ' 的密码已重置');
      this.renderUserManagement();
      return true;
    } else {
      this.notify(result?.error || result?.message || '重置失败', 'error');
      return false;
    }
  },

  // ==================== DURATION FORMATTER ====================
  _fmtDuration(seconds) {
    if (seconds == null) return '-';
    const s = Math.round(seconds);
    if (s < 60) return '<1分钟';
    const m = Math.round(s / 60);
    if (m < 60) return m + '分钟';
    const h = Math.floor(m / 60);
    const rm = m % 60;
    return rm > 0 ? h + '时' + rm + '分' : h + '小时';
  },

  // ==================== POPUP MODAL HELPER ====================
  _showPopupModal(title, message, onClose) {
    const overlay = document.getElementById('modal-overlay');
    const body = document.getElementById('modal-body');
    const titleEl = document.getElementById('modal-title');
    const saveBtn = document.getElementById('modal-save');
    const closeBtn = document.getElementById('modal-close-btn');
    titleEl.textContent = title;
    body.innerHTML = `<div style="text-align:center;padding:20px 10px;">
      <div style="font-size:3rem;margin-bottom:16px;">🎊</div>
      <p style="font-size:1.05rem;line-height:1.6;color:var(--text-primary);font-weight:500;">${message}</p>
    </div>`;
    overlay.style.display = 'flex';
    saveBtn.style.display = 'none';
    if (closeBtn) closeBtn.textContent = '好的';
    const close = () => {
      overlay.style.display = 'none';
      if (closeBtn) closeBtn.textContent = '取消';
      if (typeof onClose === 'function') onClose();
    };
    document.getElementById('modal-close').onclick = close;
    if (closeBtn) closeBtn.onclick = close;
    overlay.onclick = (e) => { if (e.target === overlay) close(); };
  },

  // Layered popup: top=funny sentence, bottom=input field (for repair completion)
  _showLayeredPopup(title, message, inputPlaceholder, onSubmit) {
    const overlay = document.getElementById('modal-overlay');
    const body = document.getElementById('modal-body');
    const titleEl = document.getElementById('modal-title');
    const saveBtn = document.getElementById('modal-save');
    const closeBtn = document.getElementById('modal-close-btn');
    titleEl.textContent = title;
    body.innerHTML = `
      <div style="display:flex;flex-direction:column;gap:16px;">
        <div style="text-align:center;padding:16px 10px;background:var(--bg-secondary,#f8f9fb);border-radius:var(--radius-lg,14px);border:1px solid var(--border-light,#f3f4f6);">
          <div style="font-size:2.5rem;margin-bottom:10px;">🎊</div>
          <p style="font-size:1rem;line-height:1.6;color:var(--text-primary);font-weight:500;margin:0;">${message}</p>
        </div>
        <div>
          <label style="display:block;font-size:.78rem;font-weight:600;color:var(--text-secondary);margin-bottom:6px;">维修结果说明</label>
          <textarea id="layered-popup-input" class="ts-form-textarea" rows="3" placeholder="${inputPlaceholder || '请输入维修结果...'}" style="width:100%;"></textarea>
        </div>
      </div>`;
    overlay.style.display = 'flex';
    saveBtn.style.display = '';
    saveBtn.textContent = '确认完成';
    if (closeBtn) closeBtn.textContent = '取消';
    const close = () => {
      overlay.style.display = 'none';
      saveBtn.textContent = '确认';
      if (closeBtn) closeBtn.textContent = '取消';
    };
    saveBtn.onclick = () => {
      const val = document.getElementById('layered-popup-input')?.value?.trim() || '';
      close();
      if (typeof onSubmit === 'function') onSubmit(val);
    };
    document.getElementById('modal-close').onclick = close;
    if (closeBtn) closeBtn.onclick = close;
    overlay.onclick = (e) => { if (e.target === overlay) close(); };
  },

  // ==================== POPUP MESSAGE MANAGEMENT ====================
  async renderPopupMessages() {
    const user = API.currentUser;
    if (!user || (user.role !== 'admin' && user.role !== 'superadmin')) {
      document.getElementById('main-content').innerHTML = '<p class="empty-text">无权限访问</p>';
      return;
    }
    let submitMsgs = [], completeMsgs = [];
    try {
      submitMsgs = await API.getPopupMessages('submit');
      completeMsgs = await API.getPopupMessages('complete');
    } catch {}

    const renderList = (msgs, cat) => msgs.map(m => `<div class="pm-item">
      <span class="pm-text">${m.text}</span>
      <button class="btn btn-xs btn-danger" onclick="OpsApp.doDeletePopupMessage('${m.id}','${cat}')">✕</button>
    </div>`).join('');

    document.getElementById('main-content').innerHTML = `<div class="page-header"><h2>💬 弹窗句子管理</h2><span style="color:var(--text-secondary);font-size:0.85rem;">管理提交成功和维修完成后的鼓励性消息</span></div>
    <div class="ts-detail-card"><h3>📩 提交后弹窗句子 (${submitMsgs.length}条)</h3>
      <div class="pm-add-row">
        <input type="text" id="pm-new-submit" class="ts-form-input" placeholder="输入新的提交后鼓励语..." style="flex:1;">
        <button class="btn btn-primary btn-sm" onclick="OpsApp.doAddPopupMessage('submit')">添加</button>
      </div>
      <div class="pm-list">${renderList(submitMsgs, 'submit') || '<p class="empty-text">暂无句子</p>'}</div>
    </div>
    <div class="ts-detail-card"><h3>✅ 维修完成弹窗句子 (${completeMsgs.length}条)</h3>
      <div class="pm-add-row">
        <input type="text" id="pm-new-complete" class="ts-form-input" placeholder="输入新的维修完成鼓励语..." style="flex:1;">
        <button class="btn btn-primary btn-sm" onclick="OpsApp.doAddPopupMessage('complete')">添加</button>
      </div>
      <div class="pm-list">${renderList(completeMsgs, 'complete') || '<p class="empty-text">暂无句子</p>'}</div>
    </div>`;
  },

  async doAddPopupMessage(category) {
    const inputId = category === 'submit' ? 'pm-new-submit' : 'pm-new-complete';
    const input = document.getElementById(inputId);
    const text = input?.value?.trim();
    if (!text) { this.notify('请输入句子内容', 'warning'); return; }
    const result = await API.addPopupMessage(category, text);
    if (result && result.success) {
      this.notify('句子已添加');
      this.renderPopupMessages();
    } else {
      this.notify(result?.error || result?.message || '添加失败', 'error');
    }
  },

  async doDeletePopupMessage(id, category) {
    if (!confirm('确认删除此句子？')) return;
    const result = await API.deletePopupMessage(id);
    if (result && result.success) {
      this.notify('句子已删除');
      this.renderPopupMessages();
    } else {
      this.notify(result?.error || result?.message || '删除失败', 'error');
    }
  },

  // ==================== TECH SUPPORT ====================
  _updateTechSupportNav() {
    const user = API.currentUser;
    const navGroup = document.getElementById('nav-group-tech-support');
    if (navGroup) {
      // Show tech support group for ALL operations users
      navGroup.style.display = user ? '' : 'none';
    }
    // Regular users can only submit; admin/leader can see maintenance log
    const logBtn = document.getElementById('nav-tech-support-log');
    if (logBtn) {
      const isLeader = user && (user.role === 'admin' || user.role === 'superadmin');
      logBtn.style.display = isLeader ? '' : 'none';
    }
  },

  async renderTechSupportSubmit() {
    let equipmentList = [], machinesList = [];
    try {
      const eq = await API.getEquipmentConfig(); if (Array.isArray(eq)) equipmentList = eq;
      machinesList = await API.getMachines(); if (!Array.isArray(machinesList)) machinesList = [];
    } catch {}
    const machineNumbers = [...new Set(machinesList.map(m => m.machineNumber || m.id).filter(Boolean))];
    const faultTypes = ['闪退异常','无法启动','连接失败','硬件损坏','数据异常','其他'];
    this._tsAllMachines = machineNumbers;

    document.getElementById('main-content').innerHTML = `<div class="page-header"><h2>📩 提交技术支持请求</h2><span style="color:var(--text-secondary);font-size:0.85rem;">设备故障时提交请求，运维人员将尽快处理</span></div>
    <div class="ts-detail-page">
      <div class="ts-detail-card"><h3>📤 设备信息</h3>
        <div class="ts-form-group">
          <label class="ts-form-label">故障设备类型 <span class="req">*</span></label>
          <select id="ts-equipment-type" class="ts-form-select"><option value="">-- 请选择故障设备 --</option>${equipmentList.map(e => `<option value="${e.id}" data-name="${(e.name||e.id).replace(/"/g,'&quot;')}">${e.icon||'📦'} ${e.name||e.id}</option>`).join('')}</select>
        </div>
        <div class="ts-form-group" style="position:relative;">
          <label class="ts-form-label">设备编号 <span class="req">*</span></label>
          <input type="text" id="ts-machine-filter" class="ts-form-input" placeholder="输入编号搜索或从下方选择..." autocomplete="off" oninput="OpsApp._filterMachineList()" onfocus="OpsApp._filterMachineList()">
          <select id="ts-machine-id" class="ts-form-select" size="5" style="display:none;position:absolute;z-index:100;width:100%;margin-top:2px;" onchange="OpsApp._onMachineSelect()">${machineNumbers.map(m => `<option value="${m}">${m}</option>`).join('')}</select>
          <div class="ts-form-hint" id="ts-machine-count">共 ${machineNumbers.length} 台设备可选</div>
        </div>
      </div>
      <div class="ts-detail-card"><h3>🔧 故障详情</h3>
        <div class="ts-form-group">
          <label class="ts-form-label">故障现象 <span class="req">*</span></label>
          <select id="ts-fault-type" class="ts-form-select"><option value="">-- 请选择故障现象 --</option>${faultTypes.map(f => `<option value="${f}">${f}</option>`).join('')}</select>
        </div>
        <div class="ts-form-group">
          <label class="ts-form-label">故障说明</label>
          <textarea id="ts-fault-description" class="ts-form-textarea" rows="4" placeholder="请详细描述故障现象，包括发生时间、操作过程、已尝试的方法等..."></textarea>
          <div class="ts-form-hint">提供越详细的信息，运维人员越能快速定位问题</div>
        </div>
      </div>
      <div class="ts-action-bar">
        <button class="btn btn-primary" id="ts-submit-btn" onclick="OpsApp.doSubmitTechSupport()" style="min-width:160px;padding:12px 28px;font-size:.9rem;">📤 确认提交</button>
      </div>
    </div>`;
  },

  // Filter machine dropdown based on input text
  _filterMachineList() {
    const input = document.getElementById('ts-machine-filter');
    const select = document.getElementById('ts-machine-id');
    const count = document.getElementById('ts-machine-count');
    if (!input || !select) return;

    const filter = input.value.toLowerCase().trim();
    const allMachines = this._tsAllMachines || [];

    let filtered = allMachines;
    if (filter) {
      filtered = allMachines.filter(m => m.toLowerCase().includes(filter));
    }

    select.innerHTML = filtered.map(m => `<option value="${m}">${m}</option>`).join('');
    if (count) count.textContent = filter
      ? `匹配 ${filtered.length} 台设备（共 ${allMachines.length} 台）`
      : `共 ${allMachines.length} 台设备`;

    // Show/hide dropdown
    select.style.display = filtered.length > 0 ? 'block' : 'none';
    // Limit visible options
    select.size = Math.min(filtered.length, 8);
  },

  // When user clicks a machine in dropdown, fill the input
  _onMachineSelect() {
    const select = document.getElementById('ts-machine-id');
    const input = document.getElementById('ts-machine-filter');
    if (select && input) {
      input.value = select.value;
      select.style.display = 'none';
    }
  },

  // Hide machine dropdown when clicking outside
  _onTsEquipChange() {
    // Just a placeholder for future equipment-type-dependent filtering
  },

  async doSubmitTechSupport() {
    const equipmentType = document.getElementById('ts-equipment-type')?.value;
    const inputEl = document.getElementById('ts-machine-filter');
    const selectEl = document.getElementById('ts-machine-id');
    const machineId = (inputEl?.value?.trim()) || (selectEl?.value);
    const faultType = document.getElementById('ts-fault-type')?.value;
    const faultDescription = document.getElementById('ts-fault-description')?.value.trim() || '';

    if (!equipmentType || !machineId || !faultType) {
      this.notify('请填写所有必填字段（设备类型、设备编号、故障现象）', 'warning');
      return;
    }
    const validMachines = this._tsAllMachines || [];
    if (validMachines.length > 0 && !validMachines.includes(machineId)) {
      this.notify(`设备编号 "${machineId}" 不存在，请从列表中选择`, 'warning');
      return;
    }

    const sel = document.getElementById('ts-equipment-type');
    const selectedOpt = sel ? sel.options[sel.selectedIndex] : null;
    const equipmentTypeName = selectedOpt?.dataset?.name || selectedOpt?.text?.replace(/[^\u4e00-\u9fa5a-zA-Z0-9\s_-]/g, '').trim() || equipmentType;

    const btn = document.getElementById('ts-submit-btn');
    if (btn) { btn.disabled = true; btn.textContent = '⏳ 提交中...'; }

    // Safety timeout: force re-enable button after 12s no matter what
    const safetyTimer = setTimeout(() => {
      if (btn && btn.disabled) {
        btn.disabled = false;
        btn.textContent = '📤 确认提交';
        this.notify('提交超时，请检查网络后重试', 'error');
      }
    }, 12000);

    let success = false;
    try {
      const result = await API.submitTechSupport({
        equipmentType, equipmentTypeName,
        machineId, machineNumber: machineId,
        faultType, faultDescription,
      });
      if (result && result.success) {
        success = true;
        // Show random encouragement popup with return button
        const popup = await API.getRandomPopupMessage('submit');
        this._showPopupModal('🎉 提交成功', popup.text || '请求已提交！', () => {
          this.switchTab('tech-support-submit');
        });
      } else {
        this.notify(result?.message || result?.error || '提交失败', 'error');
      }
    } catch (e) {
      this.notify('网络错误，请重试', 'error');
    } finally {
      clearTimeout(safetyTimer);
      if (!success && btn) {
        btn.disabled = false;
        btn.textContent = '📤 确认提交';
      }
    }
  },

  async renderTechSupportMy(viewMode) {
    if (!viewMode) viewMode = this._tsViewMode || 'card';
    this._tsViewMode = viewMode;
    let items = [];
    try { items = await API.getTechSupportList(); } catch {}
    const SM = { pending:{l:'待响应',c:'ts-status-pending',icon:'🕐'}, responded:{l:'处理中',c:'ts-status-responded',icon:'🔧'}, completed:{l:'已完成',c:'ts-status-completed',icon:'✅'} };
    const fm = t => t ? new Date(t).toLocaleString('zh-CN') : '-';

    const counts = { all: items.length, pending: 0, responded: 0, completed: 0 };
    items.forEach(i => { if (counts[i.status] !== undefined) counts[i.status]++; });

    const statsHtml = `<div class="ts-stats-row">
      <div class="ts-stat-card total"><div class="ts-stat-icon">📋</div><div class="ts-stat-content"><div class="ts-stat-value">${counts.all}</div><div class="ts-stat-label">总记录</div></div></div>
      <div class="ts-stat-card pending"><div class="ts-stat-icon">🕐</div><div class="ts-stat-content"><div class="ts-stat-value">${counts.pending}</div><div class="ts-stat-label">待响应</div></div></div>
      <div class="ts-stat-card responded"><div class="ts-stat-icon">🔧</div><div class="ts-stat-content"><div class="ts-stat-value">${counts.responded}</div><div class="ts-stat-label">处理中</div></div></div>
      <div class="ts-stat-card completed"><div class="ts-stat-icon">✅</div><div class="ts-stat-content"><div class="ts-stat-value">${counts.completed}</div><div class="ts-stat-label">已完成</div></div></div>
    </div>`;

    const emptyHtml = `<div class="ts-empty"><div class="ts-empty-icon">📋</div><div class="ts-empty-text">暂无维修记录</div><div class="ts-empty-sub">提交技术支持请求后，记录将显示在此处</div></div>`;

    const toolbar = `<div class="ts-toolbar" style="justify-content:flex-end;">
      <div style="display:flex;gap:6px;">
        <button class="btn btn-sm ${viewMode==='card'?'btn-primary':'btn-outline'}" onclick="OpsApp.renderTechSupportMy('card')">🃏 卡片</button>
        <button class="btn btn-sm ${viewMode==='table'?'btn-primary':'btn-outline'}" onclick="OpsApp.renderTechSupportMy('table')">📋 表格</button>
        <button class="btn btn-sm btn-success" onclick="OpsApp.exportTechSupportXLSX()">📥 导出</button>
      </div>
    </div>`;

    let body;
    if (viewMode === 'table') {
      body = `<div class="ts-table-wrap"><table class="ts-log-table"><thead><tr>
        <th>设备编号</th><th>故障设备</th><th>故障现象</th><th>提交时间</th><th>状态</th><th>维修人员</th><th>响应时间</th><th>恢复时间</th><th>总时长</th>
      </tr></thead><tbody>
        ${items.length===0?`<tr><td colspan="9">${emptyHtml}</td></tr>`:''}
        ${items.map(item => { const s=SM[item.status]||SM.pending;
          return `<tr class="ts-row-clickable" onclick="OpsApp.showTechSupportDetail('${item.id}')">
            <td><strong>${item.machineNumber||'-'}</strong></td><td>${item.equipmentTypeName||item.equipmentType||'-'}</td>
            <td>${item.faultType||'-'}</td><td style="font-size:0.8rem;white-space:nowrap;">${fm(item.submittedAt)}</td>
            <td><span class="ts-status-badge ${s.c}">${s.icon} ${s.l}</span></td><td>${item.responderName||'-'}</td>
            <td style="font-size:0.8rem;white-space:nowrap;">${fm(item.respondedAt)}</td>
            <td style="font-size:0.8rem;white-space:nowrap;">${fm(item.completedAt)}</td><td>${this._fmtDuration(item.totalSeconds)}</td>
          </tr>`; }).join('')}
      </tbody></table></div>`;
    } else {
      body = `<div class="ts-list">
        ${items.length===0?emptyHtml:''}
        ${items.map(item => { const s=SM[item.status]||SM.pending;
          return `<div class="ts-card ${item.status}" onclick="OpsApp.showTechSupportDetail('${item.id}')">
            <div class="ts-card-icon">${s.icon}</div>
            <div class="ts-card-title">${item.machineNumber||item.machineId}</div>
            <div class="ts-card-sub">${item.equipmentTypeName||item.equipmentType}  ·  ${item.faultType||'-'}</div>
            <div class="ts-card-footer">
              <span>🕐 ${fm(item.submittedAt)}</span>
              ${item.responderName?`<span>🔧 ${item.responderName}</span>`:''}
              ${item.totalSeconds!=null?`<span>⏱ ${this._fmtDuration(item.totalSeconds)}</span>`:''}
              <span style="margin-left:auto;"><span class="ts-status-badge ${s.c}">${s.l}</span></span>
            </div>
          </div>`; }).join('')}
      </div>`;
    }

    document.getElementById('main-content').innerHTML = `<div class="page-header"><h2>📋 维修日志</h2><span style="color:var(--text-secondary);font-size:0.85rem;">${items.length} 条记录</span></div>${statsHtml}${toolbar}${body}`;
  },

  exportTechSupportXLSX() {
    const today = new Date().toISOString().slice(0, 10);
    const html = `
      <div style="padding:16px;">
        <div class="form-group"><label>📅 日期（留空=全部）</label><input type="date" id="ts-export-date" style="width:100%;padding:8px;"></div>
        <div style="display:flex;gap:8px;margin-top:12px;">
          <div class="form-group" style="flex:1;"><label>🕖 开始时间</label><input type="time" id="ts-export-start" value="07:00" style="width:100%;padding:8px;"></div>
          <div class="form-group" style="flex:1;"><label>🕐 结束时间</label><input type="time" id="ts-export-end" value="02:00" style="width:100%;padding:8px;"></div>
        </div>
        <div style="margin-top:4px;font-size:0.75rem;color:var(--text-secondary);">
          💡 全留空=导出全部 | 日期+时间=精确筛选
        </div>
        <div style="display:flex;gap:8px;margin-top:16px;">
          <button class="btn btn-primary" onclick="OpsApp._doExportTS()" style="flex:1;">📥 导出</button>
          <button class="btn btn-outline" onclick="OpsApp.closeModal()">取消</button>
        </div>
      </div>`;
    this.showModal('📊 导出维修日志', html, () => false);
    // Hide modal save button — export has its own button
    const saveBtn = document.getElementById('modal-save');
    if (saveBtn) saveBtn.style.display = 'none';
  },

  async _doExportTS() {
    try {
      this.closeModal();
      const token = API.token;
      if (!token) { this.notify('请先登录', 'warning'); return; }
      const params = new URLSearchParams();
      const dateVal = document.getElementById('ts-export-date')?.value;
      const startVal = document.getElementById('ts-export-start')?.value;
      const endVal = document.getElementById('ts-export-end')?.value;
      if (dateVal) params.set('date', dateVal);
      if (startVal) params.set('startTime', startVal);
      if (endVal) params.set('endTime', endVal);
      const qs = params.toString();
      const url = API.baseURL + '/api/export/tech-support-xlsx' + (qs ? '?' + qs : '');
      const res = await fetch(url, { headers: { 'Authorization': 'Bearer ' + token } });
      if (!res.ok) { this.notify('导出失败', 'error'); return; }
      const blob = await res.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = '维修日志-' + (dateVal || '全部') + '.xlsx';
      a.click();
      this.notify('导出成功');
    } catch(e) { this.notify('导出失败: ' + e.message, 'error'); }
  },

  async showTechSupportDetail(id) {
    let item;
    try { item = await API.getTechSupportDetail(id); } catch {}
    if (!item) { this.notify('无法获取请求详情', 'error'); return; }
    const SM = { pending:{l:'待响应',c:'ts-status-pending'}, responded:{l:'处理中',c:'ts-status-responded'}, completed:{l:'已完成',c:'ts-status-completed'} };
    const s = SM[item.status]||SM.pending;
    const fm = t => t ? new Date(t).toLocaleString('zh-CN') : '-';

    // Build progress timeline
    const steps = [
      { label:'提交', icon:'📤', done: true, time: item.submittedAt },
      { label:'响应', icon:'🔧', done: item.status==='responded'||item.status==='completed', active: item.status==='pending', time: item.respondedAt },
      { label:'完成', icon:'✅', done: item.status==='completed', active: item.status==='responded', time: item.completedAt },
    ];
    const progressHtml = `<div class="ts-progress-track">${steps.map(st => {
      const cls = st.done ? 'done' : st.active ? 'active' : 'pending';
      return `<div class="ts-progress-step ${cls}"><div class="ts-progress-dot">${st.icon}</div><div class="ts-progress-label">${st.label}</div>${st.time?`<div class="ts-progress-time">${fm(st.time)}</div>`:''}</div>`;
    }).join('')}</div>`;

    const html = `${progressHtml}
    <div class="ts-detail-card" style="margin-bottom:12px;"><h3>📤 请求信息</h3>
      <div class="ts-detail-grid">
        <div class="ts-detail-field"><span class="lbl">状态</span><span class="val"><span class="ts-status-badge ${s.c}">${s.l}</span></span></div>
        <div class="ts-detail-field"><span class="lbl">故障设备</span><span class="val">${item.equipmentTypeName||item.equipmentType||'-'}</span></div>
        <div class="ts-detail-field"><span class="lbl">设备编号</span><span class="val">${item.machineNumber||item.machineId||'-'}</span></div>
        <div class="ts-detail-field"><span class="lbl">故障现象</span><span class="val">${item.faultType||'-'}</span></div>
        <div class="ts-detail-field"><span class="lbl">提交人</span><span class="val">${item.submitterName||'-'}</span></div>
        <div class="ts-detail-field"><span class="lbl">提交时间</span><span class="val">${fm(item.submittedAt)}</span></div>
        <div class="ts-detail-field full"><span class="lbl">故障说明</span><span class="val">${item.faultDescription||'无'}</span></div>
      </div>
    </div>
    <div class="ts-detail-card" style="margin-bottom:12px;"><h3>🔧 处理信息</h3>
      <div class="ts-detail-grid">
        <div class="ts-detail-field"><span class="lbl">维修人员</span><span class="val">${item.responderName||'待分配'}</span></div>
        <div class="ts-detail-field"><span class="lbl">响应时间</span><span class="val">${fm(item.respondedAt)}</span></div>
        <div class="ts-detail-field"><span class="lbl">完成时间</span><span class="val">${fm(item.completedAt)}</span></div>
        ${item.result?`<div class="ts-detail-field full"><span class="lbl">维修结果</span><span class="val">${item.result}</span></div>`:''}
      </div>
    </div>
    <div class="ts-detail-card"><h3>⏱ 耗时统计</h3>
      <div class="ts-detail-grid">
        <div class="ts-detail-field"><span class="lbl">等待时长</span><span class="val">${this._fmtDuration(item.waitSeconds)}</span></div>
        <div class="ts-detail-field"><span class="lbl">维修时长</span><span class="val">${this._fmtDuration(item.repairSeconds)}</span></div>
        <div class="ts-detail-field"><span class="lbl">总耗时</span><span class="val">${this._fmtDuration(item.totalSeconds)}</span></div>
      </div>
    </div>`;
    this.showModal('🔧 维修详情', html, () => true);
    const saveBtn = document.getElementById('modal-save');
    if (saveBtn) saveBtn.style.display = 'none';
  },

  // ==================== UTILITY ====================
  updateUserDisplay() {
    const user = API.currentUser;
    const el = document.getElementById('topbar-user');
    if (!el) return;
    if (API.online && user) {
      const roleLabel = user.role === 'superadmin' ? ' (超级管理员)' : user.role === 'admin' ? ' (管理员)' : '';
      const switcherHtml = user.role === 'superadmin' ? `
        <span class="system-switcher">
          <button class="sys-btn" onclick="OpsApp.switchSystem('maintenance')" title="切换到运维系统">🔧 运维</button>
          <span class="sys-btn active">📊 运营</span>
        </span>` : '';
      el.innerHTML = switcherHtml + ' <span class="topbar-user-name">👤 ' + (user.displayName || user.username) + roleLabel + '</span>'
        + '<button class="btn btn-xs btn-outline" onclick="OpsApp.showChangePasswordForm()" style="font-size:0.7rem;" title="修改密码">🔑</button>'
        + '<button class="btn btn-xs btn-outline" onclick="OpsApp.doLogout()" style="font-size:0.7rem;">退出</button>';
    } else {
      el.innerHTML = '<span class="topbar-offline">离线模式</span>';
    }
  },

  switchSystem(system) {
    if (system === 'maintenance') {
      sessionStorage.setItem('gms_fast_switch', '1');
      window.location.href = 'index.html';
    }
  },

  // ==================== THEME ====================
  applyTheme() {
    const settings = Storage.getSettings();
    if (settings._themeManuallySet !== true) {
      settings.darkMode = window.matchMedia('(prefers-color-scheme: dark)').matches;
    }
    document.documentElement.setAttribute('data-theme', settings.darkMode ? 'dark' : 'light');
  },
  toggleTheme() {
    const settings = Storage.getSettings();
    settings.darkMode = !settings.darkMode;
    settings._themeManuallySet = true;
    Storage.saveSettings(settings);
    document.documentElement.setAttribute('data-theme', settings.darkMode ? 'dark' : 'light');
  },

  // ==================== HEALTH ====================
  updateHealthDot() {
    const dot = document.getElementById('health-dot');
    if (!dot) return;
    dot.className = 'health-dot ' + (API.online ? 'online' : 'offline');
    dot.title = API.online ? '服务器已连接' : '服务器未连接';
  },
  // ==================== STATUS BAR ====================
  async refreshStatusBar() {
    const el = document.getElementById('status-bar-info');
    if (!el) return;
    try {
      const res = await fetch(API.baseURL + '/api/status');
      if (!res.ok) throw new Error('bad status');
      const data = await res.json();
      const icons = { idle: '⚪', smooth: '🟢', busy: '🟡', full: '🔴' };
      el.textContent = icons[data.loadLevel] + ' ' + data.loadLabel + ' ' + data.onlineUsers + '人';
    } catch {
      el.textContent = '⚫ 离线';
    }
  },

  initStatusBar() {
    this.refreshStatusBar();
    setInterval(() => this.refreshStatusBar(), 5000);
  },

  startHealthCheck() {
    setInterval(async () => {
      API.online = await API._checkServer();
      this.updateHealthDot();
    }, 5000); // 每5秒检查连接状态
  },

  // ==================== AUTO REFRESH ====================
  startAutoRefresh() {
    // 5秒无感刷新：只刷新当前视图数据，不重新渲染整个页面
    if (this._autoRefreshId) clearInterval(this._autoRefreshId);
    this._autoRefreshId = setInterval(() => {
      if (!API.online) return;
      const activeEl = document.activeElement;
      if (activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA' || activeEl.tagName === 'SELECT')) return;
      this.refreshCurrentTab();
    }, 5000);
  },

  // 无感刷新当前视图 — 仅更新数据，不闪屏不打断操作
  // data-analysis(含图表)/team-members/requirements 跳过定时刷新，避免图表重绘闪烁
  refreshCurrentTab() {
    const tab = this.currentTab;
    if (tab === 'personal-analysis') {
      this.renderPersonalAnalysis();
    } else if (tab === 'task-list') {
      this.renderTaskList();
    }
    // data-analysis/team-members/requirements — 含图表或静态内容，跳过1秒刷新
  },
  async _syncFromServer() { if (API.online) await Storage._syncFromServer(); },
  async manualRefresh() {
    if (API.online) { await Storage._syncFromServer(); this.notify('数据已从服务器同步'); }
    this._loadLocalData();
    this.refreshCurrentTab();
  },

  // ==================== NOTIFICATION ====================
  notify(message, type) {
    type = type || 'success';
    const container = document.getElementById('notification-container');
    const el = document.createElement('div');
    el.className = 'notification notification-' + type;
    el.innerHTML = '<span>' + (type === 'success' ? '✓' : type === 'warning' ? '⚠' : '✗') + '</span> ' + message;
    container.appendChild(el);
    setTimeout(() => { el.classList.add('fade-out'); setTimeout(() => el.remove(), 300); }, 3000);
  },

  // ==================== MODAL ====================
  showModal(title, contentHtml, onSave) {
    const overlay = document.getElementById('modal-overlay');
    const body = document.getElementById('modal-body');
    const titleEl = document.getElementById('modal-title');
    const saveBtn = document.getElementById('modal-save');
    const closeBtn = document.getElementById('modal-close-btn');
    saveBtn.style.display = '';
    if (closeBtn) closeBtn.textContent = '取消';
    titleEl.textContent = title;
    body.innerHTML = contentHtml;
    overlay.style.display = 'flex';
    saveBtn.onclick = () => { const result = onSave(); if (result !== false) overlay.style.display = 'none'; };
    document.getElementById('modal-close').onclick = () => { overlay.style.display = 'none'; };
    if (closeBtn) closeBtn.onclick = () => { overlay.style.display = 'none'; };
    overlay.onclick = (e) => { if (e.target === overlay) overlay.style.display = 'none'; };
  },

  closeModal() {
    const overlay = document.getElementById('modal-overlay');
    if (overlay) overlay.style.display = 'none';
  },

  // ==================== CHANGE PASSWORD ====================
  showChangePasswordForm() {
    const html = `
      <div class="form-group">
        <label>旧密码 <span class="required">*</span></label>
        <input type="password" id="chpwd-old" placeholder="输入当前密码" required>
      </div>
      <div class="form-group">
        <label>新密码 <span class="required">*</span></label>
        <input type="password" id="chpwd-new" placeholder="输入新密码(不少于4个字符)" required>
      </div>
      <div class="form-group">
        <label>确认新密码 <span class="required">*</span></label>
        <input type="password" id="chpwd-confirm" placeholder="再次输入新密码" required>
      </div>
    `;
    this.showModal('修改密码', html, async () => {
      const oldPw = document.getElementById('chpwd-old')?.value;
      const newPw = document.getElementById('chpwd-new')?.value;
      const confirmPw = document.getElementById('chpwd-confirm')?.value;
      if (!oldPw || !newPw || !confirmPw) { this.notify('请填写所有字段', 'warning'); return false; }
      if (newPw !== confirmPw) { this.notify('两次新密码输入不一致', 'warning'); return false; }
      if (newPw.length < 4) { this.notify('新密码至少4个字符', 'warning'); return false; }
      const result = await this._changePassword(oldPw, newPw);
      if (result.success) { this.notify('密码修改成功'); return true; }
      else { this.notify(result.message || '修改失败', 'error'); return false; }
    });
  },

  async _changePassword(oldPassword, newPassword) {
    if (!API.online) return { success: false, message: '离线模式不支持修改密码' };
    try {
      const res = await fetch(API.baseURL + '/api/change-password', {
        method: 'POST', headers: API._headers(),
        body: JSON.stringify({ oldPassword, newPassword }),
      });
      const data = await res.json();
      return res.ok ? { success: true } : { success: false, message: data.error };
    } catch { return { success: false, message: '网络错误' }; }
  },

  // ==================== CHART HELPERS ====================
  _drawBarChart(ctx, labels, datasets) {
    const dpr = window.devicePixelRatio || 1;
    const w = ctx.canvas.offsetWidth || 400;
    const h = ctx.canvas.offsetHeight || 200;
    ctx.canvas.width = w * dpr;
    ctx.canvas.height = h * dpr;
    ctx.scale(dpr, dpr);
    const pad = { top: 16, right: 16, bottom: 30, left: 32 };
    const pw = w - pad.left - pad.right;
    const ph = h - pad.top - pad.bottom;
    ctx.clearRect(0, 0, w, h);

    const allValues = datasets.flatMap(d => d.data);
    const maxVal = Math.max(...allValues, 1);
    const barCount = labels.length;
    const barGroupWidth = pw / barCount;
    const barWidth = Math.min(barGroupWidth * 0.7 / datasets.length, 40);

    // Grid lines
    ctx.strokeStyle = '#e5e7eb';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const y = pad.top + (ph / 4) * i;
      ctx.beginPath();
      ctx.moveTo(pad.left, y);
      ctx.lineTo(w - pad.right, y);
      ctx.stroke();
      ctx.fillStyle = '#9ca3af';
      ctx.font = '10px sans-serif';
      ctx.textAlign = 'right';
      ctx.fillText(Math.round(maxVal - (maxVal / 4) * i), pad.left - 4, y + 3);
    }

    // Bars
    datasets.forEach((ds, di) => {
      ds.data.forEach((val, i) => {
        const barH = (val / maxVal) * ph;
        const x = pad.left + barGroupWidth * i + barGroupWidth * 0.15 + di * barWidth;
        const y = pad.top + ph - barH;
        ctx.fillStyle = ds.color;
        ctx.beginPath();
        ctx.roundRect(x, y, barWidth, barH, [4, 4, 0, 0]);
        ctx.fill();
      });
    });

    // Labels
    ctx.fillStyle = '#6b7280';
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'center';
    labels.forEach((l, i) => {
      ctx.fillText(l, pad.left + barGroupWidth * i + barGroupWidth / 2, h - 6);
    });
  },

  _drawLineChart(ctx, labels, datasets) {
    const dpr = window.devicePixelRatio || 1;
    const w = ctx.canvas.offsetWidth || 400;
    const h = ctx.canvas.offsetHeight || 200;
    ctx.canvas.width = w * dpr;
    ctx.canvas.height = h * dpr;
    ctx.scale(dpr, dpr);
    const pad = { top: 16, right: 16, bottom: 30, left: 32 };
    const pw = w - pad.left - pad.right;
    const ph = h - pad.top - pad.bottom;
    ctx.clearRect(0, 0, w, h);

    const allValues = datasets.flatMap(d => d.data);
    const maxVal = Math.max(...allValues, 1);

    // Grid
    ctx.strokeStyle = '#e5e7eb';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const y = pad.top + (ph / 4) * i;
      ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(w - pad.right, y); ctx.stroke();
      ctx.fillStyle = '#9ca3af';
      ctx.font = '10px sans-serif';
      ctx.textAlign = 'right';
      ctx.fillText(Math.round(maxVal - (maxVal / 4) * i), pad.left - 4, y + 3);
    }

    // Lines
    datasets.forEach(ds => {
      ctx.strokeStyle = ds.color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ds.data.forEach((val, i) => {
        const x = pad.left + (pw / (ds.data.length - 1 || 1)) * i;
        const y = pad.top + ph - (val / maxVal) * ph;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      });
      ctx.stroke();

      // Dots
      ds.data.forEach((val, i) => {
        const x = pad.left + (pw / (ds.data.length - 1 || 1)) * i;
        const y = pad.top + ph - (val / maxVal) * ph;
        ctx.fillStyle = ds.color;
        ctx.beginPath(); ctx.arc(x, y, 3, 0, Math.PI * 2); ctx.fill();
      });
    });

    // Labels
    ctx.fillStyle = '#6b7280';
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'center';
    labels.forEach((l, i) => {
      ctx.fillText(l, pad.left + (pw / (labels.length - 1 || 1)) * i, h - 6);
    });
  },
};
