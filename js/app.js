
/**
 * Main Application Logic
 * 手套/灵巧手/夹爪库存与机器管理系统
 */
const App = {
  currentTab: 'dashboard',
  currentPage: { transactions: 1 },
  pageSize: 15,
  _txViewMode: 'card',
  _repairResultHistory: [],  // 维修结果记忆历史
  filters: {
    equipmentType: 'all',
    direction: 'all',
    dateFrom: '',
    dateTo: '',
    search: '',
  },
  chartInstances: {},

  // ==================== INITIALIZATION ====================
  async init() {
    this.applyTheme();
    this.bindNavigation();
    this.bindGlobalEvents();
    this.bindKeyboardShortcuts();

    // Show a loading indicator while connecting
    document.getElementById('main-content').innerHTML = '<div style="text-align:center;padding:100px 20px;"><p style="font-size:2rem;">⏳</p><p style="color:var(--text-secondary);">正在连接服务器...</p></div>';
    // Try connecting to server
    const online = await API.init();
    if (!API.currentUser) {
      this.showLogin(online ? '' : '离线模式 — 检查网络连接后刷新页面重试');
    } else {
      // Redirect operations users to their system
      const userSystem = API.currentUser.system || 'maintenance';
      if (userSystem === 'operations') {
        window.location.replace('operations.html');
        return;
      }
      if (online) {
        await Storage._fullSyncFromServer();
      }
      document.body.classList.add('logged-in');
      document.body.classList.remove('login-mode');
      // Restore sidebar and topbar visibility
      const sidebar = document.querySelector('.sidebar');
      if (sidebar) sidebar.style.display = '';
      const topbar = document.querySelector('.topbar');
      if (topbar) topbar.style.display = '';
      // Tech support nav visible only for maintenance users
      this._updateTechSupportNav();
      this.updateUserDisplay();
      this.refreshSidebarInventory();
      this.updateHealthDot();
      this.renderDashboard();
      this.startAutoRefresh();
      this.startHealthCheck();
      this.initStatusBar();
    }
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
    if (this._statusBarInterval) clearInterval(this._statusBarInterval);
    this._statusBarInterval = setInterval(() => this.refreshStatusBar(), 5000);
  },

  showLogin(errorMsg) {
    const html = `
      <div class="login-screen">
        <div class="login-box">
          <div class="login-logo-wrapper">
            <div class="login-logo">W</div>
          </div>
          <h1>Worldengine</h1>
          <div class="login-tagline">ai互联</div>
          ${errorMsg ? `<div class="alert-banner info" style="margin-bottom:16px;">ℹ ${errorMsg}</div>` : ''}
          <div class="form-group">
            <label>用户名</label>
            <div class="login-input-wrap">
              <span class="login-input-icon">👤</span>
              <input type="text" id="login-username" placeholder="请输入用户名" autocomplete="username" required>
            </div>
          </div>
          <div class="form-group">
            <label>密码</label>
            <div class="login-input-wrap">
              <span class="login-input-icon">🔒</span>
              <input type="password" id="login-password" placeholder="请输入密码" autocomplete="current-password" required>
            </div>
          </div>
          <div id="login-error" style="color:#ef4444;font-size:0.85rem;min-height:24px;text-align:center;"></div>
          <button class="btn btn-primary login-btn" id="login-btn" onclick="App.doLogin()">登 录</button>
        </div>
      </div>
    `;
    document.getElementById('main-content').innerHTML = html;
    document.body.classList.remove('logged-in');
    document.body.classList.remove('sidebar-open');
    document.body.classList.add('login-mode');
    const topbar = document.querySelector('.topbar');
    if (topbar) topbar.style.display = 'none';
    const sidebar = document.querySelector('.sidebar');
    if (sidebar) sidebar.style.display = 'none';

    // Enter key to login
    const pwEl = document.getElementById('login-password');
    if (pwEl) pwEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') this.doLogin(); });
  },

  async doLogin() {
    const username = document.getElementById('login-username')?.value.trim();
    const password = document.getElementById('login-password')?.value.trim();
    const errorEl = document.getElementById('login-error');
    if (!username || !password) {
      if (errorEl) errorEl.textContent = '请输入用户名和密码';
      return;
    }
    const btn = document.getElementById('login-btn');
    if (btn) { btn.disabled = true; btn.textContent = '登录中...'; }
    const result = await API.login(username, password);
    if (!result.success) {
      if (errorEl) errorEl.textContent = result.message;
      if (btn) { btn.disabled = false; btn.textContent = '登录'; }
      return;
    }
    // Route to correct system based on account type
    const userSystem = result.user.system || 'maintenance';

    // Route operations users to operations page
    if (userSystem === 'operations') {
      window.location.replace('operations.html');
      return;
    }

    // Show sidebar, hamburger, and topbar, add logged-in class
    document.body.classList.add('logged-in');
    const topbarRight = document.querySelector('.topbar-right');
    if (topbarRight) topbarRight.style.display = '';
    const sidebar = document.querySelector('.sidebar');
    if (sidebar) sidebar.style.display = '';
    const hamburger = document.getElementById('hamburger-btn');
    if (hamburger) hamburger.style.display = '';
    await Storage._syncFromServer();
    this.updateUserDisplay();
    this.updateHealthDot();
    // 从 Cookie 恢复上次页面（如有）
    var lastTab = this._getCookie("gms_last_tab");
    if (lastTab && lastTab !== "dashboard") { this.switchTab(lastTab); } else { this.renderDashboard(); }
    this.startAutoRefresh();
    this.startHealthCheck();
    this.refreshSidebarInventory();
    this._updateTechSupportNav();
    this._updateUsersNav();
    const systemLabel = result.user.system === 'operations' ? '📊 运营系统' : '🔧 运维系统';
    this.notify(`欢迎，${result.user.username}！当前系统: ${systemLabel}`);
  },

  async doLogout() {
    if (API.online) {
      await fetch(API.baseURL + '/api/logout', { method: 'POST', headers: API._headers() }).catch(() => {});
    }
    API.logout();
    document.body.classList.remove('logged-in');
    this.showLogin();
  },

  // Health indicator
  updateHealthDot() {
    const dot = document.getElementById('health-dot');
    if (!dot) return;
    if (API.online) {
      dot.className = 'health-dot online';
      dot.title = '服务器已连接';
    } else {
      dot.className = 'health-dot offline';
      dot.title = '服务器未连接';
    }
  },

  startHealthCheck() {
    if (this._healthCheckInterval) clearInterval(this._healthCheckInterval);
    this._healthCheckInterval = setInterval(async () => {
      API.online = await API._checkServer();
      this.updateHealthDot();
    }, 10000);
  },

  async manualRefresh() {
    if (API.online) {
      await Storage._fullSyncFromServer();
      this.notify('数据已从服务器同步');
    }
    this.refreshSidebarInventory();
    this.refreshCurrentTab();
    this.updateHealthDot();
  },

  switchSystem(system) {
    if (system === 'operations') {
      // Set fast-switch flag to skip server health check on next init
      sessionStorage.setItem('gms_fast_switch', '1');
      window.location.href = 'operations.html';
    }
  },

  showChangePasswordForm() {
    const contentHtml = `
      <div class="form-group">
        <label>旧密码 <span class="required">*</span></label>
        <input type="password" id="chpwd-old" placeholder="输入当前密码" required>
      </div>
      <div class="form-group">
        <label>新密码 <span class="required">*</span></label>
        <input type="password" id="chpwd-new" placeholder="输入新密码（至少6个字符，需包含字母和数字）" required>
      </div>
      <div class="form-group">
        <label>确认新密码 <span class="required">*</span></label>
        <input type="password" id="chpwd-confirm" placeholder="再次输入新密码" required>
      </div>
    `;
    this.showModal('修改密码', contentHtml, async () => {
      const oldPwd = document.getElementById('chpwd-old').value;
      const newPwd = document.getElementById('chpwd-new').value;
      const confirmPwd = document.getElementById('chpwd-confirm').value;
      if (!oldPwd || !newPwd || !confirmPwd) { this.notify('请填写所有字段', 'error'); return false; }
      if (newPwd !== confirmPwd) { this.notify('两次输入的新密码不一致', 'error'); return false; }
      if (newPwd.length < 6) { this.notify('新密码至少6个字符', 'error'); return false; }
      if (!/[A-Za-z]/.test(newPwd) || !/[0-9]/.test(newPwd)) { this.notify('新密码需包含字母和数字', 'error'); return false; }
      const result = await this._changePassword(oldPwd, newPwd);
      if (!result.success) { this.notify(result.message, 'error'); return false; }
      this.notify('密码修改成功');
      return true;
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

  updateUserDisplay() {
    const user = API.currentUser;
    const el = document.getElementById('topbar-user');
    if (!el) return;

    // Toggle admin-only nav items (visible for both admin and superadmin)
    const isAdmin = API.online && user && (user.role === 'admin' || user.role === 'superadmin');
    ['nav-users', 'nav-equipment-config', 'nav-inventory-config'].forEach(id => {
      const navEl = document.getElementById(id);
      if (navEl) navEl.style.display = isAdmin ? '' : 'none';
    });

    if (API.online && user) {
      const roleLabel = user.role === 'superadmin' ? ' (超级管理员)' : user.role === 'admin' ? ' (管理员)' : '';
      const switcherHtml = user.role === 'superadmin' ? `
        <span class="system-switcher" style="margin-right:8px;">
          <span class="sys-btn active">🔧 运维</span>
          <button class="sys-btn" onclick="App.switchSystem('operations')" title="切换到运营系统">📊 运营</button>
        </span>` : '';
      el.innerHTML = `${switcherHtml}<span class="topbar-user-name">👤 ${user.displayName || user.username}${roleLabel}</span>
        <button class="btn btn-xs btn-outline" onclick="App.showChangePasswordForm()" style="font-size:0.7rem;" title="修改密码">🔑</button>
        <button class="btn btn-xs btn-outline" onclick="App.doLogout()" style="font-size:0.7rem;">退出</button>`;
    } else {
      el.innerHTML = '<span class="topbar-offline">离线模式</span>';
    }
  },

  // ==================== THEME ====================
  applyTheme() {
    const settings = Storage.getSettings();
    // Auto-detect system preference on first load (when darkModePreference hasn't been set)
    if (settings._themeManuallySet !== true) {
      const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      settings.darkMode = prefersDark;
    }
    document.documentElement.setAttribute('data-theme', settings.darkMode ? 'dark' : 'light');
  },

  toggleTheme() {
    const settings = Storage.getSettings();
    settings.darkMode = !settings.darkMode;
    settings._themeManuallySet = true;
    Storage.saveSettings(settings);
    this.applyTheme();
  },

  // ==================== NAVIGATION ====================
  bindNavigation() {
    document.querySelectorAll('.nav-item').forEach(item => {
      item.addEventListener('click', () => {
        const tab = item.dataset.tab;
        this.switchTab(tab);
      });
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
  _deleteCookie(name) {
    document.cookie = name + "=;expires=Thu,01 Jan 1970 00:00:00 UTC;path=/";
  },
  switchTab(tab) {
    console.log('[switchTab] Switching to:', tab);
    this.currentTab = tab;
    this._setCookie("gms_last_tab", tab, 7);
    // Close mobile sidebar when a nav item is clicked
    document.body.classList.remove('sidebar-open');
    document.querySelectorAll('.nav-item').forEach(i => i.classList.remove('active'));
    const navItem = document.querySelector(`.nav-item[data-tab="${tab}"]`);
    if (navItem) navItem.classList.add('active');
    // Sync sidebar dropdown
    const select = document.getElementById('sidebar-device-select');
    if (select) {
      const validTabs = ['glove', 'dexterous', 'gripper'];
      if (validTabs.includes(tab) || tab.indexOf('_') > -1 || tab.indexOf('-') > -1) {
        // Check if this tab is an option in the select
        const option = select.querySelector(`option[value="${tab}"]`);
        if (option) select.value = tab;
        else select.value = '';
      } else {
        select.value = '';
      }
    }

    const content = document.getElementById('main-content');
    content.innerHTML = '';
    content.classList.remove('fade-in');
    void content.offsetWidth;
    content.classList.add('fade-in');

    // Guard non-admin from users tab
    if (tab === 'users' && (!API.currentUser || (API.currentUser.role !== 'admin' && API.currentUser.role !== 'superadmin'))) {
      this.renderDashboard();
      return;
    }

    switch (tab) {
      case 'dashboard': this.renderDashboard(); break;
      case 'glove': this.renderGloveInventory(); break;
      case 'dexterous': this.renderDexterousHand(); break;
      case 'gripper': this.renderGripper(); break;
      case 'machines': this.renderMachines(); break;
      case 'transactions': this.renderTransactions(); break;
      case 'reports': this.renderReports(); break;
      case 'settings': this.renderSettings(); break;
      case 'audit': this.renderAuditLog(); break;
      case 'users': this.renderUserManagement(); break;
      case 'equipment-config': this.renderEquipmentConfig(); break;
      case 'sn-codes': this.renderSNCodes(); break;
      case 'after-sales': this.renderAfterSales(); break;
      case 'inventory-config': this.renderInventoryConfig(); break;
      case 'tech-support': this.renderTechSupport(); break;
      case 'popup-messages': this.renderPopupMessages(); break;
      default:
        // Dynamic inventory type (from inventory config)
        const invConfig = Storage.getInventoryConfig();
        const matched = invConfig.find(c => tab === c.id || tab === c.id + '_left' || tab === c.id + '_right');
        if (matched) {
          this.renderDynamicInventory(tab, matched);
        } else {
          this.renderDashboard();
        }
        break;
    }
  },

  // ==================== GLOBAL EVENTS ====================
  bindGlobalEvents() {
    document.getElementById('theme-toggle').addEventListener('click', () => this.toggleTheme());
    document.getElementById('search-global').addEventListener('input', (e) => this.globalSearch(e.target.value));
    // Close mobile sidebar when clicking outside it (overlay)
    document.addEventListener('click', (e) => {
      if (!document.body.classList.contains('sidebar-open')) return;
      const sidebar = document.querySelector('.sidebar');
      const hamburger = document.getElementById('hamburger-btn');
      if (sidebar && !sidebar.contains(e.target) && hamburger && !hamburger.contains(e.target)) {
        document.body.classList.remove('sidebar-open');
      }
    });
  },

  // ==================== NOTIFICATION ====================
  notify(message, type = 'success') {
    const container = document.getElementById('notification-container');
    const el = document.createElement('div');
    el.className = `notification notification-${type}`;
    el.innerHTML = `<span>${type === 'success' ? '✓' : type === 'warning' ? '⚠' : '✗'}</span> ${message}`;
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

    // Reset modal state (undo _showInfoModal hiding)
    saveBtn.style.display = '';
    if (closeBtn) closeBtn.textContent = '取消';

    titleEl.textContent = title;
    body.innerHTML = contentHtml;
    overlay.style.display = 'flex';
    saveBtn.onclick = async () => {
      saveBtn.disabled = true;
      const origText = saveBtn.textContent;
      saveBtn.textContent = '处理中...';
      try {
        const result = await onSave();
        if (result !== false) overlay.style.display = 'none';
      } catch (e) { console.error('Modal save error:', e); this.notify('操作失败: ' + (e.message || '未知错误'), 'error'); return; }
      finally {
        saveBtn.disabled = false;
        saveBtn.textContent = origText;
      }
    };
    document.getElementById('modal-close').onclick = () => { overlay.style.display = 'none'; };
    closeBtn.onclick = () => { overlay.style.display = 'none'; };
    overlay.onclick = (e) => { if (e.target === overlay) overlay.style.display = 'none'; };
  },

  closeModal() {
    const overlay = document.getElementById('modal-overlay');
    if (overlay) overlay.style.display = 'none';
  },

  // ==================== DASHBOARD ====================
  renderDashboard() {
    const onlineCount = Storage.getOnlineMachineCount();
    const machines = Storage.getMachines();
    const totalMachines = [...new Set(machines.map(m => m.machineNumber))].length;
    const transactions = Storage.getTransactions();
    const todayStart = new Date().setHours(0, 0, 0, 0);
    const todayTx = transactions.filter(t => new Date(t.timestamp).getTime() >= todayStart);
    const settings = Storage.getSettings();
    const cards = settings.dashboardCards || ['totalGloves', 'totalDexterous', 'left_glove', 'right_glove', 'left_dexterous_hand', 'right_dexterous_hand', 'gripper', 'onlineMachines', 'todayTransactions', 'transferredGloves'];
    // 确保调出手套卡片始终显示（即使已有旧设置）
    if (!cards.includes('transferredGloves')) cards.push('transferredGloves');

    // Build invConfig lookup for labels/icons
    const invConfig = Storage.getInventoryConfig();
    const invCfgMap = {};
    invConfig.forEach(c => {
      invCfgMap[c.id] = c;
      if (c.hasLeftRight) { invCfgMap[c.id + '_left'] = { name: c.name + '左手', icon: c.icon }; invCfgMap[c.id + '_right'] = { name: c.name + '右手', icon: c.icon }; }
    });
    // Ensure defaults are in map
    if (!invCfgMap.left_glove) invCfgMap.left_glove = { name: '左手手套', icon: '🧤' };
    if (!invCfgMap.right_glove) invCfgMap.right_glove = { name: '右手手套', icon: '🧤' };
    if (!invCfgMap.left_dexterous_hand) invCfgMap.left_dexterous_hand = { name: '左手灵巧手', icon: '🤖' };
    if (!invCfgMap.right_dexterous_hand) invCfgMap.right_dexterous_hand = { name: '右手灵巧手', icon: '🤖' };
    if (!invCfgMap.gripper) invCfgMap.gripper = { name: '夹爪', icon: '🔧' };

    // ===== 全部库存统计 (手套 + 灵巧手 + 自定义类型) =====
    // 分三个维度：手套、灵巧手、其他自定义类型
    const builtinLeftRight = ['left_glove', 'right_glove', 'left_dexterous_hand', 'right_dexterous_hand'];

    // 手套维度：左手手套 + 右手手套
    let gloveLeftTotal = 0, gloveRightTotal = 0, gloveDamagedAll = 0, gloveRepairAll = 0;
    ['left_glove', 'right_glove'].forEach(t => {
      const inv = Storage.getInventory(t);
      const counts = this._getStatusCounts(t);
      if (t === 'left_glove') gloveLeftTotal = counts.available + counts.inUse + counts.damaged;
      if (t === 'right_glove') gloveRightTotal = counts.available + counts.inUse + counts.damaged;
      gloveDamagedAll += counts.damaged;
      gloveRepairAll += counts.inRepair;
    });

    // 灵巧手维度：左手灵巧手 + 右手灵巧手
    let dexLeftTotal = 0, dexRightTotal = 0, dexDamagedAll = 0, dexRepairAll = 0;
    ['left_dexterous_hand', 'right_dexterous_hand'].forEach(t => {
      const inv = Storage.getInventory(t);
      const counts = this._getStatusCounts(t);
      if (t === 'left_dexterous_hand') dexLeftTotal = counts.available + counts.inUse + counts.damaged;
      if (t === 'right_dexterous_hand') dexRightTotal = counts.available + counts.inUse + counts.damaged;
      dexDamagedAll += counts.damaged;
      dexRepairAll += counts.inRepair;
    });

    // 合并全部类型 (手套 + 灵巧手 + 自定义)
    let leftTotal = gloveLeftTotal + dexLeftTotal;
    let rightTotal = gloveRightTotal + dexRightTotal;
    let damagedAll = gloveDamagedAll + dexDamagedAll;
    let repairAll = gloveRepairAll + dexRepairAll;

    // 自定义 left/right 库存类型 (排除已内置处理的四个)
    invConfig.filter(c => c.hasLeftRight && !builtinLeftRight.includes(c.id)).forEach(c => {
      const leftKey = c.id + '_left';
      const rightKey = c.id + '_right';
      const leftInv = Storage.getInventory(leftKey);
      const rightInv = Storage.getInventory(rightKey);
      const leftCounts = this._getStatusCounts(leftKey);
      const rightCounts = this._getStatusCounts(rightKey);
      leftTotal += leftCounts.available + leftCounts.inUse + leftCounts.damaged;
      rightTotal += rightCounts.available + rightCounts.inUse + rightCounts.damaged;
      damagedAll += leftCounts.damaged + rightCounts.damaged;
      repairAll += leftCounts.inRepair + rightCounts.inRepair;
    });

    // Dynamic stat cards
    const cardStyles = ['primary', 'primary', 'accent', 'accent', 'accent', 'info'];
    let cardsHtml = '';
    let cardIdx = 0;
    for (const cardType of cards) {
      if (cardType === 'totalGloves') {
        // 手套总数：左手手套 + 右手手套（只）
        const gloveTotalAll = gloveLeftTotal + gloveRightTotal;
        cardsHtml += `<div class="stat-card primary clickable" onclick="App.showTotalInventoryDetail()" title="点击查看手套库存明细"><div class="stat-icon">🧤</div><div class="stat-value">${gloveTotalAll}<span style="font-size:0.45em;font-weight:400;margin-left:4px;">只</span></div><div class="stat-label">手套总数</div><div class="stat-footer">左手${gloveLeftTotal}只 · 右手${gloveRightTotal}只</div></div>`;
      } else if (cardType === 'totalDexterous') {
        // 灵巧手总数：左手灵巧手 + 右手灵巧手（只）
        const dexTotalAll = dexLeftTotal + dexRightTotal;
        cardsHtml += `<div class="stat-card primary clickable" onclick="App.showTotalInventoryDetail()" title="点击查看灵巧手库存明细"><div class="stat-icon">🤖</div><div class="stat-value">${dexTotalAll}<span style="font-size:0.45em;font-weight:400;margin-left:4px;">只</span></div><div class="stat-label">灵巧手总数</div><div class="stat-footer">左手${dexLeftTotal}只 · 右手${dexRightTotal}只</div></div>`;
      } else if (cardType === 'damagedGloves') {
        const totalDamaged = damagedAll;
        cardsHtml += `<div class="stat-card accent clickable" onclick="App.switchTab('after-sales')" title="点击查看损坏设备 · 手套${gloveDamagedAll}只 + 灵巧手${dexDamagedAll}只"><div class="stat-icon">⚠️</div><div class="stat-value">${totalDamaged}</div><div class="stat-label">损坏设备</div><div class="stat-footer">手套${gloveDamagedAll}只 · 灵巧手${dexDamagedAll}只 | 待售后处理</div></div>`;
      } else if (cardType === 'inRepairGloves') {
        const totalRepair = repairAll;
        cardsHtml += `<div class="stat-card warning clickable" onclick="App.switchTab('after-sales')" title="点击查看售后中设备 · 手套${gloveRepairAll}只 + 灵巧手${dexRepairAll}只"><div class="stat-icon">🔧</div><div class="stat-value">${totalRepair}</div><div class="stat-label">售后中设备</div><div class="stat-footer">手套${gloveRepairAll}只 · 灵巧手${dexRepairAll}只 | 已发回厂家维修</div></div>`;
      } else if (cardType === 'onlineMachines') {
        cardsHtml += `
        <div class="stat-card warning clickable" onclick="App.showOnlineMachineBreakdown()" title="点击查看在线机器分类详情">
          <div class="stat-icon">🖥️</div>
          <div class="stat-value">${onlineCount}</div>
          <div class="stat-label">在线机器数量</div>
          <div class="stat-footer">点击查看详情</div>
        </div>`;
      } else if (cardType === 'todayTransactions') {
        cardsHtml += `
        <div class="stat-card info clickable" onclick="App.showTodayTransactions()" title="点击查看今日操作详情">
          <div class="stat-icon">📋</div>
          <div class="stat-value">${todayTx.length}</div>
          <div class="stat-label">今日操作记录</div>
          <div class="stat-footer">共 ${transactions.length} 条历史记录</div>
        </div>`;
      } else if (cardType === 'transferredGloves') {
        // 手套调出状态卡（从 SN 注册表统计）
        const snReg = Storage.getSNRegistry ? Storage.getSNRegistry() : [];
        const transferredCount = snReg.filter(s => s.status === 'transferred').length;
        cardsHtml += `
        <div class="stat-card warning clickable" onclick="App._showTransferModal()" title="点击查看调出手套详情">
          <div class="stat-icon">📤</div>
          <div class="stat-value">${transferredCount}</div>
          <div class="stat-label">调出手套</div>
          <div class="stat-footer">外部场地使用中</div>
        </div>`;
      } else {
        const avail = this._getAvailableInventory(cardType);
        const cfg = invCfgMap[cardType] || {};
        const label = cfg.name || cardType;
        const icon = cfg.icon || '📦';
        const style = cardStyles[cardIdx % cardStyles.length];
        let footer = avail.updatedBy ? `更新人: ${avail.updatedBy}` : '暂无记录';
        if (avail.damaged > 0 || avail.inRepair > 0) {
          footer += ` | 损坏:${avail.damaged} 售后:${avail.inRepair}`;
        }
        cardsHtml += `
        <div class="stat-card ${style} clickable" onclick="App.showInventoryBreakdown('${cardType}','${label.replace(/'/g, "\\'")}')" title="点击查看${label}详情">
          <div class="stat-icon">${icon}</div>
          <div class="stat-value">${avail.available}</div>
          <div class="stat-label">${label}库存 (空闲)</div>
          <div class="stat-footer">${footer}</div>
        </div>`;
      }
      cardIdx++;
    }

    // Dynamic quick actions from dashboardCards (inventory types only)
    let quickActionsHtml = '';
    for (const cardType of cards) {
      if (cardType === 'onlineMachines' || cardType === 'todayTransactions' || cardType === 'totalGloves' || cardType === 'totalDexterous' || cardType === 'damagedGloves' || cardType === 'inRepairGloves' || cardType === 'transferredGloves') continue;
      const cfg = invCfgMap[cardType] || {};
      const label = cfg.name || cardType;
      const icon = cfg.icon || '📦';
      quickActionsHtml += `
        <button class="btn btn-sm btn-primary" onclick="App.quickInOut('${cardType}','in')">${icon} ${label} +入库</button>
        <button class="btn btn-sm btn-primary" onclick="App.quickInOut('${cardType}','out')">${icon} ${label} -出库</button>`;
    }
    quickActionsHtml += `
        <button class="btn btn-sm btn-warning" onclick="App.switchTab('machines')">机器管理 →</button>
        <button class="btn btn-sm btn-info" onclick="App.switchTab('transactions')">流水记录 →</button>`;

    const html = `
      <div class="page-header"><h2>系统总览</h2><span class="page-subtitle">实时数据概览 · 更新于 ${new Date().toLocaleTimeString()}</span></div>
      <div class="stat-cards" id="dashboard-cards" ondragover="event.preventDefault()" ondrop="App._onDashDrop(event)">${cardsHtml}</div>
      <p style="font-size:0.7rem;color:var(--text-tertiary);margin-top:4px;">💡 长按卡片 ⋮⋮ 可拖动调整位置</p>
      <div class="utilization-bar-container">
        <div class="utilization-label">机器利用率: ${onlineCount}/${totalMachines} (${totalMachines > 0 ? Math.round(onlineCount / totalMachines * 100) : 0}%)</div>
        <div class="utilization-bar">
          <div class="utilization-fill" style="width:${totalMachines > 0 ? Math.round(onlineCount / totalMachines * 100) : 0}%;"></div>
        </div>
      </div>
      <div class="dashboard-grid">
        <div class="dash-card">
          <h3>📊 库存趋势 (近7天)</h3>
          <div class="chart-container"><canvas id="chart-inventory-trend"></canvas></div>
        </div>
        <div class="dash-card">
          <h3>🖥️ 机器状态分布</h3>
          <div class="chart-container"><canvas id="chart-machine-status"></canvas></div>
        </div>
        <div class="dash-card">
          <h3>📋 最近操作记录</h3>
          <div class="mini-list">${this._renderRecentTransactions(transactions.slice(0, 8))}</div>
        </div>
        <div class="dash-card">
          <h3>⚡ 快捷操作</h3>
          <div class="quick-actions">${quickActionsHtml}</div>
        </div>
      </div>
    `;
    document.getElementById('main-content').innerHTML = html;
    // Add drag handles to dashboard cards (after DOM is ready)
    setTimeout(() => {
      const container = document.getElementById('dashboard-cards');
      if (!container) return;
      const settingCards = Storage.getSettings().dashboardCards || [];
      const cardEls = container.querySelectorAll('.stat-card');
      cardEls.forEach((el, i) => {
        const cardType = settingCards[i] || '';
        el.setAttribute('draggable', 'true');
        el.setAttribute('data-card', cardType);
        el.addEventListener('dragstart', function(e) {
          e.dataTransfer.setData('text/plain', cardType);
          this.style.opacity = '0.4';
        });
        el.addEventListener('dragend', function() { this.style.opacity = ''; });
        // Add drag handle
        const handle = document.createElement('span');
        handle.className = 'drag-handle';
        handle.innerHTML = '⋮⋮';
        handle.title = '拖动排序';
        handle.setAttribute('draggable', 'false');
        el.appendChild(handle);
      });
    }, 100);
    this._drawInventoryTrendChart();
    this._drawMachineStatusChart();
  },

  _renderRecentTransactions(txs) {
    if (txs.length === 0) return '<p class="empty-text">暂无记录</p>';
    return `<table class="mini-table"><thead><tr><th>时间</th><th>设备类型</th><th>操作</th><th>数量</th><th>SN码</th><th>操作人</th></tr></thead><tbody>
      ${txs.map(t => `
        <tr>
          <td title="${this._formatTime(t.timestamp)}">${this._formatTime(t.timestamp)}</td>
          <td>${this._equipmentLabel(t.equipmentType, t.handType)}</td>
          <td><span class="badge ${t.direction === 'in' ? 'badge-in' : 'badge-out'}">${t.direction === 'in' ? '入库' : '出库'}</span></td>
          <td>${t.quantity}</td>
          <td>${t.snCode || '-'} ${t.attachment ? '<a href="'+t.attachment+'" target="_blank" title="查看附件">📎</a>' : ''}</td>
          <td>${t.updatedBy || '-'}</td>
        </tr>
      `).join('')}
    </tbody></table>`;
  },

  quickInOut(type, direction) {
    const label = Storage._typeLabel(type);
    const dirLabel = direction === 'in' ? '入库' : '出库';
    const contentHtml = `
      <div class="form-group">
        <label>操作类型</label>
        <input type="text" value="${label} ${dirLabel}" disabled>
      </div>
      <div class="form-group">
        <label>数量 <span class="required">*</span></label>
        <input type="number" id="quick-qty" min="1" value="1" required>
      </div>
      <div class="form-group">
        <label>SN码 (选填)</label>
        <input type="text" id="quick-sn" placeholder="输入SN码"autocomplete="off" oninput="App._onSNInput(this)"><span class="sn-attach-preview"></span>
        <!-- SN 自动补全改用自定义下拉 -->
      </div>
      <div class="form-group">
        <label>附件/图片</label>
        <input type="file" id="quick-attachment" accept="image/*,.pdf" style="font-size:0.85rem;" onchange="App._onAttachmentChange(this,'quick-sn')">
      </div>
      <div class="form-group">
        <label>更新人 <span class="required">*</span></label>
        <input type="text" id="quick-user" value="${this._currentUser()}" required>
      </div>
    `;
    this.showModal(`${label} - ${dirLabel}`, contentHtml, async () => {
      const qty = parseInt(document.getElementById('quick-qty').value) || 0;
      const snCode = document.getElementById('quick-sn').value.trim();
      const user = document.getElementById('quick-user').value.trim();
      const attachment = await this._uploadAttachment(document.getElementById('quick-attachment'));
      if (!user) { this.notify('请输入更新人', 'error'); return false; }
      if (qty <= 0) { this.notify('数量必须大于0', 'error'); return false; }
      const delta = direction === 'in' ? qty : -qty;
      const result = Storage.adjustInventory(type, delta, user, snCode);
      if (!result.success) { this.notify(result.message, 'error'); return false; }
      const eqType = (type === 'left_glove' || type === 'right_glove') ? 'glove'
        : (type === 'left_dexterous_hand' || type === 'right_dexterous_hand') ? 'dexterous_hand'
        : type;
      const handType = (type === 'left_glove' || type === 'left_dexterous_hand') ? 'left'
        : (type === 'right_glove' || type === 'right_dexterous_hand') ? 'right'
        : type.endsWith('_left') ? 'left'
        : type.endsWith('_right') ? 'right'
        : null;
      Storage.addTransaction({
        equipmentType: eqType,
        handType: handType,
        direction,
        quantity: qty,
        snCode: snCode || '',
        updatedBy: user,
        attachment: attachment || '',
      });
      if (direction === 'in' && snCode) {
        this._registerSN(snCode, eqType, handType, 'available');
      } else if (direction === 'out' && snCode) {
        // Mark SN as no longer available (transferred out of warehouse)
        this._registerSN(snCode, eqType, handType, 'transferred', '', '手动出库');
      }
      this.notifyWithUndo(`操作成功！当前库存: ${result.newQuantity}`);
      this.refreshCurrentTab();
      return true;
    });
  },

  // ==================== GLOVE INVENTORY ====================
  renderGloveInventory() {
    const leftAvail = this._getAvailableInventory('left_glove');
    const rightAvail = this._getAvailableInventory('right_glove');
    const transactions = Storage.getTransactions().filter(t => t.equipmentType === 'glove');

    function statusBadges(avail) {
      let s = '';
      if (avail.inUse > 0) s += `使用中:${avail.inUse} `;
      if (avail.damaged > 0) s += `损坏:${avail.damaged} `;
      if (avail.inRepair > 0) s += `售后:${avail.inRepair} `;
      return s || '';
    }

    const html = `
      <div class="page-header">
        <h2>🧤 手套库存管理</h2>
        <div class="header-actions">
          <button class="btn btn-primary" onclick="App.showGloveInOutForm()">+ 新增出入库记录</button>
          <button class="btn btn-outline" onclick="App.showBatchGloveForm()">📦 批量操作</button>
          ${API.currentUser && API.currentUser.role === 'superadmin' ? `
            <button class="btn btn-sm btn-danger" onclick="App.showSetInventoryModal('left_glove','左手手套')">✎ 左手库存</button>
            <button class="btn btn-sm btn-danger" onclick="App.showSetInventoryModal('right_glove','右手手套')">✎ 右手库存</button>
          ` : ''}
        </div>
      </div>
      <div class="inventory-cards">
        <div class="inv-card">
          <div class="inv-card-header">左手手套 (空闲)</div>
          <div class="inv-card-value">${leftAvail.available}</div>
          <div class="inv-card-meta">${statusBadges(leftAvail)}最后更新: ${this._formatTime(leftAvail.updatedAt)} | ${leftAvail.updatedBy || '无'}</div>
        </div>
        <div class="inv-card">
          <div class="inv-card-header">右手手套 (空闲)</div>
          <div class="inv-card-value">${rightAvail.available}</div>
          <div class="inv-card-meta">${statusBadges(rightAvail)}最后更新: ${this._formatTime(rightAvail.updatedAt)} | ${rightAvail.updatedBy || '无'}</div>
        </div>
      </div>
      <div class="section-header"><h3>手套流水记录</h3></div>
      <div class="table-container">
        <table class="data-table">
          <thead><tr><th>时间</th><th>左右手</th><th>操作</th><th>数量</th><th>SN码</th><th>更新人</th><th>操作</th></tr></thead>
          <tbody>${transactions.length === 0 ? '<tr><td colspan="7" class="empty-text">暂无手套流水记录</td></tr>' :
            transactions.map(t => `
              <tr>
                <td title="${this._formatTime(t.timestamp)}">${this._formatTime(t.timestamp)}</td>
                <td>${t.handType === 'left' ? '左手' : '右手'}</td>
                <td><span class="badge ${t.direction === 'in' ? 'badge-in' : 'badge-out'}">${t.direction === 'in' ? '入库' : '出库'}</span></td>
                <td>${t.quantity}</td>
                <td>${t.snCode || '-'} ${t.attachment ? '<a href="'+t.attachment+'" target="_blank" title="查看附件">📎</a>' : ''}</td>
                <td>${t.updatedBy || '-'}</td>
                <td>${this._isPrivileged() ? `<button class="btn btn-xs btn-danger" onclick="App.deleteTransaction('${t.id}')">删除</button>` : ''}</td>
              </tr>
            `).join('')
          }</tbody>
        </table>
      </div>
    `;
    document.getElementById('main-content').innerHTML = html;
  },

  showGloveInOutForm() {
    const contentHtml = `
      <div class="form-group">
        <label>左右手 <span class="required">*</span></label>
        <select id="glove-hand" required>
          <option value="left">左手 (更新左手库存)</option>
          <option value="right">右手 (更新右手库存)</option>
        </select>
      </div>
      <div class="form-group">
        <label>出入库 <span class="required">*</span></label>
        <select id="glove-direction" required>
          <option value="in">入库 (+)</option>
          <option value="out">出库 (-)</option>
        </select>
      </div>
      <div class="form-group">
        <label>数量 <span class="required">*</span></label>
        <input type="number" id="glove-qty" min="1" value="1" required>
      </div>
      <div class="form-group">
        <label>SN码 (选填)</label>
        <input type="text" id="glove-sn" placeholder="输入SN码" autocomplete="off" oninput="App._onSNInput(this)"><span class="sn-attach-preview" id="glove-sn-preview"></span>
        <!-- SN 自动补全改用自定义下拉 -->
      </div>
      <div class="form-group">
        <label>附件/图片</label>
        <input type="file" id="glove-attachment" accept="image/*,.pdf" style="font-size:0.85rem;" onchange="App._onAttachmentChange(this,'glove-sn')">
        <p class="form-hint">可为该SN码上传手套照片或相关附件（上传图片自动识别SN码）</p>
      </div>
      <div class="form-group">
        <label>机器编号 (选填)</label>
        <input type="text" id="glove-machine" placeholder="关联机器编号">
      </div>
      <div class="form-group">
        <label>更新人 <span class="required">*</span></label>
        <input type="text" id="glove-user" value="${this._currentUser()}" required>
      </div>
      <div class="form-group">
        <label>备注</label>
        <textarea id="glove-note" rows="2" placeholder="可选备注"></textarea>
      </div>
    `;
    this.showModal('新增手套出入库记录', contentHtml, async () => {
      const hand = document.getElementById('glove-hand').value;
      const direction = document.getElementById('glove-direction').value;
      const qty = parseInt(document.getElementById('glove-qty').value) || 0;
      const snCode = document.getElementById('glove-sn').value.trim();
      const machineNumber = document.getElementById('glove-machine').value.trim();
      const user = document.getElementById('glove-user').value.trim();
      const note = document.getElementById('glove-note').value.trim();
      const attachment = await this._uploadAttachment(document.getElementById('glove-attachment'));
      if (!user) { this.notify('请输入更新人', 'error'); return false; }
      if (qty <= 0) { this.notify('数量必须大于0', 'error'); return false; }

      const inventoryType = hand === 'left' ? 'left_glove' : 'right_glove';
      const delta = direction === 'in' ? qty : -qty;
      const result = Storage.adjustInventory(inventoryType, delta, user, snCode);
      if (!result.success) { this.notify(result.message, 'error'); return false; }

      Storage.addTransaction({
        equipmentType: 'glove',
        handType: hand,
        direction,
        quantity: qty,
        snCode: snCode || '',
        machineNumber: machineNumber || '',
        updatedBy: user,
        note: note || '',
        attachment: attachment || '',
      });
      if (direction === 'in' && snCode) {
        this._registerSN(snCode, 'glove', hand, 'available');
      } else if (direction === 'out' && snCode) {
        this._registerSN(snCode, 'glove', hand, 'transferred', '', '手动出库');
      }
      this.notifyWithUndo(`手套${hand === 'left' ? '左手' : '右手'}${direction === 'in' ? '入库' : '出库'}成功！当前库存: ${result.newQuantity}`);
      this.renderGloveInventory();
      return true;
    });
  },

  showBatchGloveForm() {
    const contentHtml = `
      <p class="form-hint">批量操作：输入格式 "左手+n" 或 "右手-n" 或 "左手+n,右手+m"，每行一条</p>
      <div class="form-group">
        <label>批量指令</label>
        <textarea id="batch-instructions" rows="6" placeholder="示例：&#10;左手+5&#10;右手+3&#10;左手-2"></textarea>
      </div>
      <div class="form-group">
        <label>更新人 <span class="required">*</span></label>
        <input type="text" id="batch-user" value="${this._currentUser()}" required>
      </div>
    `;
    this.showModal('批量操作手套', contentHtml, () => {
      const instructions = document.getElementById('batch-instructions').value.trim();
      const user = document.getElementById('batch-user').value.trim();
      if (!user) { this.notify('请输入更新人', 'error'); return false; }
      if (!instructions) { this.notify('请输入批量指令', 'error'); return false; }

      const lines = instructions.split('\n').filter(l => l.trim());
      let successCount = 0;
      const errors = [];
      lines.forEach(line => {
        const match = line.trim().match(/(左手|右手)([+-])(\d+)/);
        if (!match) { errors.push(`无效格式: ${line}`); return; }
        const hand = match[1] === '左手' ? 'left' : 'right';
        const direction = match[2] === '+' ? 'in' : 'out';
        const qty = parseInt(match[3]);
        const inventoryType = hand === 'left' ? 'left_glove' : 'right_glove';
        const delta = direction === 'in' ? qty : -qty;
        const result = Storage.adjustInventory(inventoryType, delta, user);
        if (!result.success) { errors.push(`${match[1]}: ${result.message}`); return; }
        Storage.addTransaction({
          equipmentType: 'glove', handType: hand, direction, quantity: qty,
          snCode: '', updatedBy: user, note: '批量操作',
        });
        successCount++;
      });
      if (errors.length > 0) {
        this.notify(`成功 ${successCount} 条，失败 ${errors.length} 条: ${errors.join('; ')}`, 'warning');
      } else {
        this.notify(`批量操作成功！共处理 ${successCount} 条记录`);
      }
      this.renderGloveInventory();
      return true;
    });
  },

  // ==================== DEXTEROUS HAND ====================
  renderDexterousHand() {
    const leftAvail = this._getAvailableInventory('left_dexterous_hand');
    const rightAvail = this._getAvailableInventory('right_dexterous_hand');
    const transactions = Storage.getTransactions().filter(t => t.equipmentType === 'dexterous_hand');
    function sb(a) { let s = ''; if (a.inUse > 0) s += `使用中:${a.inUse} `; if (a.damaged > 0) s += `损坏:${a.damaged} `; if (a.inRepair > 0) s += `售后:${a.inRepair} `; return s || ''; }

    const html = `
      <div class="page-header">
        <h2>🤖 灵巧手管理</h2>
        <div class="header-actions">
          <button class="btn btn-primary" onclick="App.showDexterousInOutForm()">+ 新增出入库记录</button>
          <button class="btn btn-outline" onclick="App.showBatchDexterousForm()">📦 批量操作</button>
          ${API.currentUser && API.currentUser.role === 'superadmin' ? `
            <button class="btn btn-sm btn-danger" onclick="App.showSetInventoryModal('left_dexterous_hand','左手灵巧手')">✎ 左手库存</button>
            <button class="btn btn-sm btn-danger" onclick="App.showSetInventoryModal('right_dexterous_hand','右手灵巧手')">✎ 右手库存</button>
          ` : ''}
        </div>
      </div>
      <div class="inventory-cards">
        <div class="inv-card">
          <div class="inv-card-header">左手灵巧手 (空闲)</div>
          <div class="inv-card-value">${leftAvail.available}</div>
          <div class="inv-card-meta">${sb(leftAvail)}最后更新: ${this._formatTime(leftAvail.updatedAt)} | ${leftAvail.updatedBy || '无'}</div>
        </div>
        <div class="inv-card">
          <div class="inv-card-header">右手灵巧手 (空闲)</div>
          <div class="inv-card-value">${rightAvail.available}</div>
          <div class="inv-card-meta">${sb(rightAvail)}最后更新: ${this._formatTime(rightAvail.updatedAt)} | ${rightAvail.updatedBy || '无'}</div>
        </div>
      </div>
      <div class="section-header"><h3>灵巧手流水记录</h3></div>
      <div class="table-container">
        <table class="data-table">
          <thead><tr><th>时间</th><th>左右手</th><th>操作</th><th>数量</th><th>SN码</th><th>机器编号</th><th>更新人</th><th>备注</th><th>操作</th></tr></thead>
          <tbody>${transactions.length === 0 ? '<tr><td colspan="9" class="empty-text">暂无灵巧手流水记录</td></tr>' :
            transactions.map(t => `
              <tr>
                <td title="${this._formatTime(t.timestamp)}">${this._formatTime(t.timestamp)}</td>
                <td>${t.handType === 'left' ? '左手' : t.handType === 'right' ? '右手' : '-'}</td>
                <td><span class="badge ${t.direction === 'in' ? 'badge-in' : 'badge-out'}">${t.direction === 'in' ? '入库' : '出库'}</span></td>
                <td>${t.quantity}</td>
                <td>${t.snCode || '-'} ${t.attachment ? '<a href="'+t.attachment+'" target="_blank" title="查看附件">📎</a>' : ''}</td>
                <td>${t.machineNumber || '-'}</td>
                <td>${t.updatedBy || '-'}</td>
                <td>${t.note || '-'}</td>
                <td>${this._isPrivileged() ? `<button class="btn btn-xs btn-danger" onclick="App.deleteTransaction('${t.id}')">删除</button>` : ''}</td>
              </tr>
            `).join('')
          }</tbody>
        </table>
      </div>
    `;
    document.getElementById('main-content').innerHTML = html;
  },

  showDexterousInOutForm() {
    const contentHtml = `
      <div class="form-group">
        <label>左右手 <span class="required">*</span></label>
        <select id="dex-hand" required>
          <option value="left">左手 (更新左手灵巧手库存)</option>
          <option value="right">右手 (更新右手灵巧手库存)</option>
        </select>
      </div>
      <div class="form-group">
        <label>出入库 <span class="required">*</span></label>
        <select id="dex-direction" required>
          <option value="in">入库 (+)</option>
          <option value="out">出库 (-)</option>
        </select>
      </div>
      <div class="form-group">
        <label>数量 <span class="required">*</span></label>
        <input type="number" id="dex-qty" min="1" value="1" required>
      </div>
      <div class="form-group">
        <label>SN码 (选填)</label>
        <input type="text" id="dex-sn" placeholder="输入灵巧手SN码" autocomplete="off" oninput="App._onSNInput(this)"><span class="sn-attach-preview"></span>
        <!-- SN 自动补全改用自定义下拉 -->
      </div>
      <div class="form-group">
        <label>附件/图片</label>
        <input type="file" id="dex-attachment" accept="image/*,.pdf" style="font-size:0.85rem;" onchange="App._onAttachmentChange(this,'dex-sn')">
        <p class="form-hint">可为该SN码上传灵巧手照片或相关附件（上传图片自动识别SN码）</p>
      </div>
      <div class="form-group">
        <label>机器编号 (选填)</label>
        <input type="text" id="dex-machine" placeholder="关联机器编号">
      </div>
      <div class="form-group">
        <label>更新人 <span class="required">*</span></label>
        <input type="text" id="dex-user" value="${this._currentUser()}" required>
      </div>
      <div class="form-group">
        <label>备注</label>
        <textarea id="dex-note" rows="2" placeholder="可选备注"></textarea>
      </div>
    `;
    this.showModal('新增灵巧手出入库记录', contentHtml, async () => {
      const hand = document.getElementById('dex-hand').value;
      const direction = document.getElementById('dex-direction').value;
      const qty = parseInt(document.getElementById('dex-qty').value) || 0;
      const snCode = document.getElementById('dex-sn').value.trim();
      const machineNumber = document.getElementById('dex-machine').value.trim();
      const user = document.getElementById('dex-user').value.trim();
      const note = document.getElementById('dex-note').value.trim();
      const attachment = await this._uploadAttachment(document.getElementById('dex-attachment'));
      if (!user) { this.notify('请输入更新人', 'error'); return false; }
      if (qty <= 0) { this.notify('数量必须大于0', 'error'); return false; }

      const inventoryType = hand === 'left' ? 'left_dexterous_hand' : 'right_dexterous_hand';
      const delta = direction === 'in' ? qty : -qty;
      const result = Storage.adjustInventory(inventoryType, delta, user, snCode);
      if (!result.success) { this.notify(result.message, 'error'); return false; }

      Storage.addTransaction({
        equipmentType: 'dexterous_hand',
        handType: hand,
        direction,
        quantity: qty,
        snCode: snCode || '',
        machineNumber: machineNumber || '',
        updatedBy: user,
        note: note || '',
        attachment: attachment || '',
      });
      if (direction === 'in' && snCode) {
        this._registerSN(snCode, 'dexterous_hand', hand, 'available');
      } else if (direction === 'out' && snCode) {
        this._registerSN(snCode, 'dexterous_hand', hand, 'transferred', '', '手动出库');
      }
      this.notifyWithUndo(`灵巧手${hand === 'left' ? '左手' : '右手'}${direction === 'in' ? '入库' : '出库'}成功！当前库存: ${result.newQuantity}`);
      this.renderDexterousHand();
      return true;
    });
  },

  showBatchDexterousForm() {
    const contentHtml = `
      <p class="form-hint">批量操作：输入格式 "左手+n" 或 "右手-n" 或 "左手+n,右手+m"，每行一条</p>
      <div class="form-group">
        <label>批量指令</label>
        <textarea id="batch-dex-instructions" rows="6" placeholder="示例：&#10;左手+5&#10;右手+3&#10;左手-2"></textarea>
      </div>
      <div class="form-group">
        <label>更新人 <span class="required">*</span></label>
        <input type="text" id="batch-dex-user" value="${this._currentUser()}" required>
      </div>
    `;
    this.showModal('批量操作灵巧手', contentHtml, () => {
      const instructions = document.getElementById('batch-dex-instructions').value.trim();
      const user = document.getElementById('batch-dex-user').value.trim();
      if (!user) { this.notify('请输入更新人', 'error'); return false; }
      if (!instructions) { this.notify('请输入批量指令', 'error'); return false; }

      const lines = instructions.split('\n').filter(l => l.trim());
      let successCount = 0;
      const errors = [];
      lines.forEach(line => {
        const match = line.trim().match(/(左手|右手)([+-])(\d+)/);
        if (!match) { errors.push(`无效格式: ${line}`); return; }
        const hand = match[1] === '左手' ? 'left' : 'right';
        const direction = match[2] === '+' ? 'in' : 'out';
        const qty = parseInt(match[3]);
        const inventoryType = hand === 'left' ? 'left_dexterous_hand' : 'right_dexterous_hand';
        const delta = direction === 'in' ? qty : -qty;
        const result = Storage.adjustInventory(inventoryType, delta, user);
        if (!result.success) { errors.push(`${match[1]}: ${result.message}`); return; }
        Storage.addTransaction({
          equipmentType: 'dexterous_hand', handType: hand, direction, quantity: qty,
          snCode: '', updatedBy: user, note: '批量操作',
        });
        successCount++;
      });
      if (errors.length > 0) {
        this.notify(`成功 ${successCount} 条，失败 ${errors.length} 条: ${errors.join('; ')}`, 'warning');
      } else {
        this.notify(`批量操作成功！共处理 ${successCount} 条记录`);
      }
      this.renderDexterousHand();
      return true;
    });
  },

  // ==================== GRIPPER ====================
  renderGripper() {
    const inventory = Storage.getInventory('gripper');
    const transactions = Storage.getTransactions().filter(t => t.equipmentType === 'gripper');

    const html = `
      <div class="page-header">
        <h2>🔧 夹爪 (Pika) 管理</h2>
        <div class="header-actions">
          <button class="btn btn-primary" onclick="App.showGripperInOutForm()">+ 新增出入库记录</button>
          ${API.currentUser && API.currentUser.role === 'superadmin' ? `<button class="btn btn-sm btn-danger" onclick="App.showSetInventoryModal('gripper','Pika')">✎ 直接设置库存</button>` : ''}
        </div>
      </div>
      <div class="inventory-cards">
        <div class="inv-card">
          <div class="inv-card-header">Pika库存 (空闲)</div>
          <div class="inv-card-value">${inventory.quantity}</div>
          <div class="inv-card-meta">最后更新: ${this._formatTime(inventory.updatedAt)} | ${inventory.updatedBy || '无'}</div>
        </div>
      </div>
      <div class="section-header"><h3>Pika流水记录</h3></div>
      <div class="table-container">
        <table class="data-table">
          <thead><tr><th>时间</th><th>操作</th><th>数量</th><th>机器编号</th><th>更新人</th><th>备注</th><th>操作</th></tr></thead>
          <tbody>${transactions.length === 0 ? '<tr><td colspan="7" class="empty-text">暂无Pika流水记录</td></tr>' :
            transactions.map(t => `
              <tr>
                <td title="${this._formatTime(t.timestamp)}">${this._formatTime(t.timestamp)}</td>
                <td><span class="badge ${t.direction === 'in' ? 'badge-in' : 'badge-out'}">${t.direction === 'in' ? '入库' : '出库'}</span></td>
                <td>${t.quantity}</td>
                <td>${t.machineNumber || '-'}</td>
                <td>${t.updatedBy || '-'}</td>
                <td>${t.note || '-'}</td>
                <td>${this._isPrivileged() ? `<button class="btn btn-xs btn-danger" onclick="App.deleteTransaction('${t.id}')">删除</button>` : ''}</td>
              </tr>
            `).join('')
          }</tbody>
        </table>
      </div>
    `;
    document.getElementById('main-content').innerHTML = html;
  },

  showGripperInOutForm() {
    const contentHtml = `
      <div class="form-group">
        <label>出入库 <span class="required">*</span></label>
        <select id="grip-direction" required>
          <option value="in">入库 (+)</option>
          <option value="out">出库 (-)</option>
        </select>
      </div>
      <div class="form-group">
        <label>数量 <span class="required">*</span></label>
        <input type="number" id="grip-qty" min="1" value="1" required>
      </div>
      <div class="form-group">
        <label>机器编号 (选填)</label>
        <input type="text" id="grip-machine" placeholder="关联机器编号">
      </div>
      <div class="form-group">
        <label>更新人 <span class="required">*</span></label>
        <input type="text" id="grip-user" value="${this._currentUser()}" required>
      </div>
      <div class="form-group">
        <label>备注</label>
        <textarea id="grip-note" rows="2" placeholder="可选备注"></textarea>
      </div>
    `;
    this.showModal('新增Pika出入库记录', contentHtml, () => {
      const direction = document.getElementById('grip-direction').value;
      const qty = parseInt(document.getElementById('grip-qty').value) || 0;
      const machineNumber = document.getElementById('grip-machine').value.trim();
      const user = document.getElementById('grip-user').value.trim();
      const note = document.getElementById('grip-note').value.trim();
      if (!user) { this.notify('请输入更新人', 'error'); return false; }
      if (qty <= 0) { this.notify('数量必须大于0', 'error'); return false; }

      const delta = direction === 'in' ? qty : -qty;
      const result = Storage.adjustInventory('gripper', delta, user);
      if (!result.success) { this.notify(result.message, 'error'); return false; }

      Storage.addTransaction({
        equipmentType: 'gripper', handType: null, direction, quantity: qty,
        snCode: '', machineNumber: machineNumber || '', updatedBy: user, note: note || '',
      });
      this.notifyWithUndo(`Pika${direction === 'in' ? '入库' : '出库'}成功！当前库存: ${result.newQuantity}`);
      this.renderGripper();
      return true;
    });
  },

  // ==================== DYNAMIC INVENTORY ====================
  renderDynamicInventory(tabId, config) {
    const isLeft = tabId.endsWith('_left');
    const isRight = tabId.endsWith('_right');
    const baseType = config.hasLeftRight ? tabId.replace(/_left$|_right$/, '') : tabId;
    const isLR = config.hasLeftRight;

    let leftInv, rightInv, transactions;
    if (isLR) {
      const invType = isLeft ? baseType + '_left' : isRight ? baseType + '_right' : tabId;
      leftInv = Storage.getInventory(baseType + '_left');
      rightInv = Storage.getInventory(baseType + '_right');
      transactions = Storage.getTransactions().filter(t =>
        t.equipmentType === baseType + '_left' || t.equipmentType === baseType + '_right'
      );
    } else {
      leftInv = Storage.getInventory(tabId);
      rightInv = null;
      transactions = Storage.getTransactions().filter(t => t.equipmentType === tabId);
    }

    const html = `
      <div class="page-header">
        <h2>${config.icon || '📦'} ${config.name}管理</h2>
        <div class="header-actions">
          <button class="btn btn-primary" onclick="App.showDynamicInOutForm('${tabId}', '${config.id}', ${isLR})">+ 新增出入库记录</button>
        </div>
      </div>
      <div class="inventory-cards">
        ${isLR ? `
        <div class="inv-card">
          <div class="inv-card-header">左手${config.name} (空闲)</div>
          <div class="inv-card-value">${(leftInv && leftInv.quantity) || 0}</div>
          <div class="inv-card-meta">最后更新: ${this._formatTime(leftInv && leftInv.updatedAt)} | ${(leftInv && leftInv.updatedBy) || '无'}</div>
        </div>
        <div class="inv-card">
          <div class="inv-card-header">右手${config.name} (空闲)</div>
          <div class="inv-card-value">${(rightInv && rightInv.quantity) || 0}</div>
          <div class="inv-card-meta">最后更新: ${this._formatTime(rightInv && rightInv.updatedAt)} | ${(rightInv && rightInv.updatedBy) || '无'}</div>
        </div>
        ` : `
        <div class="inv-card">
          <div class="inv-card-header">${config.name}库存 (空闲)</div>
          <div class="inv-card-value">${(leftInv && leftInv.quantity) || 0}</div>
          <div class="inv-card-meta">最后更新: ${this._formatTime(leftInv && leftInv.updatedAt)} | ${(leftInv && leftInv.updatedBy) || '无'}</div>
        </div>
        `}
      </div>
      <div class="section-header"><h3>${config.name}流水记录</h3></div>
      <div class="table-container">
        <table class="data-table">
          <thead><tr><th>时间</th>${isLR ? '<th>左右手</th>' : ''}<th>操作</th><th>数量</th><th>SN码</th><th>更新人</th><th>备注</th><th>操作</th></tr></thead>
          <tbody>${transactions.length === 0 ? `<tr><td colspan="${isLR ? '8' : '7'}" class="empty-text">暂无${config.name}流水记录</td></tr>` :
            transactions.map(t => `
              <tr>
                <td title="${this._formatTime(t.timestamp)}">${this._formatTime(t.timestamp)}</td>
                ${isLR ? `<td>${(t.equipmentType && t.equipmentType.endsWith('_left')) ? '左手' : '右手'}</td>` : ''}
                <td><span class="badge ${t.direction === 'in' ? 'badge-in' : 'badge-out'}">${t.direction === 'in' ? '入库' : '出库'}</span></td>
                <td>${t.quantity}</td>
                <td>${t.snCode || '-'} ${t.attachment ? '<a href="'+t.attachment+'" target="_blank" title="查看附件">📎</a>' : ''}</td>
                <td>${t.updatedBy || '-'}</td>
                <td>${t.note || '-'}</td>
                <td>${this._isPrivileged() ? `<button class="btn btn-xs btn-danger" onclick="App.deleteTransaction('${t.id}')">删除</button>` : ''}</td>
              </tr>
            `).join('')
          }</tbody>
        </table>
      </div>
    `;
    document.getElementById('main-content').innerHTML = html;
  },

  showDynamicInOutForm(tabId, configId, isLR) {
    const config = Storage.getInventoryConfig().find(c => c.id === configId);
    if (!config) return;
    const label = config.name;
    const contentHtml = `
      ${isLR ? `
      <div class="form-group">
        <label>左右手 <span class="required">*</span></label>
        <select id="dyn-hand" required>
          <option value="left">左手 (更新左手${label}库存)</option>
          <option value="right">右手 (更新右手${label}库存)</option>
        </select>
      </div>` : ''}
      <div class="form-group">
        <label>出入库 <span class="required">*</span></label>
        <select id="dyn-direction" required>
          <option value="in">入库 (+)</option>
          <option value="out">出库 (-)</option>
        </select>
      </div>
      <div class="form-group">
        <label>数量 <span class="required">*</span></label>
        <input type="number" id="dyn-qty" min="1" value="1" required>
      </div>
      <div class="form-group">
        <label>SN码 (选填)</label>
        <input type="text" id="dyn-sn" placeholder="输入SN码" autocomplete="off" oninput="App._onSNInput(this)"><span class="sn-attach-preview"></span>
        <!-- SN 自动补全改用自定义下拉 -->
      </div>
      <div class="form-group">
        <label>附件/图片</label>
        <input type="file" id="dyn-attachment" accept="image/*,.pdf" style="font-size:0.85rem;" onchange="App._onAttachmentChange(this,'dyn-sn')">
        <p class="form-hint">可为该SN码上传照片或相关附件（上传图片自动识别SN码）</p>
      </div>
      <div class="form-group">
        <label>更新人 <span class="required">*</span></label>
        <input type="text" id="dyn-user" value="${this._currentUser()}" required>
      </div>
      <div class="form-group">
        <label>备注</label>
        <textarea id="dyn-note" rows="2" placeholder="可选备注"></textarea>
      </div>
    `;
    this.showModal(`新增${label}出入库记录`, contentHtml, async () => {
      const hand = isLR ? document.getElementById('dyn-hand').value : 'single';
      const direction = document.getElementById('dyn-direction').value;
      const qty = parseInt(document.getElementById('dyn-qty').value) || 0;
      const snCode = document.getElementById('dyn-sn').value.trim();
      const user = document.getElementById('dyn-user').value.trim();
      const note = document.getElementById('dyn-note').value.trim();
      const attachment = await this._uploadAttachment(document.getElementById('dyn-attachment'));
      if (!user) { this.notify('请输入更新人', 'error'); return false; }
      if (qty <= 0) { this.notify('数量必须大于0', 'error'); return false; }

      const inventoryType = isLR ? configId + '_' + hand : configId;
      const delta = direction === 'in' ? qty : -qty;
      const result = Storage.adjustInventory(inventoryType, delta, user, snCode);
      if (!result.success) { this.notify(result.message, 'error'); return false; }

      Storage.addTransaction({
        equipmentType: inventoryType,
        handType: isLR ? hand : null,
        direction,
        quantity: qty,
        snCode: snCode || '',
        updatedBy: user,
        note: note || '',
        attachment: attachment || '',
      });
      if (direction === 'in' && snCode) {
        this._registerSN(snCode, inventoryType, isLR ? hand : null, 'available');
      } else if (direction === 'out' && snCode) {
        this._registerSN(snCode, inventoryType, isLR ? hand : null, 'transferred', '', '手动出库');
      }
      this.notifyWithUndo(`${label}${direction === 'in' ? '入库' : '出库'}成功！当前库存: ${result.newQuantity}`);
      this.switchTab(tabId);
      return true;
    });
  },

  // ==================== SN CODES ====================
  async renderSNCodes() {
    let registry, transactions;

    // 始终从服务端实时获取，保证多设备数据统一
    if (API.online) {
      try {
        const serverReg = await API.getSNRegistry();
        registry = Array.isArray(serverReg) ? serverReg : [];
        // 同步到本地缓存（服务端为权威，完全替换）
        Storage.replaceSNRegistry(registry);

        const serverTxs = await API.getTransactions(500);
        transactions = Array.isArray(serverTxs) ? serverTxs : [];
        if (transactions.length > 0) Storage.saveTransactions(transactions);
      } catch(e) {
        // 离线兜底：回退到本地缓存
        registry = Storage.getSNRegistry();
        transactions = Storage.getTransactions();
      }
    } else {
      registry = Storage.getSNRegistry();
      transactions = Storage.getTransactions();
    }

    if (this.currentTab !== 'sn-codes') return;
    this._doRenderSNCodes(registry, transactions);
  },

  // 纯渲染函数：接收数据参数，不依赖 localStorage
  _doRenderSNCodes(registry, transactions) {
    if (!registry) registry = Storage.getSNRegistry();
    if (!transactions) transactions = Storage.getTransactions();

    const invConfig = Storage.getInventoryConfig();
    const invCfgMap = {};
    invConfig.forEach(c => { invCfgMap[c.id] = c; if (c.hasLeftRight) { invCfgMap[c.id + '_left'] = { name: c.name + '左手', icon: c.icon }; invCfgMap[c.id + '_right'] = { name: c.name + '右手', icon: c.icon }; } });

    const snRelatedTypes = ['glove', 'dexterous_hand', 'left_glove', 'right_glove', 'left_dexterous_hand', 'right_dexterous_hand'];
    const allSnTxs = (transactions || []).filter(t => snRelatedTypes.includes(t.equipmentType) && t.snCode);

    function getLabel(t) {
      if (t.equipmentType === 'glove') return t.handType === 'left' ? '左手手套' : '右手手套';
      if (t.equipmentType === 'dexterous_hand') return t.handType === 'left' ? '左手灵巧手' : '右手灵巧手';
      const cfg = invCfgMap[t.equipmentType];
      return cfg ? cfg.name : t.equipmentType;
    }

    function getHandLabel(t) {
      if (t.handType === 'left') return '左手';
      if (t.handType === 'right') return '右手';
      if (t.equipmentType && t.equipmentType.endsWith('_left')) return '左手';
      if (t.equipmentType && t.equipmentType.endsWith('_right')) return '右手';
      return '';
    }

    const snMap = {};

    // 第一步：从注册表构建基础条目
    registry.forEach(r => {
      if (!r.snCode) return;
      if (r.status === '_deleted') return;
      let typeLabel = r.equipmentType || '';
      let handLabel = '';
      if (r.equipmentType === 'glove') {
        typeLabel = r.handType === 'left' ? '左手手套' : '右手手套';
        handLabel = r.handType === 'left' ? '左手' : '右手';
      } else if (r.equipmentType === 'dexterous_hand') {
        typeLabel = r.handType === 'left' ? '左手灵巧手' : '右手灵巧手';
        handLabel = r.handType === 'left' ? '左手' : '右手';
      } else {
        const cfg = invCfgMap[r.equipmentType];
        if (cfg) typeLabel = cfg.name;
      }
      snMap[r.snCode] = {
        snCode: r.snCode,
        type: typeLabel,
        handLabel: handLabel,
        attachment: r.attachment || '',
        latest: { timestamp: r.updatedAt || new Date().toISOString(), direction: 'in', snCode: r.snCode, equipmentType: r.equipmentType, handType: r.handType },
      };
    });

    // 第二步：从流水记录补充/更新信息
    const deletedSns = new Set(JSON.parse(localStorage.getItem('gms_deleted_sns') || '[]'));
    allSnTxs.forEach(t => {
      const key = t.snCode;
      if (deletedSns.has(key)) return;
      if (!snMap[key]) {
        snMap[key] = { snCode: key, type: getLabel(t), handLabel: getHandLabel(t), attachment: '', latest: t };
      } else {
        if (t.attachment && !snMap[key].attachment) snMap[key].attachment = t.attachment;
        if (new Date(t.timestamp).getTime() > new Date(snMap[key].latest.timestamp).getTime()) {
          snMap[key].latest = t;
        }
      }
    });

    const registrySnSet = new Set(registry.map(r => r.snCode).filter(Boolean));
    if (!API.online) {
      const localReg = Storage.getSNRegistry();
      localReg.forEach(r => { if (r.snCode && r.status !== '_deleted') registrySnSet.add(r.snCode); });
    }

    const snList = Object.values(snMap).filter(sn => registrySnSet.has(sn.snCode));
    snList.forEach(sn => {
      const regEntry = Storage.getSNByCode(sn.snCode);
      if (regEntry && regEntry.status === 'damaged') {
        sn.status = '损坏';
        sn.machine = regEntry.damageReason || '';
        sn.statusClass = 'badge-out';
      } else if (regEntry && regEntry.status === 'in_repair') {
        sn.status = '售后中';
        sn.machine = regEntry.trackingNumber || '';
        sn.statusClass = 'badge-out';
      } else if (regEntry && regEntry.status === 'in_use') {
        sn.status = '在用';
        sn.machine = regEntry.machineNumber || '';
        sn.statusClass = 'badge-out';
      } else if (regEntry && regEntry.status === 'available') {
        sn.status = '可用';
        sn.machine = '';
        sn.statusClass = 'badge-in';
      } else {
        const txsForSn = allSnTxs.filter(t => t.snCode === sn.snCode).sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
        const latestTx = txsForSn[0];
        if (latestTx && latestTx.direction === 'out' && latestTx.machineNumber) {
          sn.status = '在用';
          sn.machine = latestTx.machineNumber;
          sn.statusClass = 'badge-out';
        } else {
          sn.status = '可用';
          sn.machine = '';
          sn.statusClass = 'badge-in';
        }
      }
    });
    snList.sort((a, b) => new Date(b.latest.timestamp).getTime() - new Date(a.latest.timestamp).getTime());

    // 状态分组
    const inUseList = [], idleList = [], damagedList = [];
    snList.forEach(sn => {
      const reg = Storage.getSNByCode(sn.snCode);
      if (reg && reg.status === '_deleted') return;
      if (reg && (reg.status === 'in_use')) inUseList.push(sn);
      else if (reg && (reg.status === 'damaged' || reg.status === 'in_repair')) damagedList.push(sn);
      else idleList.push(sn);
    });

    const self = this;
    const viewMode = this._snViewMode || 'card';
    const currentFilter = this._snFilter || 'all';
    const counts = { all: snList.length, inuse: inUseList.length, idle: idleList.length, damaged: damagedList.length };

    const fm = t => t ? new Date(t).toLocaleString('zh-CN') : '-';

    // 统计卡片行
    const statsHtml = `<div class="ts-stats-row">
      <div class="ts-stat-card total"><div class="ts-stat-icon">🏷️</div><div class="ts-stat-content"><div class="ts-stat-value">${counts.all}</div><div class="ts-stat-label">SN总数</div></div></div>
      <div class="ts-stat-card responded"><div class="ts-stat-icon">🟢</div><div class="ts-stat-content"><div class="ts-stat-value">${counts.inuse}</div><div class="ts-stat-label">使用中</div></div></div>
      <div class="ts-stat-card pending"><div class="ts-stat-icon">🟡</div><div class="ts-stat-content"><div class="ts-stat-value">${counts.idle}</div><div class="ts-stat-label">闲置可用</div></div></div>
      <div class="ts-stat-card"><div class="ts-stat-icon">🔴</div><div class="ts-stat-content"><div class="ts-stat-value">${counts.damaged}</div><div class="ts-stat-label">售后/损坏</div></div></div>
    </div>`;

    const filterMap = { all: '全部', inuse: '使用中', idle: '闲置', damaged: '售后' };
    const toolbar = `<div class="ts-toolbar">
      <div class="ts-filter-bar">
        ${['all','inuse','idle','damaged'].map(s => `<button class="ts-filter-btn ${s===currentFilter?'active':''}" onclick="App.filterSNList('${s}')" id="sn-filter-${s}">${filterMap[s]} (${counts[s]})</button>`).join('')}
      </div>
      <div style="display:flex;gap:6px;align-items:center;">
        <input type="text" id="sn-filter-input" placeholder="🔍 搜索SN码/类型..." oninput="App._filterSNCards()" style="padding:6px 10px;border:1px solid var(--border-color);border-radius:6px;font-size:0.85rem;width:180px;">
        <button class="btn btn-sm ${viewMode==='card'?'btn-primary':'btn-outline'}" onclick="App.renderSNCodesView('card')">🃏 卡片</button>
        <button class="btn btn-sm ${viewMode==='table'?'btn-primary':'btn-outline'}" onclick="App.renderSNCodesView('table')">📋 表格</button>
      </div>
    </div>`;

    const emptyHtml = `<div class="ts-empty"><div class="ts-empty-icon">🏷️</div><div class="ts-empty-text">暂无SN码记录</div><div class="ts-empty-sub">${API.online ? '已同步服务端' : '离线模式'}</div></div>`;

    const filteredList = currentFilter === 'all' ? snList : currentFilter === 'inuse' ? inUseList : currentFilter === 'idle' ? idleList : damagedList;

    const SN_ST = { '在用': { c: 'ts-status-responded', icon: '🟢' }, '可用': { c: 'ts-status-pending', icon: '🟡' }, '损坏': { c: 'ts-status-pending', icon: '🔴' }, '售后中': { c: 'ts-status-responded', icon: '🚚' } };

    let body;
    if (viewMode === 'table') {
      body = `<div class="ts-table-wrap"><table class="ts-log-table"><thead><tr><th>SN码</th><th>设备类型</th><th>状态</th><th>所属机器</th><th>最后操作</th><th>附件</th><th>操作</th></tr></thead><tbody>
        ${filteredList.length===0?`<tr><td colspan="7">${emptyHtml}</td></tr>`:''}
        ${filteredList.map(sn => {
          const s = SN_ST[sn.status] || SN_ST['可用'];
          return `<tr data-sn-status="${sn.status==='在用'?'inuse':sn.status==='损坏'||sn.status==='售后中'?'damaged':'idle'}">
            <td><code>${sn.snCode}</code></td>
            <td>${sn.type}${sn.handLabel?' · '+sn.handLabel:''}</td>
            <td><span class="ts-status-badge ${s.c}">${s.icon} ${sn.status}</span></td>
            <td>${sn.machine||'-'}</td>
            <td style="font-size:0.8rem;white-space:nowrap;">${fm(sn.latest.timestamp)}</td>
            <td>${sn.attachment?'<a href="'+sn.attachment+'" target="_blank">📷</a>':'-'}</td>
            <td>
              ${sn.status === '可用' ? `<button class="btn btn-xs btn-warning" onclick="App._markAsDamaged('${sn.snCode}')" title="标记损坏">⚠</button>` : ''}
              ${self._isPrivileged() ? `<button class="btn btn-xs btn-danger" onclick="App._deleteSNCode('${sn.snCode.replace(/'/g,"\\'")}')" title="删除">🗑</button>` : ''}
            </td>
          </tr>`;
        }).join('')}
      </tbody></table></div>`;
    } else {
      body = `<div class="ts-list" id="sn-card-grid">
        ${filteredList.length===0?emptyHtml:''}
        ${filteredList.map(sn => {
          const s = SN_ST[sn.status] || SN_ST['可用'];
          return `<div class="ts-card ${sn.status==='在用'?'responded':sn.status==='损坏'||sn.status==='售后中'?'pending':'idle'}" data-sn-status="${sn.status==='在用'?'inuse':sn.status==='损坏'||sn.status==='售后中'?'damaged':'idle'}">
            <div class="ts-card-icon">${s.icon}</div>
            <div class="ts-card-title"><code>${sn.snCode}</code></div>
            <div class="ts-card-sub">${sn.type}${sn.handLabel?' · '+sn.handLabel:''}</div>
            ${sn.machine?`<div style="font-size:0.85rem;color:var(--text-secondary);margin-top:2px;">🖥 ${sn.machine}</div>`:''}
            <div class="ts-card-footer">
              <span>🕐 ${fm(sn.latest.timestamp)}</span>
              <span style="margin-left:auto;"><span class="ts-status-badge ${s.c}">${sn.status}</span></span>
            </div>
          </div>`;
        }).join('')}
      </div>`;
    }

    const syncLabel = API.online ? '<span style="color:var(--color-success);">● 已同步</span>' : '<span style="color:var(--color-warning);">○ 离线</span>';
    document.getElementById('main-content').innerHTML = `<div class="page-header"><h2>🏷️ SN码管理 <span style="font-size:0.5em;color:var(--text-tertiary);">v4.3</span></h2>${syncLabel}</div>${statsHtml}${toolbar}${body}`;
  },

  renderSNCodesView(viewMode) {
    this._snViewMode = viewMode;
    this._doRenderSNCodes();
  },

  filterSNList(status) {
    this._snFilter = status;
    document.querySelectorAll('.ts-filter-btn').forEach(b => b.classList.remove('active'));
    const btn = document.getElementById('sn-filter-' + status);
    if (btn) btn.classList.add('active');
    document.querySelectorAll('.ts-card[data-sn-status], tr[data-sn-status]').forEach(el => {
      if (status === 'all') { el.style.display = ''; }
      else { el.style.display = el.dataset.snStatus === status ? '' : 'none'; }
    });
  },

  _filterSNCards() {
    const q = (document.getElementById('sn-filter-input')?.value || '').toLowerCase();
    document.querySelectorAll('.ts-card[data-sn-status], tr[data-sn-status]').forEach(el => {
      const text = el.textContent.toLowerCase();
      el.style.display = text.includes(q) ? '' : 'none';
    });
  },

  _filterMachines() {
    const q = (document.getElementById('machine-search')?.value || '').toLowerCase();
    const cards = document.querySelectorAll('#machine-card-grid .machine-card');
    cards.forEach(card => {
      const num = (card.querySelector('.machine-number')?.textContent || '').toLowerCase();
      card.style.display = (!q || num.includes(q)) ? '' : 'none';
    });
  },

  _filterMachineTab(status, btn) {
    document.querySelectorAll('.machine-tab').forEach(b => { b.className = 'btn btn-sm btn-outline machine-tab'; });
    btn.className = 'btn btn-sm btn-primary machine-tab active';
    const cards = document.querySelectorAll('#machine-card-grid .machine-card');
    cards.forEach(card => {
      if (status === 'all') { card.style.display = ''; }
      else if (status === 'online') { card.style.display = card.classList.contains('online') ? '' : 'none'; }
      else if (status === 'offline') { card.style.display = card.classList.contains('offline') ? '' : 'none'; }
    });
  },

  _switchSNTab(tab, btn) {
    document.querySelectorAll('.sn-tab').forEach(b => { b.className = 'btn btn-sm btn-outline sn-tab'; });
    btn.className = 'btn btn-sm btn-primary sn-tab active';
    const cards = document.querySelectorAll('#sn-card-grid .sn-card');
    cards.forEach(card => {
      const s = card.getAttribute('data-status');
      if (tab === 'all') { card.style.display = ''; }
      else if (tab === 'inuse') { card.style.display = s === 'inuse' ? '' : 'none'; }
      else if (tab === 'idle') { card.style.display = s === 'idle' ? '' : 'none'; }
      else if (tab === 'damaged') { card.style.display = s === 'damaged' ? '' : 'none'; }
    });
  },

  _filterSNCards() {
    const q = (document.getElementById('sn-filter-input')?.value || '').toLowerCase();
    const cards = document.querySelectorAll('#sn-card-grid .sn-card');
    cards.forEach(card => {
      const code = (card.querySelector('.sn-card-code')?.textContent || '').toLowerCase();
      const type = (card.querySelector('.sn-card-type')?.textContent || '').toLowerCase();
      card.style.display = (!q || code.includes(q) || type.includes(q)) ? '' : 'none';
    });
  },

  _onSNInput(inputEl) {
    const sn = inputEl.value.trim();
    const preview = inputEl.nextElementSibling;
    if (preview && preview.classList.contains('sn-attach-preview')) {
      if (!sn) { preview.innerHTML = ''; }
      else {
        // Look up attachment from registry or transactions
        let attachment = '';
        const regEntry = Storage.getSNByCode(sn);
        if (regEntry && regEntry.attachment) attachment = regEntry.attachment;
        if (!attachment) {
          const txs = Storage.getTransactions();
          const snTx = txs.find(t => t.snCode === sn && t.attachment);
          if (snTx) attachment = snTx.attachment;
        }
        if (attachment) {
          preview.innerHTML = '<a href="' + attachment + '" target="_blank" title="查看附件"><img src="' + attachment + '" style="width:36px;height:36px;object-fit:cover;border-radius:4px;border:1px solid var(--border-color);" onerror="this.outerHTML=\'📎\'"></a>';
        } else {
          preview.innerHTML = '';
        }
      }
    }
    // 自定义自动补全下拉：支持任意位置子串匹配
    this._showSNAutocomplete(inputEl);
  },

  _compressImage(file) {
    return new Promise((resolve) => {
      if (!file.type.startsWith('image/')) {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => resolve(null);
        reader.readAsDataURL(file);
        return;
      }
      const img = new Image();
      img.onload = () => {
        const maxDim = 1024;
        let w = img.width, h = img.height;
        if (w > maxDim || h > maxDim) {
          const ratio = Math.min(maxDim / w, maxDim / h);
          w = Math.round(w * ratio); h = Math.round(h * ratio);
        }
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL('image/jpeg', 0.75));
      };
      img.onerror = () => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => resolve(null);
        reader.readAsDataURL(file);
      };
      img.src = URL.createObjectURL(file);
    });
  },

  _deleteSNCode(snCode) {
    if (!confirm('确定要删除 ' + snCode + '？此操作不可恢复！')) return;

    (async () => {
      // 获取本地SN状态，以便同步库存
      var r = Storage.getSNRegistry();
      var snEntry = r.find(function(x){ return x.snCode === snCode; });
      var wasAvailable = snEntry && snEntry.status === 'available';
      var invType = null;
      if (wasAvailable && snEntry) {
        var eq = snEntry.equipmentType, hand = snEntry.handType;
        if (eq === 'glove') invType = hand === 'left' ? 'left_glove' : 'right_glove';
        else if (eq === 'dexterous_hand') invType = hand === 'left' ? 'left_dexterous_hand' : 'right_dexterous_hand';
        else if (hand) invType = eq + '_' + hand;
        else invType = eq || 'left_glove';
      }

      if (API.online) {
        try {
          const data = await API.deleteSNFull(snCode);
          if (!data || !data.success) { alert((data && data.message) || '删除失败'); return; }
        } catch(e) { alert('网络错误'); return; }
      }
      // 本地清理：删除SN码
      Storage.saveSNRegistry(r.filter(function(x){ return x.snCode !== snCode; }));
      // 添加到墓碑集合，防止流水记录“复活”已删除的SN
      try {
        var deleted = JSON.parse(localStorage.getItem('gms_deleted_sns') || '[]');
        if (deleted.indexOf(snCode) === -1) deleted.push(snCode);
        localStorage.setItem('gms_deleted_sns', JSON.stringify(deleted));
      } catch(e) {}
      // 同步库存：删除SN码时相应的手套也被删除
      if (wasAvailable && invType) {
        var inv = Storage.getInventory(invType);
        var newQty = Math.max(0, inv.quantity - 1);
        Storage.setInventory(invType, newQty, '系统');
        if (API.online) {
          API.adjustInventory(invType, -1, '系统', '').catch(function(){});
        }
      }
      // 刷新页面内容（不使用 window.location.reload 避免重新验证token导致登出）
      App.notify(snCode + ' 已删除');
      App.renderSNCodes();
    })();
  },

  _uploadSNPhoto(snCode) {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = async () => {
      const file = input.files[0];
      if (!file) return;
      const dataUrl = await this._compressImage(file);
      if (!dataUrl) { this.notify('读取图片失败', 'error'); return; }
      let path = dataUrl;
      if (API.online) {
        try {
          const headers = { 'Content-Type': 'application/json' };
          if (API.token) headers['Authorization'] = 'Bearer ' + API.token;
          const res = await API._fetchWithTimeout(API.baseURL + '/api/upload', {
            method: 'POST', headers, body: JSON.stringify({ filename: file.name, data: dataUrl }),
          }, 15000);
          const result = await res.json();
          if (res.ok && result.path) path = result.path;
        } catch (e) { /* use dataUrl fallback */ }
      }
      // Delete old attachment file AFTER confirming new upload succeeds
      const oldEntry = Storage.getSNByCode(snCode);
      const oldAttachment = oldEntry && oldEntry.attachment;
      // Save to SN registry
      Storage.upsertSNRegistry({ snCode, attachment: path });
      if (API.online) {
        API.upsertSNRegistry({ snCode, attachment: path })
          .then(() => {
            // Only delete old attachment after server confirms new one saved
            if (oldAttachment && oldAttachment.startsWith('/uploads/')) {
              API.deleteUpload(oldAttachment).catch(() => {});
            }
          })
          .catch(() => {});
      } else if (oldAttachment && oldAttachment.startsWith('/uploads/')) {
        // Offline: delete old attachment immediately (server will sync later)
        API.deleteUpload(oldAttachment).catch(() => {});
      }
      // Also update transaction if exists
      const txs = Storage.getTransactions();
      const snTx = txs.find(t => t.snCode === snCode && t.direction === 'in');
      if (snTx) {
        snTx.attachment = path;
        const allTxs = txs.map(t => t.id === snTx.id ? snTx : t);
        Storage.saveTransactions(allTxs);
      }
      this.notify(`${snCode} 照片已更新`);
      this.renderSNCodes();
    };
    setTimeout(() => input.click(), 0);
  },


  // ==================== AFTER-SALES MANAGEMENT ====================

  async _transferOutSN(snCode) {
    var self = this;
    var reg = Storage.getSNByCode(snCode);
    if (!reg) { self.notify("SN码未注册", "error"); return; }

    var invType = reg.equipmentType;
    if (invType === "glove") invType = reg.handType === "left" ? "left_glove" : "right_glove";
    else if (invType === "dexterous_hand") invType = reg.handType === "left" ? "left_dexterous_hand" : "right_dexterous_hand";
    else if (!invType) invType = "left_glove";

    var bodyHtml = '<div style="padding:6px 0;">'
      + '<div style="margin-bottom:14px;padding:10px;background:var(--bg-secondary);border-radius:8px;">'
      + '<code style="font-weight:700;font-size:1rem;">' + snCode + '</code> | '
      + (reg.equipmentType||"") + " " + (reg.handType==="left"?"左手":reg.handType==="right"?"右手":"")
      + ' <span style="color:var(--text-tertiary);font-size:0.75rem;">→ ' + invType + '</span>'
      + '</div>'
      + '<div class="form-group">'
      + '<label>调出地点 <span class="required">*</span></label>'
      + '<input type="text" id="tf-loc" class="form-input" placeholder="广州工厂 / 上海仓库 / 北京展会">'
      + '</div></div>';

    self.showModal("📤 调出 — " + snCode, bodyHtml, async function() {
      var loc = (document.getElementById("tf-loc")?.value || "").trim();
      if (!loc) { self.notify("请输入调出地点", "warning"); return false; }
      var user = self._currentUser();

      // Step 1: SN 改状态
      self._registerSN(snCode, reg.equipmentType, reg.handType, "transferred", "", loc);

      // Step 2: 扣库存 — 先调 API，失败则告警
      var invRes = await API.adjustInventory(invType, -1, user, snCode);
      if (!invRes || !invRes.success) {
        // API 失败，用本地兜底
        Storage.adjustInventory(invType, -1, user, snCode);
        self.notify("⚠ 库存同步失败(本地已减): " + (invRes?.message || invRes?.error || "未知"), "warning");
      }

      Storage.addTransaction({
        equipmentType: reg.equipmentType, handType: reg.handType,
        direction: "out", quantity: 1, snCode: snCode,
        updatedBy: user, note: "调出→" + loc
      });

      self.notify("✅ " + snCode + " → " + loc);
      await Storage._syncFromServer();
      self.renderSNCodes();
      self.renderDashboard();
      return true;
    });
  },

  _markAsDamaged(snCode) {
    const regEntry = Storage.getSNByCode(snCode);
    if (!regEntry || regEntry.status !== 'available') { this.notify('该SN码不是空闲状态，无法标记损坏', 'error'); return; }
    const html = `<div class="form-group"><label>损坏原因</label><input type="text" id="damage-reason-direct" placeholder="描述损坏情况"></div>`;
    this.showModal('标记为损坏', html, () => {
      const reason = document.getElementById('damage-reason-direct').value.trim();
      if (!reason) { this.notify('请填写损坏原因', 'error'); return false; }
      const user = API.currentUser?.username || '系统';
      let invType = 'left_glove';
      if (regEntry.equipmentType === 'glove') invType = regEntry.handType === 'left' ? 'left_glove' : 'right_glove';
      else if (regEntry.equipmentType === 'dexterous_hand') invType = regEntry.handType === 'left' ? 'left_dexterous_hand' : 'right_dexterous_hand';
      else invType = regEntry.equipmentType || 'left_glove';
      // Decrease available inventory: glove moves from warehouse to damaged area
      Storage.adjustInventory(invType, -1, user, snCode);
      Storage.addTransaction({ equipmentType: regEntry.equipmentType, handType: regEntry.handType, direction: 'out', quantity: 1, snCode: snCode, updatedBy: user, note: '直接标记损坏: ' + reason });
      this._registerSN(snCode, regEntry.equipmentType, regEntry.handType, 'damaged', '', reason);
      this.notify(`${snCode} 已标记为损坏`);
      this.renderSNCodes();
      return true;
    });
  },

  _registerSN(snCode, equipmentType, handType, status, machineNumber, damageReason) {
    if (!snCode) return;
    const entry = { snCode, equipmentType, handType, status: status || 'available', machineNumber: machineNumber || '', damageReason: damageReason || '', updatedBy: this._currentUser() };
    Storage.upsertSNRegistry(entry);
    if (API.online) { API.upsertSNRegistry(entry).catch(() => {}); }
  },

  // 等待服务端确认的SN注册（用于机器上下线等关键操作）
  async _registerSNChecked(snCode, equipmentType, handType, status, machineNumber, damageReason) {
    if (!snCode) return true;
    const entry = { snCode, equipmentType, handType, status: status || 'available', machineNumber: machineNumber || '', damageReason: damageReason || '', updatedBy: this._currentUser() };
    Storage.upsertSNRegistry(entry);
    if (API.online) {
      try {
        const res = await API.upsertSNRegistry(entry);
        if (res && res.error) {
          this.notify(`SN码 ${snCode} 状态更新失败: ${res.error}`, 'error');
          return false;
        }
      } catch (e) {
        this.notify(`SN码 ${snCode} 状态更新网络错误`, 'error');
        return false;
      }
    }
    return true;
  },

  renderAfterSales(viewMode) {
    if (!viewMode) viewMode = this._asViewMode || 'card';
    this._asViewMode = viewMode;
    const registry = Storage.getSNRegistry();
    const allItems = registry.filter(r => r.status === 'damaged' || r.status === 'in_repair');
    const damaged = registry.filter(r => r.status === 'damaged');
    const inRepair = registry.filter(r => r.status === 'in_repair');
    const currentFilter = this._asFilter || 'all';

    const SM = {
      damaged: { l: '损坏待发', c: 'ts-status-pending', icon: '⚠️' },
      in_repair: { l: '售后中', c: 'ts-status-responded', icon: '🚚' },
    };
    const fm = t => t ? new Date(t).toLocaleString('zh-CN') : '-';

    const counts = { all: allItems.length, damaged: damaged.length, in_repair: inRepair.length };

    const statsHtml = `<div class="ts-stats-row">
      <div class="ts-stat-card total"><div class="ts-stat-icon">📋</div><div class="ts-stat-content"><div class="ts-stat-value">${counts.all}</div><div class="ts-stat-label">售后总数</div></div></div>
      <div class="ts-stat-card pending"><div class="ts-stat-icon">⚠️</div><div class="ts-stat-content"><div class="ts-stat-value">${counts.damaged}</div><div class="ts-stat-label">损坏待发</div></div></div>
      <div class="ts-stat-card responded"><div class="ts-stat-icon">🚚</div><div class="ts-stat-content"><div class="ts-stat-value">${counts.in_repair}</div><div class="ts-stat-label">售后中</div></div></div>
    </div>`;

    const toolbar = `<div class="ts-toolbar">
      <div class="ts-filter-bar">
        ${['all','damaged','in_repair'].map(s => `<button class="ts-filter-btn ${s===currentFilter?'active':''}" onclick="App.filterAfterSales('${s}')" id="as-filter-${s}">${s==='all'?'全部':s==='damaged'?'损坏待发':'售后中'} (${counts[s]})</button>`).join('')}
      </div>
      <div style="display:flex;gap:6px;">
        <button class="btn btn-sm ${viewMode==='card'?'btn-primary':'btn-outline'}" onclick="App.renderAfterSales('card')">🃏 卡片</button>
        <button class="btn btn-sm ${viewMode==='table'?'btn-primary':'btn-outline'}" onclick="App.renderAfterSales('table')">📋 表格</button>
        ${counts.damaged > 0 ? `<button class="btn btn-sm btn-primary" onclick="App._showShipDialog()">📦 发货给厂家</button>` : ''}
        ${counts.in_repair > 0 ? `<button class="btn btn-sm btn-success" onclick="App._showRepairCompleteDialog()">✅ 维修完成</button>` : ''}
      </div>
    </div>`;

    const emptyHtml = `<div class="ts-empty"><div class="ts-empty-icon">🔧</div><div class="ts-empty-text">暂无售后记录</div><div class="ts-empty-sub">设备损坏后的售后流程将在此处管理</div></div>`;

    const filteredItems = currentFilter === 'all' ? allItems : allItems.filter(i => i.status === currentFilter);

    const eqLabel = t => {
      const map = { glove: '手套', dexterous_hand: '灵巧手', gripper: '夹爪' };
      return map[t] || t;
    };
    const handLabel = h => h === 'left' ? '左手' : h === 'right' ? '右手' : '';

    let body;
    if (viewMode === 'table') {
      const cols = [
        { k: 'snCode', l: 'SN码' }, { k: 'equipmentType', l: '设备类型' }, { k: 'handType', l: '左右手' },
        { k: 'status', l: '状态' }, { k: 'damageReason', l: '损坏原因' }, { k: 'trackingNumber', l: '快递单号' },
        { k: 'machineNumber', l: '来源机器' }, { k: 'updatedAt', l: '更新时间' }
      ];
      body = `<div class="ts-table-wrap"><table class="ts-log-table"><thead><tr>
        ${cols.map(c => `<th>${c.l}</th>`).join('')}
      </tr></thead><tbody>
        ${filteredItems.length===0?`<tr><td colspan="8">${emptyHtml}</td></tr>`:''}
        ${filteredItems.map(item => { const s=SM[item.status]||SM.damaged;
          return `<tr data-as-status="${item.status}">
            <td><code>${item.snCode||'-'}</code></td>
            <td>${eqLabel(item.equipmentType)||'-'}</td>
            <td>${handLabel(item.handType)||'-'}</td>
            <td><span class="ts-status-badge ${s.c}">${s.icon} ${s.l}</span></td>
            <td>${item.damageReason||'-'}</td>
            <td>${item.trackingNumber?`📦 ${item.trackingNumber}`:'-'}</td>
            <td>${item.machineNumber||'-'}</td>
            <td style="font-size:0.8rem;white-space:nowrap;">${fm(item.updatedAt)}</td>
          </tr>`;
        }).join('')}
      </tbody></table></div>`;
    } else {
      body = `<div class="ts-list" id="as-list-container">
        ${filteredItems.length===0?emptyHtml:''}
        ${filteredItems.map(item => { const s=SM[item.status]||SM.damaged;
          return `<div class="ts-card ${item.status}" data-as-status="${item.status}">
            <div class="ts-card-icon">${s.icon}</div>
            <div class="ts-card-title"><code>${item.snCode||'-'}</code></div>
            <div class="ts-card-sub">${eqLabel(item.equipmentType)||'-'} ${handLabel(item.handType)?'· '+handLabel(item.handType):''}</div>
            ${item.damageReason?`<div style="font-size:0.85rem;color:var(--color-danger);margin-top:4px;">💔 ${item.damageReason}</div>`:''}
            ${item.trackingNumber?`<div style="font-size:0.85rem;color:var(--text-secondary);margin-top:2px;">📦 快递: ${item.trackingNumber}</div>`:''}
            <div class="ts-card-footer">
              ${item.machineNumber?`<span>🖥 ${item.machineNumber}</span>`:''}
              <span>🕐 ${fm(item.updatedAt)}</span>
              <span style="margin-left:auto;"><span class="ts-status-badge ${s.c}">${s.l}</span></span>
            </div>
          </div>`;
        }).join('')}
      </div>`;
    }

    document.getElementById('main-content').innerHTML = `<div class="page-header"><h2>🔧 售后管理</h2><span style="color:var(--text-secondary);font-size:0.85rem;">设备损坏与售后维修管理</span></div>${statsHtml}${toolbar}${body}`;
  },

  filterAfterSales(status) {
    this._asFilter = status;
    document.querySelectorAll('.ts-filter-btn').forEach(b => b.classList.remove('active'));
    const btn = document.getElementById('as-filter-' + status);
    if (btn) btn.classList.add('active');
    document.querySelectorAll('.ts-card[data-as-status], tr[data-as-status]').forEach(el => {
      if (status === 'all') { el.style.display = ''; }
      else { el.style.display = el.dataset.asStatus === status ? '' : 'none'; }
    });
  },

  _showShipDialog() {
    const damaged = Storage.getSNRegistry().filter(r => r.status === 'damaged');
    if (damaged.length === 0) { this.notify('没有待发货的损坏手套', 'warning'); return; }

    const eqCounts = {};
    damaged.forEach(r => {
      const key = this._equipmentLabel(r.equipmentType, r.handType);
      eqCounts[key] = (eqCounts[key] || 0) + 1;
    });
    const statsHtml = Object.entries(eqCounts).map(([k, v]) =>
      `<span class="ts-status-badge ts-status-pending">${k}: ${v}只</span>`
    ).join('');

    const checkboxes = damaged.map(r => `
      <label style="display:flex;align-items:center;gap:10px;padding:10px 12px;cursor:pointer;border-radius:8px;transition:all var(--transition);" onmouseenter="this.style.background='var(--bg-secondary)'" onmouseleave="this.style.background=''">
        <input type="checkbox" class="ship-sn-check" value="${r.snCode}" data-eq="${r.equipmentType}" data-hand="${r.handType||''}" data-reason="${r.damageReason||''}" style="width:18px;height:18px;accent-color:var(--color-primary);">
        <div style="flex:1;">
          <div style="font-weight:600;color:var(--text-primary);font-size:0.9rem;">${r.snCode}</div>
          <div style="font-size:0.8rem;color:var(--text-secondary);margin-top:2px;">
            ${this._equipmentLabel(r.equipmentType, r.handType)}
            ${r.handType==='left'?' · 左手':r.handType==='right'?' · 右手':''}
            ${r.damageReason?' · 损坏原因: '+r.damageReason:''}
          </div>
        </div>
      </label>`).join('');

    const html = `
      <div style="margin-bottom:16px;padding:14px 16px;background:linear-gradient(135deg,#fef3c7,#fde68a);border-radius:var(--radius-md);">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px;">
          <span style="font-size:1.5rem;">📦</span>
          <div>
            <div style="font-weight:700;color:#92400e;font-size:1rem;">发货给厂家</div>
            <div style="font-size:0.8rem;color:#b45309;">共 ${damaged.length} 只损坏设备待发货</div>
          </div>
        </div>
        <div style="display:flex;flex-wrap:wrap;gap:6px;">${statsHtml}</div>
      </div>

      <div class="ts-form-group">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
          <label class="ts-form-label" style="margin-bottom:0;">选择SN码 <span class="req">*</span></label>
          <div style="display:flex;gap:6px;">
            <button type="button" class="btn btn-xs btn-outline" onclick="document.querySelectorAll('.ship-sn-check').forEach(c=>c.checked=true)">全选</button>
            <button type="button" class="btn btn-xs btn-outline" onclick="document.querySelectorAll('.ship-sn-check').forEach(c=>c.checked=false)">取消</button>
          </div>
        </div>
        <div style="max-height:240px;overflow-y:auto;border:1.5px solid var(--border-color);border-radius:var(--radius-md);padding:4px;background:var(--bg-card);">
          ${checkboxes}
        </div>
      </div>

      <div class="ts-form-group">
        <label class="ts-form-label">快递单号 <span style="font-weight:normal;color:var(--text-tertiary);">(选填)</span></label>
        <input type="text" id="ship-tracking" class="ts-form-input" placeholder="多只一起寄时可填写快递单号">
        <div class="ts-form-hint">💡 填写快递单号后便于后续追踪物流信息</div>
      </div>
    `;
    this.showModal('📦 发货给厂家', html, () => {
      const checked = document.querySelectorAll('.ship-sn-check:checked');
      if (checked.length === 0) { this.notify('请至少选择一个SN码', 'error'); return false; }
      const tracking = document.getElementById('ship-tracking').value.trim();
      const user = API.currentUser?.username || '系统';
      checked.forEach(cb => {
        const sn = cb.value;
        const eqType = cb.dataset.eq || 'glove';
        const hand = cb.dataset.hand || 'left';
        const reason = cb.dataset.reason || '';
        Storage.addTransaction({
          equipmentType: eqType, handType: hand, direction: 'out', quantity: 1,
          snCode: sn, updatedBy: user,
          note: `售后发货给厂家${tracking ? '，快递单号: ' + tracking : ''}`,
        });
        const entry = { snCode: sn, equipmentType: eqType, handType: hand, status: 'in_repair', machineNumber: '', damageReason: reason, trackingNumber: tracking || '无单号', shippedAt: new Date().toISOString() };
        Storage.upsertSNRegistry(entry);
        if (API.online) { API.upsertSNRegistry(entry).catch(() => {}); }
      });
      this.notify(`${checked.length} 个SN码已标记为售后中${tracking ? ' · ' + tracking : ''}`);
      this.renderAfterSales();
      return true;
    });
  },

  _showRepairCompleteDialog() {
    const inRepair = Storage.getSNRegistry().filter(r => r.status === 'in_repair');
    if (inRepair.length === 0) { this.notify('没有售后中的手套', 'warning'); return; }

    const eqCounts = {};
    inRepair.forEach(r => {
      const key = this._equipmentLabel(r.equipmentType, r.handType);
      eqCounts[key] = (eqCounts[key] || 0) + 1;
    });
    const statsHtml = Object.entries(eqCounts).map(([k, v]) =>
      `<span class="ts-status-badge ts-status-responded">${k}: ${v}只</span>`
    ).join('');

    const checkboxes = inRepair.map(r => `
      <label style="display:flex;align-items:center;gap:10px;padding:10px 12px;cursor:pointer;border-radius:8px;transition:all var(--transition);" onmouseenter="this.style.background='var(--bg-secondary)'" onmouseleave="this.style.background=''">
        <input type="checkbox" class="repair-sn-check" value="${r.snCode}" data-eq="${r.equipmentType}" data-hand="${r.handType||''}" style="width:18px;height:18px;accent-color:var(--color-success);">
        <div style="flex:1;">
          <div style="font-weight:600;color:var(--text-primary);font-size:0.9rem;">${r.snCode}</div>
          <div style="font-size:0.8rem;color:var(--text-secondary);margin-top:2px;">
            ${this._equipmentLabel(r.equipmentType, r.handType)}
            ${r.handType==='left'?' · 左手':r.handType==='right'?' · 右手':''}
            ${r.trackingNumber?' 📦'+r.trackingNumber:''}
          </div>
        </div>
      </label>`).join('');

    const html = `
      <div style="margin-bottom:16px;padding:14px 16px;background:linear-gradient(135deg,#d1fae5,#a7f3d0);border-radius:var(--radius-md);">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px;">
          <span style="font-size:1.5rem;">✅</span>
          <div>
            <div style="font-weight:700;color:#065f46;font-size:1rem;">维修完成</div>
            <div style="font-size:0.8rem;color:#047857;">共 ${inRepair.length} 只设备正在售后维修中</div>
          </div>
        </div>
        <div style="display:flex;flex-wrap:wrap;gap:6px;">${statsHtml}</div>
      </div>

      <div class="ts-form-group">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
          <label class="ts-form-label" style="margin-bottom:0;">选择SN码 <span class="req">*</span></label>
          <div style="display:flex;gap:6px;">
            <button type="button" class="btn btn-xs btn-outline" onclick="document.querySelectorAll('.repair-sn-check').forEach(c=>c.checked=true)">全选</button>
            <button type="button" class="btn btn-xs btn-outline" onclick="document.querySelectorAll('.repair-sn-check').forEach(c=>c.checked=false)">取消</button>
          </div>
        </div>
        <div style="max-height:240px;overflow-y:auto;border:1.5px solid var(--border-color);border-radius:var(--radius-md);padding:4px;background:var(--bg-card);">
          ${checkboxes}
        </div>
      </div>

      <div style="padding:12px 14px;background:var(--bg-secondary);border-radius:var(--radius-md);border-left:4px solid var(--color-success);">
        <div style="display:flex;align-items:flex-start;gap:8px;">
          <span style="font-size:1.1rem;">💡</span>
          <div style="font-size:0.85rem;color:var(--text-secondary);line-height:1.5;">
            维修完成后，选中的设备将从售后状态恢复为<span style="color:var(--color-success);font-weight:600;">空闲库存</span>，并自动生成入库流水记录。
          </div>
        </div>
      </div>
    `;
    this.showModal('✅ 维修完成', html, () => {
      const checked = document.querySelectorAll('.repair-sn-check:checked');
      if (checked.length === 0) { this.notify('请至少选择一个SN码', 'error'); return false; }
      const user = API.currentUser?.username || '系统';
      checked.forEach(cb => {
        const sn = cb.value;
        const eqType = cb.dataset.eq || 'glove';
        const hand = cb.dataset.hand || 'left';
        let invType = 'left_glove';
        if (eqType === 'glove') invType = hand === 'left' ? 'left_glove' : 'right_glove';
        else if (eqType === 'dexterous_hand') invType = hand === 'left' ? 'left_dexterous_hand' : 'right_dexterous_hand';
        else invType = eqType;
        const current = Storage.getInventory(invType);
        Storage.setInventory(invType, current.quantity + 1, user);
        Storage.addTransaction({
          equipmentType: eqType, handType: hand, direction: 'in', quantity: 1,
          snCode: sn, updatedBy: user, note: '【售后完成】维修完成，回到空闲库存',
        });
        const entry = { snCode: sn, equipmentType: eqType, handType: hand, status: 'available', machineNumber: '', damageReason: '', trackingNumber: '', repairedAt: new Date().toISOString() };
        Storage.upsertSNRegistry(entry);
        if (API.online) { API.repairCompleteSN(sn).catch(() => {}); }
      });
      this.notify(`${checked.length} 个SN码已回到空闲库存`);
      this.renderAfterSales();
      return true;
    });
  },

  _getStatusCounts(inventoryType) {
    const registry = Storage.getSNRegistry();
    // Map inventory type to equipmentType + handType
    let eqType, handType;
    if (inventoryType === 'left_glove') { eqType = 'glove'; handType = 'left'; }
    else if (inventoryType === 'right_glove') { eqType = 'glove'; handType = 'right'; }
    else if (inventoryType === 'left_dexterous_hand') { eqType = 'dexterous_hand'; handType = 'left'; }
    else if (inventoryType === 'right_dexterous_hand') { eqType = 'dexterous_hand'; handType = 'right'; }
    else { eqType = inventoryType; handType = null; }
    const relevant = registry.filter(r => {
      if (r.equipmentType === eqType) {
        if (handType) return r.handType === handType;
        return true;
      }
      return r.equipmentType === inventoryType;
    });
    const inv = Storage.getInventory(inventoryType);
    const regAvailable = relevant.filter(r => r.status === 'available').length;
    const regInUse = relevant.filter(r => r.status === 'in_use').length;
    const regDamaged = relevant.filter(r => r.status === 'damaged').length;
    const regInRepair = relevant.filter(r => r.status === 'in_repair').length;
    // SN码是手套的身份证——可用数量以SN注册表为准
    return {
      total: relevant.length,
      available: regAvailable,
      inUse: regInUse,
      damaged: regDamaged,
      inRepair: regInRepair,
    };
  },

  _getAvailableInventory(type) {
    const inv = Storage.getInventory(type);
    const counts = this._getStatusCounts(type);
    return {
      ...inv,
      available: counts.available,
      damaged: counts.damaged,
      inRepair: counts.inRepair,
      inUse: counts.inUse,
    };
  },

  // ==================== MACHINE MANAGEMENT ====================
  renderMachines(viewMode) {
    if (!viewMode) viewMode = this._machineViewMode || 'card';
    this._machineViewMode = viewMode;
    const machines = Storage.getMachines();
    const onlineCount = Storage.getOnlineMachineCount();

    const latestByMachine = {};
    machines.forEach(m => {
      const existing = latestByMachine[m.machineNumber];
      const mTime = new Date(m.updatedAt || m.id || 0).getTime();
      const exTime = existing ? new Date(existing.updatedAt || existing.id || 0).getTime() : 0;
      if (!existing || mTime > exTime) {
        latestByMachine[m.machineNumber] = m;
      }
    });
    const allMachineNumbers = Object.keys(latestByMachine).sort((a, b) => {
      const na = parseInt(a, 10), nb = parseInt(b, 10);
      if (!isNaN(na) && !isNaN(nb)) return na - nb;
      return a.localeCompare(b);
    });

    const eqConfig = Storage.getEquipmentConfig();
    const typeIcon = {};
    const typeLabel = {};
    eqConfig.forEach(c => { typeIcon[c.id] = c.icon || '🖥️'; typeLabel[c.id] = c.name; });

    const currentFilter = this._machineFilter || 'all';
    const counts = { all: allMachineNumbers.length, online: onlineCount, offline: allMachineNumbers.length - onlineCount };

    // 统计卡片
    const statsHtml = `<div class="ts-stats-row">
      <div class="ts-stat-card total"><div class="ts-stat-icon">🖥️</div><div class="ts-stat-content"><div class="ts-stat-value">${counts.all}</div><div class="ts-stat-label">机器总数</div></div></div>
      <div class="ts-stat-card responded"><div class="ts-stat-icon">🟢</div><div class="ts-stat-content"><div class="ts-stat-value">${counts.online}</div><div class="ts-stat-label">在线</div></div></div>
      <div class="ts-stat-card pending"><div class="ts-stat-icon">🔴</div><div class="ts-stat-content"><div class="ts-stat-value">${counts.offline}</div><div class="ts-stat-label">离线</div></div></div>
    </div>`;

    const filterMap = { all: '全部', online: '在线', offline: '离线' };
    const toolbar = `<div class="ts-toolbar">
      <div class="ts-filter-bar">
        ${['all','online','offline'].map(s => `<button class="ts-filter-btn ${s===currentFilter?'active':''}" onclick="App.filterMachines('${s}')" id="machine-filter-${s}">${filterMap[s]} (${counts[s]})</button>`).join('')}
      </div>
      <div style="display:flex;gap:6px;align-items:center;">
        <input type="text" id="machine-search" placeholder="🔍 搜索机器编号..." oninput="App._filterMachines()" style="padding:6px 10px;border:1px solid var(--border-color);border-radius:6px;font-size:0.85rem;width:180px;">
        <button class="btn btn-sm ${viewMode==='card'?'btn-primary':'btn-outline'}" onclick="App.renderMachines('card')">🃏 卡片</button>
        <button class="btn btn-sm ${viewMode==='table'?'btn-primary':'btn-outline'}" onclick="App.renderMachines('table')">📋 表格</button>
      </div>
    </div>`;

    const emptyCardHtml = `<div class="ts-empty"><div class="ts-empty-icon">🖥️</div><div class="ts-empty-text">暂无机器记录</div><div class="ts-empty-sub">添加上/下线记录后在此显示</div></div>`;

    const stMap = {
      online: { cls: 'responded', label: '🟢 在线' },
      offline: { cls: 'pending', label: '🔴 离线' },
      waiting_repair: { cls: 'pending', label: '🔴 等待维修' },
      repairing: { cls: 'responded', label: '🟡 维修中' },
    };

    const machineCards = allMachineNumbers.map(num => {
      const m = latestByMachine[num];
      const st = m.status || 'offline';
      const s = stMap[st] || stMap.offline;
      return `<div class="ts-card ${s.cls}" data-machine-status="${st}" onclick="App.showMachineDetail('${num}')">
        <div class="ts-card-icon">${typeIcon[m.deviceType] || '🖥️'}</div>
        <div class="ts-card-title">#${num}</div>
        <div class="ts-card-sub">${typeLabel[m.deviceType] || '未知类型'}</div>
        <div class="ts-card-footer">
          <span>🕐 ${this._formatTime(m.updatedAt)}</span>
          <span style="margin-left:auto;"><span class="ts-status-badge ts-status-${s.cls}">${s.label}</span></span>
        </div>
      </div>`;
    }).join('');

    let body;
    if (viewMode === 'table') {
      const fm = t => t ? new Date(t).toLocaleString('zh-CN') : '-';
      body = `<div class="ts-table-wrap"><table class="ts-log-table"><thead><tr><th>机器编号</th><th>设备类型</th><th>状态</th><th>上线时间</th><th>下线时间</th><th>原因</th><th>更新人</th><th>操作</th></tr></thead><tbody>
        ${machines.length===0?`<tr><td colspan="8">${emptyCardHtml}</td></tr>`:''}
        ${machines.sort((a, b) => new Date(b.updatedAt || b.id) - new Date(a.updatedAt || a.id)).map(m => {
          const s = stMap[m.status] || stMap.offline;
          return `<tr data-machine-status="${m.status || 'offline'}">
            <td><strong>${m.machineNumber}</strong></td>
            <td>${typeIcon[m.deviceType] || ''} ${typeLabel[m.deviceType] || '-'}</td>
            <td><span class="ts-status-badge ts-status-${s.cls}">${s.label}</span></td>
            <td style="font-size:0.8rem;white-space:nowrap;">${fm(m.onlineTime)}</td>
            <td style="font-size:0.8rem;white-space:nowrap;">${fm(m.offlineTime)}</td>
            <td>${m.status === 'online' ? (m.onlineReason || '-') : (m.offlineReason || '-')}</td>
            <td>${m.updatedBy || '-'}</td>
            <td>${this._isPrivileged() ? `<button class="btn btn-xs btn-danger" onclick="App.deleteMachine('${m.id}')">删除</button>` : ''}</td>
          </tr>`;
        }).join('')}
      </tbody></table></div>`;
    } else {
      body = `<div class="ts-list">${machineCards || emptyCardHtml}</div>`;
    }

    const html = `
      <div class="page-header">
        <h2>🖥️ 机器管理</h2>
        <div style="display:flex;gap:6px;">
          <button class="btn btn-primary" onclick="App.showMachineForm()">+ 添加记录</button>
          <button class="btn btn-outline" onclick="App.showBulkMachineImport()">📦 批量导入</button>
        </div>
      </div>
      ${statsHtml}
      ${toolbar}
      ${body}
    `;
    document.getElementById('main-content').innerHTML = html;
  },

  filterMachines(status) {
    this._machineFilter = status;
    document.querySelectorAll('.ts-filter-btn').forEach(b => b.classList.remove('active'));
    const btn = document.getElementById('machine-filter-' + status);
    if (btn) btn.classList.add('active');
    document.querySelectorAll('.ts-card[data-machine-status], tr[data-machine-status]').forEach(el => {
      if (status === 'all') { el.style.display = ''; }
      else { el.style.display = el.dataset.machineStatus === status || el.dataset.machineStatus === (status === 'online' ? 'online' : 'offline') ? '' : 'none'; }
    });
  },

  showMachineForm(presetNumber, presetStatus) {
    const machines = Storage.getMachines();
    const existingNumbers = [...new Set(machines.map(m => m.machineNumber))];
    const datalistOptions = existingNumbers.map(n => `<option value="${n}">`).join('');
    const pn = presetNumber || '';
    const ps = presetStatus || 'online';
    const psOnlineSelected = ps === 'online' ? 'selected' : '';
    const psOfflineSelected = ps === 'offline' ? 'selected' : '';

    const contentHtml = `
      <div class="form-group">
        <label>设备类型 <span class="required">*</span></label>
        <select id="machine-device-type" required>
          ${Storage.getEquipmentConfig().map(c => {
            const consumeDesc = c.consumes.map(co => {
              const invCfg = Storage.getInventoryConfig().find(ic => ic.id === co.inventoryType);
              const invLabel = invCfg ? invCfg.name : co.inventoryType;
              let desc = invLabel;
              if (co.handType) desc = (co.handType === 'left' ? '左手' : '右手') + desc;
              desc += ' x' + co.quantity;
              return desc;
            }).join(' + ');
            return `<option value="${c.id}">${c.icon || ''} ${c.name} (消耗${consumeDesc})</option>`;
          }).join('')}
        </select>
      </div>
      <div class="form-group">
        <label>机器编号 <span class="required">*</span></label>
        <input type="text" id="machine-number" list="machine-number-list" placeholder="选择已有编号或输入新编号" value="${pn}" required autocomplete="off">
        <datalist id="machine-number-list">${datalistOptions}</datalist>
      </div>
      <div class="form-group">
        <label>上/下线 <span class="required">*</span></label>
        <select id="machine-status" required onchange="App._onMachineStatusChange()">
          <option value="online" ${psOnlineSelected}>上线 (自动扣减库存)</option>
          <option value="offline" ${psOfflineSelected}>下线 (自动归还库存)</option>
        </select>
      </div>
      <div class="form-group" id="machine-device-type-group">
        <label>原因</label>
        <input type="text" id="machine-reason" placeholder="上线或下线原因">
      </div>
      <div class="form-group" id="machine-offline-type-group" style="display:none;">
        <label>下线类型</label>
        <select id="machine-offline-type" onchange="var d=document.getElementById('machine-damage-reason-group');var t=document.getElementById('machine-transfer-location-group');var v=this.value;if(d)d.style.display=v==='damaged'?'':'none';if(t)t.style.display=v==='transfer'?'':'none';">
          <option value="normal">正常归还</option>
          <option value="damaged">手套损坏</option>
          <option value="transfer">调用/转移</option>
        </select>
      </div>
      <div class="form-group" id="machine-damage-reason-group" style="display:none;">
        <label>损坏原因</label>
        <input type="text" id="machine-damage-reason" placeholder="描述损坏情况">
      </div>
      <div class="form-group" id="machine-transfer-location-group" style="display:none;">
        <label>调出地点 <span class="required">*</span></label>
        <input type="text" id="machine-transfer-location" placeholder="例如：广州工厂、上海仓库">
      </div>
      <div class="form-group" id="machine-sn-group" style="display:none;">
        <label>SN码选择 <span style="font-weight:normal;color:var(--text-tertiary);">(SN码是每个手套/灵巧手的唯一标识)</span></label>
        <div id="machine-sn-fields"></div>
      </div>
      <div class="form-group">
        <label>更新人 <span class="required">*</span></label>
        <input type="text" id="machine-user" value="${this._currentUser()}" required>
      </div>
      <div id="machine-inventory-preview" class="form-hint" style="margin-top:8px;"></div>
      <p class="form-hint">💡 选择已有编号 → 从列表选取；新机器 → 直接输入新编号。同一编号不可重复上线/下线。</p>
    `;
    this.showModal('添加机器上/下线记录', contentHtml, async () => {
      const deviceType = document.getElementById('machine-device-type').value;
      const machineNumber = document.getElementById('machine-number').value.trim();
      const status = document.getElementById('machine-status').value;
      const reason = document.getElementById('machine-reason').value.trim();
      const user = document.getElementById('machine-user').value.trim();
      if (!machineNumber || !user) { this.notify('请填写必填字段', 'error'); return false; }

      // Read per-SN damage/transfer selections and reasons for offline mode
      const snDamageMap = {};     // sn → true (damaged)
      const snTransferMap = {};   // sn → location string (transfer)
      const snReasonMap = {};
      if (status === 'offline') {
        document.querySelectorAll('.machine-sn-damage').forEach(el => {
          snDamageMap[el.dataset.sn] = el.value === 'damaged';
          snTransferMap[el.dataset.sn] = el.value === 'transfer';
        });
        document.querySelectorAll('.machine-sn-reason').forEach(el => {
          if (snDamageMap[el.dataset.sn]) {
            snReasonMap[el.dataset.sn] = el.value.trim() || '损坏';
          } else if (snTransferMap[el.dataset.sn]) {
            snTransferMap[el.dataset.sn] = el.value.trim() || '未指定地点';
          }
        });
      }

      // Determine offline type at function scope (used by both transfer handling and inventory/Sn logic below)
      const offlineType = (status === 'offline') ? (document.getElementById('machine-offline-type')?.value) : null;

      // Handle transferred SNs — global offline type OR per-SN selection
      if (status === 'offline') {
        let transferredSNs = [];
        let transferLocation = '';

        if (offlineType === 'transfer') {
          // 全局调用：机器上所有已分配SN码全部调出
          transferLocation = document.getElementById('machine-transfer-location')?.value?.trim() || '未指定地点';
          document.querySelectorAll('.machine-sn-input, .machine-sn-damage').forEach(el => {
            const sn = el.dataset.sn || el.value?.trim();
            if (sn) transferredSNs.push(sn);
          });
          // 如果冇逐SN字段，从注册表查找
          if (transferredSNs.length === 0) {
            const registry = Storage.getSNRegistry();
            const machineSns = registry.filter(r => r.machineNumber === machineNumber && r.status === 'in_use');
            transferredSNs = machineSns.map(r => r.snCode);
          }
        } else {
          // 逐SN选择：只调出标记为 transfer 的SN
          transferredSNs = Object.entries(snTransferMap)
            .filter(([sn, isTransfer]) => isTransfer)
            .map(([sn]) => sn);
          transferLocation = Object.values(snTransferMap).find(v => v && v !== true && v !== 'true') || '';
        }

        if (transferredSNs.length > 0) {
          try {
            await API.transferGloves({ location: transferLocation || '未指定地点', reason, snCodes: transferredSNs, notes: '' });
            this.notify(`已调出 ${transferredSNs.length} 个手套到 ${transferLocation || '未指定地点'}`);
          } catch {}
        }
      }

      const machines = Storage.getMachines();
      // Check LATEST record status, not just any historical record
      const machineRecords = machines.filter(m => m.machineNumber === machineNumber);
      const latestRec = machineRecords.sort((a, b) => new Date(b.updatedAt || b.id).getTime() - new Date(a.updatedAt || a.id).getTime())[0];
      if (latestRec && latestRec.status === status) {
        this.notify(`机器 ${machineNumber} 已经是${status === 'online' ? '上线' : '下线'}状态`, 'warning');
        return false;
      }

      // Determine effective device type (for offline, use the type from existing online record)
      const existingOnline = status === 'offline' ? machines.find(m => m.machineNumber === machineNumber && m.status === 'online') : null;
      const effectiveDeviceType = (status === 'offline' && existingOnline) ? existingOnline.deviceType : deviceType;

      // Collect SN codes from the form (custom autocomplete inputs)
      const snMap = {};
      document.querySelectorAll('.machine-sn-input').forEach(input => {
        const val = input.value.trim();
        if (val) snMap[input.dataset.invType] = val;
      });

      const pairId = Object.keys(snMap).length > 0 ? Storage._generatePairId() : null;

      if (status === 'online') {
        // Validate: all glove/dex SN inputs must be filled
        const needed = Storage.getDeviceConsumptionMap(effectiveDeviceType);
        const missingSns = [];
        for (const [invType, qty] of Object.entries(needed)) {
          const isGloveType = this._isGloveType(invType);
          if (isGloveType && !snMap[invType]) {
            missingSns.push(Storage._typeLabel(invType));
          }
        }
        if (missingSns.length > 0) { this.notify(`请选择SN码：${missingSns.join('、')}`, 'error'); return false; }
        // Check inventory before going online
        const shortages = [];
        for (const [invType, qty] of Object.entries(needed)) {
          const inv = Storage.getInventory(invType);
          if (inv.quantity < qty) {
            shortages.push(`${Storage._typeLabel(invType)} (需要${qty}，当前${inv.quantity})`);
          }
        }
        if (shortages.length > 0) {
          this.notify(`库存不足：${shortages.join('、')}`, 'error');
          return false;
        }

        // Deduct inventory
        for (const [invType, qty] of Object.entries(needed)) {
          const result = Storage.adjustInventory(invType, -qty, user, machineNumber);
          if (!result.success) {
            this.notify(`${Storage._typeLabel(invType)}扣减失败: ${result.message}`, 'error');
            return false;
          }
          const eqType = (invType === 'left_glove' || invType === 'right_glove') ? 'glove'
            : (invType === 'left_dexterous_hand' || invType === 'right_dexterous_hand') ? 'dexterous_hand'
            : invType;
          const handType = (invType === 'left_glove' || invType === 'left_dexterous_hand') ? 'left'
            : (invType === 'right_glove' || invType === 'right_dexterous_hand') ? 'right'
            : null;
          Storage.addTransaction({
            equipmentType: eqType,
            handType: handType,
            direction: 'out',
            quantity: qty,
            snCode: snMap[invType] || '',
            pairId: pairId,
            machineNumber: machineNumber,
            updatedBy: user,
            note: `机器${machineNumber}上线自动扣减`,
          });
        }
      } else {
        // Return inventory when going offline (skip damaged AND transferred items)
        const needed = Storage.getDeviceConsumptionMap(effectiveDeviceType);
        for (const [invType, qty] of Object.entries(needed)) {
          const sn = snMap[invType] || '';
          const isDamaged = snDamageMap[sn] || false;
          const isTransferred = offlineType === 'transfer' || !!snTransferMap[sn];
          // Don't return damaged or transferred gloves to available inventory
          if (!isDamaged && !isTransferred) {
            Storage.adjustInventory(invType, qty, user, machineNumber);
          }
          const eqType = (invType === 'left_glove' || invType === 'right_glove') ? 'glove'
            : (invType === 'left_dexterous_hand' || invType === 'right_dexterous_hand') ? 'dexterous_hand'
            : invType;
          const handType = (invType === 'left_glove' || invType === 'left_dexterous_hand') ? 'left'
            : (invType === 'right_glove' || invType === 'right_dexterous_hand') ? 'right'
            : null;
          let offlineNote;
          if (isDamaged) offlineNote = '损坏';
          else if (isTransferred) offlineNote = '调出';
          else offlineNote = '自动归还';
          Storage.addTransaction({
            equipmentType: eqType,
            handType: handType,
            direction: 'in',
            quantity: qty,
            snCode: sn,
            pairId: pairId,
            machineNumber: machineNumber,
            updatedBy: user,
            note: `机器${machineNumber}下线${offlineNote}`,
          });
        }
      }

      const now = new Date().toISOString();

      // For offline records, carry over the onlineTime from the most recent online record
      let recordOnlineTime = status === 'online' ? now : null;
      let recordOfflineTime = status === 'offline' ? now : null;
      if (status === 'offline' && existingOnline) {
        recordOnlineTime = existingOnline.onlineTime || null;
        recordOfflineTime = now;
      }

      Storage.addMachine({
        machineNumber,
        deviceType: effectiveDeviceType,
        status,
        onlineTime: recordOnlineTime,
        offlineTime: recordOfflineTime,
        onlineReason: status === 'online' ? reason : '',
        offlineReason: status === 'offline' ? (Object.values(snDamageMap).some(v => v)
          ? Object.entries(snDamageMap).filter(([,v]) => v).map(([sn]) => sn + '(' + (snReasonMap[sn] || '损坏') + ')').join('; ')
          : reason) : '',
        updatedBy: user,
        updatedAt: now,
      });
      // Update SN registry status for each SN code (await server confirmation)
      const failedSNs = [];  // Track failures for rollback
      if (snMap && Object.keys(snMap).length > 0) {
        for (const [invType, sn] of Object.entries(snMap)) {
          if (!sn) continue;
          const eqType = (invType === 'left_glove' || invType === 'right_glove') ? 'glove'
            : (invType === 'left_dexterous_hand' || invType === 'right_dexterous_hand') ? 'dexterous_hand' : invType;
          const hType = (invType === 'left_glove' || invType === 'left_dexterous_hand') ? 'left'
            : (invType === 'right_glove' || invType === 'right_dexterous_hand') ? 'right' : null;
          if (status === 'online') {
            const ok = await this._registerSNChecked(sn, eqType, hType, 'in_use', machineNumber);
            if (!ok) failedSNs.push({ sn, invType, eqType, hType });
          } else if (status === 'offline') {
            // Use per-SN damage/transfer status and reason
            const isDamaged = snDamageMap[sn] || false;
            const isTransferred = offlineType === 'transfer' || !!snTransferMap[sn];
            let ok;
            if (isDamaged) {
              ok = await this._registerSNChecked(sn, eqType, hType, 'damaged', '', snReasonMap[sn] || reason || '损坏');
            } else if (isTransferred) {
              const loc = (typeof snTransferMap[sn] === 'string') ? snTransferMap[sn] : (document.getElementById('machine-transfer-location')?.value?.trim() || '未指定地点');
              ok = await this._registerSNChecked(sn, eqType, hType, 'transferred', '', loc);
            } else {
              ok = await this._registerSNChecked(sn, eqType, hType, 'available', '', '');
            }
            if (!ok) failedSNs.push({ sn, invType, eqType, hType });
          }
        }
      } else if (status === 'offline') {
        // No SN codes specified: clear all in_use registry entries for this machine
        const reg = Storage.getSNRegistry();
        const machineInUse = reg.filter(r => r.machineNumber === machineNumber && r.status === 'in_use');
        for (const r of machineInUse) {
          // Use per-SN damage/transfer status if available, otherwise default to available
          const isDamaged = snDamageMap[r.snCode] || false;
          const isTransferred = offlineType === 'transfer' || !!snTransferMap[r.snCode];
          let ok;
          if (isDamaged) {
            ok = await this._registerSNChecked(r.snCode, r.equipmentType, r.handType, 'damaged', '', snReasonMap[r.snCode] || reason || '损坏');
          } else if (isTransferred) {
            const loc = (typeof snTransferMap[r.snCode] === 'string') ? snTransferMap[r.snCode] : (document.getElementById('machine-transfer-location')?.value?.trim() || '未指定地点');
            ok = await this._registerSNChecked(r.snCode, r.equipmentType, r.handType, 'transferred', '', loc);
          } else {
            ok = await this._registerSNChecked(r.snCode, r.equipmentType, r.handType, 'available', '', '');
          }
          if (!ok) failedSNs.push({ sn: r.snCode, invType: this._snToInvType(r.equipmentType, r.handType), eqType: r.equipmentType, hType: r.handType });
        }
      }

      // Rollback inventory changes for failed SN registrations
      if (failedSNs.length > 0) {
        const needed = Storage.getDeviceConsumptionMap(effectiveDeviceType);
        for (const { sn, invType } of failedSNs) {
          const qty = needed[invType] || 1;
          if (status === 'online') {
            // Online failed: return the deducted inventory
            Storage.adjustInventory(invType, qty, user, machineNumber);
          } else if (status === 'offline') {
            const isDamaged = snDamageMap[sn] || false;
            const isTransferred = offlineType === 'transfer' || !!snTransferMap[sn];
            if (!isDamaged && !isTransferred) {
              // Offline normal failed: deduct the returned inventory back
              Storage.adjustInventory(invType, -qty, user, machineNumber);
            }
          }
        }
        this.notify(`⚠️ ${failedSNs.length} 个SN码状态同步失败，已回滚库存变更`, 'warning');
      }
      this.notify(`${Storage._deviceTypeLabel(effectiveDeviceType)} ${machineNumber} ${status === 'online' ? '上线' : '下线'}成功！库存已自动${status === 'online' ? '扣减' : '归还'}，当前在线机器: ${Storage.getOnlineMachineCount()} 台`);
      this.renderMachines();
      return true;
    });

    // Live preview of what will be consumed/returned
    setTimeout(() => {
      const deviceTypeSelect = document.getElementById('machine-device-type');
      const statusSelect = document.getElementById('machine-status');
      const numberInput = document.getElementById('machine-number');
      const previewEl = document.getElementById('machine-inventory-preview');
      if (!deviceTypeSelect || !statusSelect || !previewEl) return;

      // Auto-select device type from existing machine records when form is pre-filled
      if (pn && numberInput && numberInput.value) {
        const allMachines = Storage.getMachines();
        const mRecs = allMachines.filter(m => m.machineNumber === numberInput.value.trim());
        const latestM = mRecs.sort((a, b) => new Date(b.updatedAt || b.id).getTime() - new Date(a.updatedAt || a.id).getTime())[0];
        if (latestM && latestM.deviceType) {
          deviceTypeSelect.value = latestM.deviceType;
        }
      }

      const updatePreview = () => {
        const dt = deviceTypeSelect.value;
        const st = statusSelect.value;
        const needed = Storage.getDeviceConsumptionMap(dt);
        const action = st === 'online' ? '将扣减' : '将归还';
        const items = Object.entries(needed).map(([t, q]) => `${Storage._typeLabel(t)} ${q}个`).join('、');
        previewEl.textContent = `📋 ${action}: ${items}`;
      };
      deviceTypeSelect.addEventListener('change', () => { updatePreview(); App._updateMachineSNFields(); });
      statusSelect.addEventListener('change', () => { updatePreview(); App._updateMachineSNFields(); });
      updatePreview();
      App._updateMachineSNFields();
    }, 150);
  },

  deleteMachine(id) {
    if (!this._isPrivileged()) { this.notify('无删除权限，仅管理员可删除记录', 'error'); return; }
    const machines = Storage.getMachines();
    const machine = machines.find(m => m.id === id);
    if (!machine) return;

    let msg = `确认删除机器 ${machine.machineNumber} 的记录？`;
    if (machine.status === 'online') {
      const assetMap = Storage.getDeviceConsumptionMap(machine.deviceType || 'glove');
      const assetList = Object.entries(assetMap).map(([t, q]) => `${Storage._typeLabel(t)} x${q}`).join('、');
      msg += `<br><br>删除后将自动归还库存: ${assetList}`;
    }
    this.showConfirm('删除机器记录', msg, () => {
      // Return inventory if online (check SN registry for damaged items)
      if (machine.status === 'online') {
        const assetMap = Storage.getDeviceConsumptionMap(machine.deviceType || 'glove');
        const user = machine.updatedBy || '系统';
        const registry = Storage.getSNRegistry();
        for (const [invType, qty] of Object.entries(assetMap)) {
          const handType = (invType === 'left_glove' || invType === 'left_dexterous_hand') ? 'left'
            : (invType === 'right_glove' || invType === 'right_dexterous_hand') ? 'right' : null;
          // Find SNs of this type on this machine that are NOT available (damaged, in_repair, or in_use)
          const machineSns = registry.filter(r => r.machineNumber === machine.machineNumber
            && r.handType === handType);
          const unavailableSns = machineSns.filter(r => r.status === 'damaged' || r.status === 'in_repair');
          const availableSns = machineSns.filter(r => r.status !== 'damaged' && r.status !== 'in_repair');
          // Only return available SNs to inventory; damaged/in_repair stay out
          const returnQty = Math.max(0, qty - unavailableSns.length);
          if (returnQty > 0) {
            Storage.adjustInventory(invType, returnQty, user, machine.machineNumber);
          }
          Storage.addTransaction({
            equipmentType: invType === 'left_glove' || invType === 'right_glove' ? 'glove'
              : invType === 'left_dexterous_hand' || invType === 'right_dexterous_hand' ? 'dexterous_hand'
              : invType,
            handType, direction: 'in', quantity: returnQty,
            snCode: machineSns.map(s => s.snCode).join(', ') || '', machineNumber: machine.machineNumber,
            updatedBy: user,
            note: '删除机器记录' + (unavailableSns.length > 0 ? `(${unavailableSns.length}个损坏/售后未归还)` : '(自动归还)'),
          });
          // Mark available SNs as available, leave others as-is
          availableSns.forEach(r => {
            this._registerSN(r.snCode, r.equipmentType, r.handType, 'available', '', '');
          });
        }
      }

      // Also clean registry for offline machines
      if (machine.status !== 'online') {
        const registry = Storage.getSNRegistry();
        registry.filter(r => r.machineNumber === machine.machineNumber && r.status === 'in_use').forEach(r => {
          this._registerSN(r.snCode, r.equipmentType, r.handType, 'available', '', '');
        });
      }

      // Delete from server if online
      if (API.online) { API.deleteMachine(id).catch(() => {}); }

      const filtered = machines.filter(m => m.id !== id);
      Storage.saveMachines(filtered);
      this.notify(`机器 ${machine.machineNumber} 记录已删除`);
      this.renderMachines();
    });
  },

  // Called when status dropdown changes in machine form
  _onMachineStatusChange() {
    const statusSelect = document.getElementById('machine-status');
    const numberInput = document.getElementById('machine-number');
    const typeSelect = document.getElementById('machine-device-type');
    const offlineTypeGroup = document.getElementById('machine-offline-type-group');
    const damageReasonGroup = document.getElementById('machine-damage-reason-group');
    const transferLocationGroup = document.getElementById('machine-transfer-location-group');
    if (!statusSelect || !numberInput || !typeSelect) return;

    const number = numberInput.value.trim();
    if (!number) return;

    const machines = Storage.getMachines();
    const isOffline = statusSelect.value === 'offline';

    // 下线时显示全局下线类型选择
    if (offlineTypeGroup) offlineTypeGroup.style.display = isOffline ? '' : 'none';
    if (damageReasonGroup) damageReasonGroup.style.display = 'none';
    // transferLocationGroup 由 select 的 onchange 内联控制，唔好遮

    if (isOffline) {
      const existingOnline = machines.find(m => m.machineNumber === number && m.status === 'online');
      if (existingOnline && existingOnline.deviceType) {
        typeSelect.value = existingOnline.deviceType;
      }
    }
    this._updateMachineSNFields();
  },

  _onOfflineTypeChange() {
    // 已被内联 onchange 取代，保留空方法避免报错
  },

  _onMachineSnDamageChange(el) {
    const sn = el.dataset.sn;
    const reasonInput = document.querySelector(`.machine-sn-reason[data-sn="${sn}"]`);
    if (reasonInput) {
      const isDamaged = el.value === 'damaged';
      const isTransfer = el.value === 'transfer';
      reasonInput.style.display = (isDamaged || isTransfer) ? '' : 'none';
      if (isDamaged) reasonInput.placeholder = '描述损坏情况';
      else if (isTransfer) reasonInput.placeholder = '调出地点（如：广州工厂、上海仓库）';
      if (!isDamaged && !isTransfer) reasonInput.value = '';
    }
  },

  _onQtOfflineTypeChange() {
    const sel = document.getElementById('qt-offline-type');
    const damageGroup = document.getElementById('qt-damage-reason-group');
    if (sel && damageGroup) {
      damageGroup.style.display = sel.value === 'damaged' ? '' : 'none';
    }
  },

  _updateMachineSNFields() {
    const typeSelect = document.getElementById('machine-device-type');
    const snGroup = document.getElementById('machine-sn-group');
    const snFields = document.getElementById('machine-sn-fields');
    if (!typeSelect || !snGroup || !snFields) return;

    const deviceType = typeSelect.value;
    const statusSelect = document.getElementById('machine-status');
    const machineNumber = document.getElementById('machine-number')?.value.trim() || '';
    const isOffline = statusSelect && statusSelect.value === 'offline';
    const invConfig = Storage.getInventoryConfig();
    const invCfgMap = {};
    invConfig.forEach(c => { invCfgMap[c.id] = c; });

    const eqConfig = Storage.getEquipmentConfig().find(c => c.id === deviceType);
    if (!eqConfig) { snGroup.style.display = 'none'; return; }

    let hasPairs = false;
    let fieldsHtml = '';

    if (isOffline && machineNumber) {
      // 下线模式：显示当前机器上已分配的SN码，逐个选择损坏状态+独立原因
      const registry = Storage.getSNRegistry();
      let assignedSns = registry.filter(r => r.machineNumber === machineNumber && r.status === 'in_use');
      if (assignedSns.length === 0) {
        const txs = Storage.getTransactions();
        const machineTxs = txs.filter(t => t.machineNumber === machineNumber && t.snCode && t.pairId);
        const pairMap = {};
        machineTxs.forEach(t => { if (!pairMap[t.pairId]) pairMap[t.pairId] = []; pairMap[t.pairId].push(t); });
        const pairs = Object.entries(pairMap).sort((a, b) => new Date(b[1][0].timestamp).getTime() - new Date(a[1][0].timestamp).getTime());
        if (pairs.length > 0 && pairs[0][1][0].direction === 'out') {
          assignedSns = pairs[0][1].map(t => ({ snCode: t.snCode, equipmentType: t.equipmentType, handType: t.handType }));
        }
      }
      if (assignedSns.length > 0) {
        hasPairs = true;
        fieldsHtml += '<label style="font-size:0.8rem;color:var(--text-tertiary);display:block;margin-bottom:4px;">逐个选择SN码状态</label>';
        assignedSns.forEach(sn => {
          const handLabel = sn.handType === 'left' ? '左手' : sn.handType === 'right' ? '右手' : '';
          let invType = '';
          if (sn.equipmentType === 'glove') invType = sn.handType === 'left' ? 'left_glove' : 'right_glove';
          else if (sn.equipmentType === 'dexterous_hand') invType = sn.handType === 'left' ? 'left_dexterous_hand' : 'right_dexterous_hand';
          else invType = sn.equipmentType || '';
          fieldsHtml += `
            <div style="margin-bottom:6px;padding:6px 8px;background:var(--bg-tertiary);border-radius:6px;">
              <div style="display:flex;align-items:center;gap:8px;">
                <code style="font-weight:600;flex:1;">${sn.snCode}</code>
                <span style="font-size:0.75rem;color:var(--text-tertiary);">${handLabel}${sn.equipmentType}</span>
                <select class="machine-sn-damage" data-sn="${sn.snCode}" data-inv-type="${invType}" onchange="App._onMachineSnDamageChange(this)" style="width:90px;font-size:0.8rem;">
                  <option value="normal">正常</option>
                  <option value="damaged">损坏</option>
                  <option value="transfer">调用</option>
                </select>
              </div>
              <input type="text" class="machine-sn-reason" data-sn="${sn.snCode}" data-inv-type="${invType}" placeholder="填写该手套的损坏原因" style="display:none;width:100%;padding:6px 8px;margin-top:4px;font-size:0.8rem;border:1px solid var(--border-color);border-radius:4px;">
            </div>`;
        });
      } else {
        fieldsHtml = '<p style="font-size:0.8rem;color:var(--text-tertiary);">该机器无已分配的SN码</p>';
      }
    } else {
      // 上线模式：显示可用SN码下拉框
      eqConfig.consumes.forEach(consumed => {
        if (consumed.handType) {
          hasPairs = true;
          const cfg = invCfgMap[consumed.inventoryType] || {};
          const label = cfg.name || consumed.inventoryType;
          const handLabel = consumed.handType === 'left' ? '左手' : '右手';
          const availableSns = this._getAvailableSNs(consumed.inventoryType, consumed.handType);
          const inputId = `machine-sn-inp-${consumed.inventoryType}`;
          fieldsHtml += `
            <div style="margin-bottom:8px;" id="machine-sn-row-${consumed.inventoryType}">
              <span style="font-size:0.8rem;color:var(--text-tertiary);display:block;">${handLabel}${label} SN码 <span style="color:var(--color-success);" id="sn-count-${consumed.inventoryType}">(${availableSns.length}个可用)</span></span>
              <input type="text" id="${inputId}" class="machine-sn-input" data-inv-type="${consumed.inventoryType}" data-hand-type="${consumed.handType || ''}" placeholder="🔍 搜索或输入SN码..." oninput="App._onMachineSNInput(this)" onfocus="App._onMachineSNInput(this)" autocomplete="off" style="width:100%;padding:8px;border:1px solid var(--border-color);border-radius:6px;">
              <input type="hidden" id="${inputId}-value" class="machine-sn-value" data-inv-type="${consumed.inventoryType}">
            </div>`;
        }
      });
    }

    snGroup.style.display = hasPairs ? '' : 'none';
    snFields.innerHTML = fieldsHtml;
  },

  // 机器上线 SN 码自定义自动补全（支持任意位置子串匹配）
  _onMachineSNInput(inputEl) {
    const q = inputEl.value.trim().toLowerCase();
    this._hideSNAutocomplete();

    // 根据 inventoryType 和 handType 动态获取可用 SN 列表
    const invType = inputEl.getAttribute('data-inv-type') || '';
    const handType = inputEl.getAttribute('data-hand-type') || '';
    const snList = this._getAvailableSNs(invType, handType || null);

    if (!q || q.length < 1) return;

    // 子串匹配，优先开头匹配
    const startsWith = [];
    const contains = [];
    snList.forEach(sn => {
      const lower = sn.toLowerCase();
      if (lower === q) return;
      if (lower.startsWith(q)) startsWith.push(sn);
      else if (lower.includes(q)) contains.push(sn);
    });

    const matches = [...startsWith, ...contains].slice(0, 15);
    if (matches.length === 0) return;

    // 创建下拉
    const dropdown = document.createElement('div');
    dropdown.className = 'sn-autocomplete-dropdown';
    dropdown.style.cssText = 'position:fixed;z-index:9999;max-height:260px;overflow-y:auto;background:var(--bg-primary,#fff);border:1px solid var(--border-color,#e5e7eb);border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,0.15);font-size:0.85rem;';

    matches.forEach((sn) => {
      const item = document.createElement('div');
      const idx = sn.toLowerCase().indexOf(q);
      item.innerHTML = sn.substring(0, idx) + '<strong style="color:var(--color-primary,#6366f1);">' + sn.substring(idx, idx + q.length) + '</strong>' + sn.substring(idx + q.length);
      item.style.cssText = 'padding:8px 12px;cursor:pointer;border-bottom:1px solid var(--border-light,#f3f4f6);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
      item.addEventListener('mousedown', (e) => {
        e.preventDefault();
        inputEl.value = sn;
        this._hideSNAutocomplete();
        inputEl.focus();
      });
      item.addEventListener('mouseenter', () => { item.style.background = 'var(--bg-secondary,#f3f4f6)'; });
      item.addEventListener('mouseleave', () => { item.style.background = ''; });
      dropdown.appendChild(item);
    });

    // "✏️ 手动输入" 选项
    const customItem = document.createElement('div');
    customItem.style.cssText = 'padding:8px 12px;cursor:pointer;border-top:2px solid var(--border-color,#e5e7eb);color:var(--text-secondary,#6b7280);font-style:italic;';
    customItem.textContent = '✏️ 手动输入新SN码: ' + q;
    customItem.addEventListener('mousedown', (e) => {
      e.preventDefault();
      this._hideSNAutocomplete();
      inputEl.focus();
    });
    dropdown.appendChild(customItem);

    const rect = inputEl.getBoundingClientRect();
    dropdown.style.left = rect.left + 'px';
    dropdown.style.top = (rect.bottom + 2) + 'px';
    dropdown.style.width = rect.width + 'px';
    document.body.appendChild(dropdown);
    this._suggestionDropdown = dropdown;
    this._suggestionsVisible = true;

    // 点击外部关闭
    const closeHandler = (e) => {
      if (!dropdown.contains(e.target) && e.target !== inputEl) {
        this._hideSNAutocomplete();
        document.removeEventListener('click', closeHandler);
      }
    };
    setTimeout(() => document.addEventListener('click', closeHandler), 50);

    // 失焦关闭
    inputEl.addEventListener('blur', () => {
      setTimeout(() => { if (this._suggestionDropdown === dropdown) this._hideSNAutocomplete(); }, 150);
    }, { once: true });

    // 键盘导航
    inputEl.addEventListener('keydown', function handler(e) {
      if (!this._suggestionDropdown) { inputEl.removeEventListener('keydown', handler); return; }
      const items = dropdown.querySelectorAll('div');
      if (items.length === 0) return;
      let activeIdx = -1;
      items.forEach((el, i) => { if (el.style.background && el.style.background !== '') activeIdx = i; });
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        activeIdx = (activeIdx + 1) % items.length;
        items.forEach((el, i) => { el.style.background = i === activeIdx ? 'var(--bg-secondary,#f3f4f6)' : ''; });
        items[activeIdx].scrollIntoView({ block: 'nearest' });
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        activeIdx = activeIdx <= 0 ? items.length - 1 : activeIdx - 1;
        items.forEach((el, i) => { el.style.background = i === activeIdx ? 'var(--bg-secondary,#f3f4f6)' : ''; });
        items[activeIdx].scrollIntoView({ block: 'nearest' });
      } else if (e.key === 'Enter') {
        if (activeIdx >= 0) { e.preventDefault(); items[activeIdx].click(); }
      } else if (e.key === 'Escape') {
        this._hideSNAutocomplete();
      }
    }.bind(this));
  },

  showBulkMachineImport() {
    const contentHtml = `
      <p class="form-hint">批量导入机器：每行一条，格式为 <code>机器编号,设备类型(glove/dexterous/gripper),状态(online/offline),原因</code></p>
      <div class="form-group">
        <label>CSV数据</label>
        <textarea id="bulk-machine-data" rows="8" placeholder="示例：&#10;M001,glove,online,新机器上线&#10;M002,dexterous,online,新机器上线&#10;M003,gripper,offline,维护中"></textarea>
      </div>
    `;
    this.showModal('批量导入机器', contentHtml, () => {
      const data = document.getElementById('bulk-machine-data').value.trim();
      if (!data) { this.notify('请输入数据', 'error'); return false; }
      const lines = data.split('\n').filter(l => l.trim());
      let successCount = 0;
      const errors = [];
      lines.forEach(line => {
        const parts = line.split(',').map(p => p.trim());
        if (parts.length < 3) { errors.push(`格式错误: ${line}`); return; }
        const [machineNumber, deviceType, status, reason] = parts;
        if (!['glove', 'dexterous', 'gripper'].includes(deviceType)) { errors.push(`无效设备类型: ${machineNumber}`); return; }
        if (!['online', 'offline'].includes(status)) { errors.push(`无效状态: ${machineNumber}`); return; }

        const machines = Storage.getMachines();
        const mRecs = machines.filter(m => m.machineNumber === machineNumber);
        const latestM = mRecs.sort((a, b) => new Date(b.updatedAt || b.id).getTime() - new Date(a.updatedAt || a.id).getTime())[0];
        if (latestM && latestM.status === status) { errors.push(`${machineNumber} 已为${status === 'online' ? '上线' : '下线'}状态`); return; }

        const user = API.currentUser ? API.currentUser.username : '批量导入';
        if (status === 'online') {
          const needed = Storage.getDeviceConsumptionMap(deviceType);
          const shortages = [];
          for (const [invType, qty] of Object.entries(needed)) {
            const inv = Storage.getInventory(invType);
            if (inv.quantity < qty) shortages.push(`${Storage._typeLabel(invType)}(需要${qty},当前${inv.quantity})`);
          }
          if (shortages.length > 0) { errors.push(`${machineNumber} 库存不足: ${shortages.join('、')}`); return; }
          for (const [invType, qty] of Object.entries(needed)) {
            Storage.adjustInventory(invType, -qty, user, machineNumber);
            const eqType = (invType === 'left_glove' || invType === 'right_glove') ? 'glove'
              : (invType === 'left_dexterous_hand' || invType === 'right_dexterous_hand') ? 'dexterous_hand' : invType;
            const handType = (invType === 'left_glove' || invType === 'left_dexterous_hand') ? 'left'
              : (invType === 'right_glove' || invType === 'right_dexterous_hand') ? 'right' : null;
            Storage.addTransaction({
              equipmentType: eqType, handType, direction: 'out', quantity: qty,
              snCode: '', machineNumber, updatedBy: user, note: '批量导入机器上线自动扣减',
            });
          }
        }
        const now = new Date().toISOString();
        Storage.addMachine({
          machineNumber, deviceType, status,
          onlineTime: status === 'online' ? now : null,
          offlineTime: status === 'offline' ? now : null,
          onlineReason: status === 'online' ? (reason || '') : '',
          offlineReason: status === 'offline' ? (reason || '') : '',
          updatedBy: user, updatedAt: now,
        });
        successCount++;
      });
      if (errors.length > 0) {
        this.notify(`导入完成: 成功 ${successCount} 条，失败 ${errors.length} 条`, 'warning');
      } else {
        this.notify(`批量导入成功！共处理 ${successCount} 条记录`);
      }
      this.renderMachines();
      return true;
    });
  },

  // Show breakdown of online machines by equipment type
  showOnlineMachineBreakdown() {
    const machines = Storage.getMachines();
    const latestByMachine = {};
    machines.forEach(m => {
      const existing = latestByMachine[m.machineNumber];
      const mTime = new Date(m.updatedAt || m.id || 0).getTime();
      const exTime = existing ? new Date(existing.updatedAt || existing.id || 0).getTime() : 0;
      if (!existing || mTime > exTime) {
        latestByMachine[m.machineNumber] = m;
      }
    });
    const onlineMachines = Object.values(latestByMachine).filter(m => m.status === 'online');

    const typeIcon = { glove: '🧤', dexterous: '🤖', gripper: '🔧' };
    const typeLabel = { glove: '纯手套设备', dexterous: '灵巧手设备', gripper: '夹爪设备' };

    let breakdown = { glove: [], dexterous: [], gripper: [] };
    onlineMachines.forEach(m => {
      const type = m.deviceType || 'glove';
      if (breakdown[type]) breakdown[type].push(m.machineNumber);
      else breakdown[m.deviceType] = [m.machineNumber];
    });

    const rows = Object.entries(breakdown).filter(([,v]) => v.length > 0).map(([type, nums]) => `
      <div class="breakdown-row">
        <span class="breakdown-icon">${typeIcon[type] || '📦'}</span>
        <span class="breakdown-type">${typeLabel[type] || type}</span>
        <span class="breakdown-count">${nums.length} 台</span>
        <span class="breakdown-machines">${nums.join(', ')}</span>
      </div>
    `).join('');

    const contentHtml = `
      <div class="breakdown-popover">
        <div class="breakdown-summary">在线机器共 <strong>${onlineMachines.length}</strong> 台</div>
        <div class="breakdown-list">${rows || '<p class="empty-text">暂无在线机器</p>'}</div>
        <div class="breakdown-footer">
          <small>总机器数: ${Object.keys(latestByMachine).length} 台 | 利用率: ${Object.keys(latestByMachine).length > 0 ? Math.round(onlineMachines.length / Object.keys(latestByMachine).length * 100) : 0}%</small>
        </div>
      </div>
    `;

    this._showInfoModal('在线机器详情', contentHtml);
  },

  showTotalInventoryDetail() {
    const self = this;
    function showType(t, label, icon) {
      const counts = self._getStatusCounts(t);
      const inCompany = counts.available + counts.inUse + counts.damaged;
      return { type: t, label: label, icon: icon, total: inCompany, avail: counts.available, damaged: counts.damaged, repair: counts.inRepair, inUse: counts.inUse };
    }
    // Glove breakdown
    const gloveTypes = [
      showType('left_glove', '左手手套', '🧤'),
      showType('right_glove', '右手手套', '🧤'),
    ];
    const gloveTotal = gloveTypes.reduce((s,i) => s + i.total, 0);

    // Dexterous hand breakdown
    const dexTypes = [
      showType('left_dexterous_hand', '左手灵巧手', '🤖'),
      showType('right_dexterous_hand', '右手灵巧手', '🤖'),
    ];
    const dexTotal = dexTypes.reduce((s,i) => s + i.total, 0);

    const items = [...gloveTypes, ...dexTypes];
    const invConfig = Storage.getInventoryConfig();
    invConfig.filter(c => c.hasLeftRight && c.id !== 'left_glove' && c.id !== 'right_glove' && c.id !== 'left_dexterous_hand' && c.id !== 'right_dexterous_hand').forEach(c => {
      ['_left', '_right'].forEach(suffix => {
        const t = c.id + suffix;
        items.push(showType(t, c.icon + ' ' + c.name + (suffix === '_left' ? '左手' : '右手'), c.icon || '📦'));
      });
    });

    const pairCount = Math.min(gloveTypes[0].total, gloveTypes[1].total);
    const summaryHtml = `
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:16px;">
        <div style="padding:12px;background:var(--bg-tertiary);border-radius:8px;text-align:center;">
          <div style="font-size:2rem;">🧤</div>
          <div style="font-weight:700;font-size:1.2rem;">手套 ${gloveTotal} 只 · ${pairCount} 对</div>
          <div style="font-size:0.75rem;color:var(--text-tertiary);">左${gloveTypes[0].total} · 右${gloveTypes[1].total}</div>
        </div>
        <div style="padding:12px;background:var(--bg-tertiary);border-radius:8px;text-align:center;">
          <div style="font-size:2rem;">🤖</div>
          <div style="font-weight:700;font-size:1.2rem;">灵巧手 ${dexTotal} 只</div>
          <div style="font-size:0.75rem;color:var(--text-tertiary);">左${dexTypes[0].total} · 右${dexTypes[1].total}</div>
        </div>
      </div>`;

    const rows = items.map(i => `
      <div class="breakdown-row">
        <span class="breakdown-icon">${i.icon}</span>
        <span class="breakdown-type">${i.label}</span>
        <span class="breakdown-count">${i.total}只</span>
        <span style="font-size:0.75rem;color:var(--text-tertiary);">空闲:${i.avail} 使用:${i.inUse} 损坏:${i.damaged} ${i.repair > 0 ? '售后(厂家):' + i.repair : ''}</span>
      </div>`).join('');

    // Build full SN list for printing
    const registry = Storage.getSNRegistry();
    const allSnEntries = registry.filter(r => r.status !== '_deleted');
    const snPrintRows = allSnEntries.map(r => {
      const handLabel = r.handType === 'left' ? '左手' : r.handType === 'right' ? '右手' : '-';
      const statusLabel = { available: '空闲', in_use: '使用中', damaged: '损坏', in_repair: '售后中' }[r.status] || r.status;
      return `<tr><td>${self._formatTime(r.updatedAt)}</td><td>${r.equipmentType} ${handLabel}</td><td><code>${r.snCode}</code></td><td>${statusLabel}</td><td>${r.machineNumber||'-'}</td></tr>`;
    }).join('');

    const contentHtml = `
      <div class="breakdown-list">${rows}</div>
      <div style="margin-top:12px;"><button class="btn btn-sm btn-outline" onclick="App._exportAllSNExcel()">📥 导出全部库存库存Excel</button></div>
      <div style="margin-top:12px;border-top:1px solid var(--border-color);padding-top:12px;">
        <p style="font-weight:600;margin-bottom:8px;">⚡ 快速左/右手入库</p>
        <p class="form-hint" style="margin-bottom:8px;">手套: <code>L/R+SN码</code> 如 <code>LWG1JA02260403004</code> · 灵巧手: <code>QL/QR+SN码</code> 如 <code>QL347A386D3433</code><br>支持换行/空格批量输入</p>
        <textarea id="quick-lr-input" rows="4" placeholder="RWG1K01260321284&#10;LWG1JA02260403004" style="width:100%;padding:8px;border:1px solid var(--border-color);border-radius:6px;font-family:monospace;"></textarea>
        <button class="btn btn-primary btn-sm" style="margin-top:8px;" onclick="App._quickLRInbound()">📥 快速入库</button>
        <span id="quick-lr-result" style="margin-left:8px;font-size:0.8rem;color:var(--text-tertiary);"></span>
      </div>
      <table id="all-sn-print-table" style="display:none;"><thead><tr><th>时间</th><th>设备类型</th><th>SN码</th><th>状态</th><th>机器编号</th></tr></thead><tbody>${snPrintRows}</tbody></table>
    `;
    this._showInfoModal('全部库存明细', contentHtml);
  },

  _exportAllSNExcel() {
    const registry = Storage.getSNRegistry();
    const txs = Storage.getTransactions();
    // Build updater map: first from registry (most reliable), then from transactions
    const updaterMap = {};
    registry.forEach(r => {
      if (r.snCode && r.updatedBy && !updaterMap[r.snCode]) updaterMap[r.snCode] = r.updatedBy;
    });
    txs.forEach(t => {
      if (t.snCode && t.updatedBy && !updaterMap[t.snCode]) updaterMap[t.snCode] = t.updatedBy;
    });
    // Fuzzy fallback: if exact SN not found, try matching without hand-prefix (L/R/QL/QR)
    const fuzzyMatch = (sn) => {
      if (updaterMap[sn]) return updaterMap[sn];
      // Try stripping L/R/QL/QR prefix
      let bareSn = sn.replace(/^[LR]/, '').replace(/^Q[LR]/, '');
      if (bareSn !== sn && updaterMap[bareSn]) return updaterMap[bareSn];
      // Try adding common prefixes
      for (const prefix of ['L', 'R', 'QL', 'QR']) {
        if (updaterMap[prefix + sn]) return updaterMap[prefix + sn];
      }
      // Try substring match
      for (const [key, val] of Object.entries(updaterMap)) {
        if (key.includes(sn) || sn.includes(key)) return val;
      }
      return '';
    };
    const eqLabels = { glove: '手套', dexterous_hand: '灵巧手', gripper: '夹爪' };
    const rows = registry.filter(r => r.status !== '_deleted').map(r => {
      let eqLabel = eqLabels[r.equipmentType] || r.equipmentType || '-';
      const handLabel = r.handType === 'left' ? '左手' : r.handType === 'right' ? '右手' : '';
      eqLabel = handLabel ? handLabel + eqLabel : eqLabel;
      const statusLabel = r.status === 'available' ? '可用' : r.status === 'in_use' ? '使用中' : r.status === 'damaged' ? '损坏' : r.status === 'in_repair' ? '售后维修中' : (r.status || '-');
      return [this._formatTime(r.updatedAt), eqLabel, r.snCode, statusLabel, r.machineNumber || '', r.updatedBy || fuzzyMatch(r.snCode)];
    });
    const header = ['时间', '设备类型', 'SN码', '状态', '机器编号', '更新人'];
    const BOM = '﻿';
    const csv = BOM + [header, ...rows].map(row => row.map(c => '"' + String(c || '').replace(/"/g, '""') + '"').join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = '全部库存库存-' + new Date().toISOString().slice(0, 10) + '.csv';
    a.click();
    URL.revokeObjectURL(url);
    this.notify('Excel文件已导出');
  },

  _importLRJSON(fileInput) {
    const file = fileInput.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        let codes = [];
        if (Array.isArray(data)) {
          data.forEach(item => {
            if (typeof item === 'string') { codes.push(item); }
            else if (item.sn && item.hand) { codes.push(item.hand.toUpperCase() + item.sn); }
            else if (item.code) { codes.push(item.code); }
          });
        } else if (typeof data === 'object') {
          Object.values(data).forEach(v => {
            if (typeof v === 'string') codes.push(v);
            else if (Array.isArray(v)) codes = codes.concat(v.filter(x => typeof x === 'string'));
          });
        }
        const textarea = document.getElementById('quick-lr-input');
        if (textarea) {
          textarea.value = codes.join('\n');
          document.getElementById('quick-lr-result').textContent = `📂 已加载 ${codes.length} 条记录，点击"快速入库"`;
          document.getElementById('quick-lr-result').style.color = 'var(--text-secondary)';
        }
      } catch (e) {
        const el = document.getElementById('quick-lr-result');
        el.textContent = '❌ JSON格式错误';
        el.style.color = 'red';
      }
    };
    reader.readAsText(file);
    fileInput.value = '';
  },

  _quickLRInbound() {
    const input = document.getElementById('quick-lr-input');
    const resultEl = document.getElementById('quick-lr-result');
    if (!input || !resultEl) return;
    const text = input.value.trim();
    if (!text) { resultEl.textContent = '请输入SN码'; resultEl.style.color = 'red'; return; }
    const lines = text.split(/[\n\r\s,;]+/).filter(Boolean);
    const user = API.currentUser?.username || '系统';
    const registry = Storage.getSNRegistry();
    const existingSns = new Set(registry.map(r => r.snCode));
    let count = 0, dupCount = 0;
    const errors = [];
    lines.forEach(code => {
      code = code.trim().toUpperCase();
      if (code.length < 2) return;
      let sn, hand, eqType, invType;
      // QL = left dexterous hand, QR = right dexterous hand
      if (code.startsWith('QL') && code.length > 2) {
        sn = code.substring(2); hand = 'left'; eqType = 'dexterous_hand'; invType = 'left_dexterous_hand';
      } else if (code.startsWith('QR') && code.length > 2) {
        sn = code.substring(2); hand = 'right'; eqType = 'dexterous_hand'; invType = 'right_dexterous_hand';
      } else if ((code[0] === 'L' || code[0] === 'R') && code.length > 1) {
        sn = code.substring(1); hand = code[0] === 'L' ? 'left' : 'right'; eqType = 'glove';
        invType = hand === 'left' ? 'left_glove' : 'right_glove';
      } else {
        errors.push(code + '(无效格式)'); return;
      }
      // Check duplicate
      // Use full code (including prefix) as SN key to avoid left/right collisions
      const fullSn = code; // e.g. L01234 or R01234
      const shortSn = sn; // legacy short form without prefix
      if (existingSns.has(fullSn) || existingSns.has(shortSn)) { errors.push(code + '(SN重复)'); dupCount++; return; }
      const result = Storage.adjustInventory(invType, 1, user, fullSn);
      if (!result.success) { errors.push(code + '(' + result.message + ')'); return; }
      Storage.addTransaction({ equipmentType: eqType, handType: hand, direction: 'in', quantity: 1, snCode: fullSn, updatedBy: user, note: '快速入库' });
      this._registerSN(fullSn, eqType, hand, 'available');
      existingSns.add(fullSn);
      count++;
    });
    if (count > 0) {
      resultEl.textContent = `✅ 成功入库 ${count} 只` + (dupCount > 0 ? `，跳过${dupCount}条重复` : '') + (errors.length ? '，' + errors.join(', ') : '');
      resultEl.style.color = '#10b981';
      input.value = '';
    } else {
      resultEl.textContent = '❌ ' + (errors.join(', ') || '入库失败');
      resultEl.style.color = 'red';
    }
  },

  // Show inventory details popup (replaces switchTab navigation from dashboard cards)
  showInventoryBreakdown(type, label) {
    const inv = Storage.getInventory(type);
    const transactions = Storage.getTransactions()
      .filter(t => t.equipmentType === type
        || (type === 'left_glove' && t.equipmentType === 'glove' && t.handType === 'left')
        || (type === 'right_glove' && t.equipmentType === 'glove' && t.handType === 'right')
        || (type === 'left_dexterous_hand' && t.equipmentType === 'dexterous_hand' && t.handType === 'left')
        || (type === 'right_dexterous_hand' && t.equipmentType === 'dexterous_hand' && t.handType === 'right'))
      .slice(0, 10);

    const icon = type.includes('glove') ? '🧤' : type.includes('dexterous') ? '🤖' : '🔧';

    const contentHtml = `
      <div class="breakdown-popover">
        <div class="breakdown-summary">
          <span style="font-size:2rem;">${icon}</span>
          <strong>${label}</strong> 当前库存: <strong style="font-size:1.3rem;">${inv.quantity}</strong> 个
        </div>
        <div class="breakdown-meta">
          最后更新: ${this._formatTime(inv.updatedAt)} | 更新人: ${inv.updatedBy || '无'}
        </div>
        <div style="margin:12px 0;display:flex;gap:8px;">
          <button class="btn btn-sm btn-primary" onclick="App.quickInOut('${type}','in')">+ 入库</button>
          <button class="btn btn-sm btn-primary" onclick="App.quickInOut('${type}','out')">- 出库</button>
          ${API.currentUser && API.currentUser.role === 'superadmin' ? `<button class="btn btn-sm btn-danger" onclick="App.showSetInventoryModal('${type}','${label}')">✎ 直接设置库存</button>` : ''}
        </div>
        <h4 style="margin-top:12px;">最近10条流水</h4>
        <div class="mini-list">${this._renderRecentTransactions(transactions)}</div>
      </div>
    `;

    this._showInfoModal(`${label} 库存详情`, contentHtml);
  },

  // Superadmin: directly set inventory quantity
  showSetInventoryModal(type, label) {
    const current = Storage.getInventory(type);
    const contentHtml = `
      <div class="form-group">
        <label>当前库存</label>
        <input type="text" value="${current.quantity}" disabled>
      </div>
      <div class="form-group">
        <label>新库存数量 <span class="required">*</span></label>
        <input type="number" id="set-inv-qty" min="0" value="${current.quantity}" required>
        <p class="form-hint">⚠ 直接覆盖库存计数器，差值将记录为调整流水。显示的空闲库存以实际SN码数量为准。</p>
      </div>
      <div class="form-group">
        <label>操作原因</label>
        <input type="text" id="set-inv-reason" placeholder="请输入操作原因">
      </div>
    `;
    this.showModal(`直接设置 ${label} 库存`, contentHtml, () => {
      const newQty = parseInt(document.getElementById('set-inv-qty').value);
      const reason = document.getElementById('set-inv-reason').value.trim();
      if (isNaN(newQty) || newQty < 0) { this.notify('请输入有效的库存数量', 'error'); return false; }
      const delta = newQty - current.quantity;
      const user = this._currentUser();
      Storage.setInventory(type, newQty, user);
      if (API.online) {
        API.adjustInventory(type, delta, user, '').catch(() => {});
      }
      Storage.addTransaction({
        equipmentType: type, handType: null,
        direction: delta >= 0 ? 'in' : 'out',
        quantity: Math.abs(delta),
        snCode: '', machineNumber: '',
        updatedBy: user,
        note: `直接设置库存: ${current.quantity}→${newQty}${reason ? ' (' + reason + ')' : ''}`,
      });
      this.notify(`${label} 库存已从 ${current.quantity} 设置为 ${newQty}`);
      this.renderDashboard();
      return true;
    });
  },

  // Show today's transactions popup
  showTodayTransactions() {
    const transactions = Storage.getTransactions();
    const todayStart = new Date().setHours(0, 0, 0, 0);
    const todayTx = transactions.filter(t => new Date(t.timestamp).getTime() >= todayStart);

    const inCount = todayTx.filter(t => t.direction === 'in').length;
    const outCount = todayTx.filter(t => t.direction === 'out').length;
    const byType = {};
    todayTx.forEach(t => {
      const key = t.equipmentType || 'other';
      byType[key] = (byType[key] || 0) + 1;
    });

    const typeRows = Object.entries(byType).map(([k, v]) => {
      const labels = { glove: '手套', dexterous_hand: '灵巧手', gripper: '夹爪' };
      return `<div class="breakdown-row"><span>${labels[k] || k}</span><span class="breakdown-count">${v} 条</span></div>`;
    }).join('');

    const contentHtml = `
      <div class="breakdown-popover">
        <div class="breakdown-summary">今日操作共 <strong>${todayTx.length}</strong> 条</div>
        <div class="breakdown-list">
          <div class="breakdown-row"><span>📥 入库</span><span class="breakdown-count">${inCount} 条</span></div>
          <div class="breakdown-row"><span>📤 出库</span><span class="breakdown-count">${outCount} 条</span></div>
          ${typeRows}
        </div>
        <h4 style="margin-top:12px;">今日流水</h4>
        <div class="mini-list">${this._renderRecentTransactions(todayTx.slice(0, 15))}</div>
        <div style="margin-top:8px;text-align:right;">
          <button class="btn btn-sm btn-outline" onclick="App.switchTab('transactions')">查看全部流水 →</button>
        </div>
      </div>
    `;

    this._showInfoModal('今日操作记录', contentHtml);
  },

  // Helper: show modal with no save button (info-only)
  _showInfoModal(title, contentHtml) {
    const overlay = document.getElementById('modal-overlay');
    const body = document.getElementById('modal-body');
    const titleEl = document.getElementById('modal-title');
    const saveBtn = document.getElementById('modal-save');
    const closeBtn = document.getElementById('modal-close-btn');

    titleEl.textContent = title;
    body.innerHTML = contentHtml;
    saveBtn.style.display = 'none';
    if (closeBtn) closeBtn.textContent = '关闭';
    overlay.style.display = 'flex';

    const cleanup = () => {
      saveBtn.style.display = '';
      if (closeBtn) closeBtn.textContent = '取消';
      document.getElementById('modal-close').onclick = () => { overlay.style.display = 'none'; };
      if (closeBtn) closeBtn.onclick = () => { overlay.style.display = 'none'; };
      overlay.onclick = (e) => { if (e.target === overlay) overlay.style.display = 'none'; };
    };
    document.getElementById('modal-close').onclick = () => { overlay.style.display = 'none'; cleanup(); };
    if (closeBtn) closeBtn.onclick = () => { overlay.style.display = 'none'; cleanup(); };
    overlay.onclick = (e) => { if (e.target === overlay) { overlay.style.display = 'none'; cleanup(); } };
  },

  // Detailed machine view
  showMachineDetail(machineNumber) {
    const machines = Storage.getMachines().filter(m => m.machineNumber === machineNumber);
    if (machines.length === 0) return;

    // Sort by time
    const sorted = machines.sort((a, b) => new Date(a.updatedAt || a.id) - new Date(b.updatedAt || b.id));
    const latest = sorted[sorted.length - 1];
    const isOnline = latest.status === 'online';
    const isWaitingRepair = latest.status === 'waiting_repair';
    const isRepairing = latest.status === 'repairing';
    const isActive = isOnline || isWaitingRepair || isRepairing; // machine has SN codes attached
    const deviceType = latest.deviceType || 'glove';

    const eqConfig = Storage.getEquipmentConfig();
    const typeIcon = {};
    const typeLabel = {};
    eqConfig.forEach(c => { typeIcon[c.id] = c.icon || '🖥️'; typeLabel[c.id] = c.name; });
    if (!typeIcon.glove) typeIcon.glove = '🧤';
    if (!typeIcon.dexterous) typeIcon.dexterous = '🤖';
    if (!typeIcon.gripper) typeIcon.gripper = '🔧';
    if (!typeLabel.glove) typeLabel.glove = '纯手套设备';
    if (!typeLabel.dexterous) typeLabel.dexterous = '灵巧手设备';
    if (!typeLabel.gripper) typeLabel.gripper = '夹爪设备';

    // Calculate total online duration
    let totalOnlineMs = 0;
    let currentSessionStart = null;
    for (let i = 0; i < sorted.length; i++) {
      const m = sorted[i];
      if (m.status === 'online' && m.onlineTime) {
        currentSessionStart = new Date(m.onlineTime);
        // Look for next offline record
        const nextOffline = sorted.slice(i + 1).find(n => n.status === 'offline' && n.machineNumber === machineNumber);
        if (nextOffline && nextOffline.offlineTime) {
          totalOnlineMs += new Date(nextOffline.offlineTime).getTime() - new Date(m.onlineTime).getTime();
        }
      }
    }
    // If currently online or in repair state, add current session
    if (isActive && currentSessionStart) {
      totalOnlineMs += Date.now() - currentSessionStart.getTime();
    }

    const formatDuration = (ms) => {
      if (ms < 0) return '0分钟';
      const hours = Math.floor(ms / 3600000);
      const minutes = Math.floor((ms % 3600000) / 60000);
      if (hours > 0) return `${hours}小时${minutes}分钟`;
      return `${minutes}分钟`;
    };

    // Current session duration
    let currentSessionDuration = '-';
    if (isActive) {
      const lastOnline = [...sorted].reverse().find(m => m.status === 'online');
      if (lastOnline && lastOnline.onlineTime) {
        currentSessionDuration = formatDuration(Date.now() - new Date(lastOnline.onlineTime).getTime());
      }
    }

    // Assets consumed
    const assetMap = Storage.getDeviceConsumptionMap(deviceType);
    const assetLabels = Object.entries(assetMap).map(([t, q]) => `${Storage._typeLabel(t)} x${q}`).join('、');

    // Timeline
    const timelineHtml = sorted.map((m, idx) => {
      const isOnlineEvent = m.status === 'online';
      const time = m.status === 'online' ? m.onlineTime : m.offlineTime;
      // Calculate session duration for online→offline pairs
      let sessionDur = '';
      if (isOnlineEvent && m.onlineTime) {
        const nextOff = sorted.slice(idx + 1).find(n => n.status === 'offline');
        if (nextOff && nextOff.offlineTime) {
          sessionDur = formatDuration(new Date(nextOff.offlineTime).getTime() - new Date(m.onlineTime).getTime());
        } else if (isOnline) {
          sessionDur = '进行中...';
        }
      }
      return `
        <div class="timeline-item ${isOnlineEvent ? 'online' : 'offline'}">
          <div class="timeline-dot"></div>
          <div class="timeline-content">
            <div class="timeline-header">
              <span class="badge ${isOnlineEvent ? 'badge-online' : 'badge-offline'}">${isOnlineEvent ? '上线' : '下线'}</span>
              <span class="timeline-time">${this._formatTime(time)}</span>
              ${sessionDur ? `<span class="timeline-duration">⏱ ${sessionDur}</span>` : ''}
            </div>
            <div class="timeline-meta">
              ${isOnlineEvent ? (m.onlineReason ? `原因: ${m.onlineReason}` : '') : (m.offlineReason ? `原因: ${m.offlineReason}` : '')}
              ${m.updatedBy ? ` | 操作人: ${m.updatedBy}` : ''}
            </div>
          </div>
        </div>
      `;
    }).join('');

    const contentHtml = `
      <div class="machine-detail">
        <div class="detail-hero">
          <div class="detail-hero-icon">${typeIcon[deviceType] || '🖥️'}</div>
          <div class="detail-hero-info">
            <h2>机器 #${machineNumber}</h2>
            <div class="detail-hero-type">${typeLabel[deviceType] || '未知类型'}</div>
            <div class="detail-hero-status">
              <span class="status-dot ${isOnline ? 'online' : (isWaitingRepair || isRepairing) ? 'repairing' : 'offline'}"></span>
              ${isOnline ? '在线' : isWaitingRepair ? '等待维修' : isRepairing ? '维修中' : '离线'}
              ${isActive ? ` · 当前已运行 ${currentSessionDuration}` : ''}
            </div>
          </div>
        </div>

        <div class="detail-stats">
          <div class="detail-stat">
            <div class="detail-stat-label">累计在线时长</div>
            <div class="detail-stat-value">${formatDuration(totalOnlineMs)}</div>
          </div>
          <div class="detail-stat">
            <div class="detail-stat-label">消耗资产</div>
            <div class="detail-stat-value small">${assetLabels}</div>
          </div>
          <div class="detail-stat">
            <div class="detail-stat-label">操作记录数</div>
            <div class="detail-stat-value">${sorted.length}</div>
          </div>
        </div>

        <div class="detail-actions">
          ${isOnline ? `
            <button class="btn btn-warning" onclick="App.quickMachineOffline('${machineNumber}')" style="width:100%;padding:12px;font-size:1rem;">🔴 下线该机器</button>
          ` : `
            <button class="btn btn-success" onclick="App.quickMachineOnline('${machineNumber}')" style="width:100%;padding:12px;font-size:1rem;">🟢 上线该机器</button>
          `}
          ${isOnline ? `<button class="btn btn-outline" onclick="App.showMachineFormWithPreset('${machineNumber}','offline')" style="width:100%;margin-top:6px;">📝 详细下线表单</button>` : ''}
        </div>

        ${this._renderMachineSNPairs(machineNumber)}

        <h4 class="detail-section-title">📋 操作时间线</h4>
        <div class="timeline">
          ${timelineHtml}
        </div>
      </div>
    `;

    this._showInfoModal(`机器 #${machineNumber} 详情`, contentHtml);
  },

  quickMachineOnline(machineNumber) {
    // Close the detail modal, then open the machine form pre-filled for online
    document.getElementById('modal-overlay').style.display = 'none';
    this._showQuickToggleForm(machineNumber, 'online');
  },

  quickMachineOffline(machineNumber) {
    document.getElementById('modal-overlay').style.display = 'none';
    this._showQuickToggleForm(machineNumber, 'offline');
  },

  showMachineFormWithPreset(machineNumber, status) {
    document.getElementById('modal-overlay').style.display = 'none';
    this.showMachineForm(machineNumber, status);
  },

  _showQuickToggleForm(machineNumber, status) {
    const machines = Storage.getMachines();
    const latest = machines.filter(m => m.machineNumber === machineNumber).sort((a, b) => new Date(b.updatedAt || b.id) - new Date(a.updatedAt || a.id))[0];
    const deviceType = latest ? latest.deviceType : 'glove';
    const eqConfig = Storage.getEquipmentConfig().find(c => c.id === deviceType);
    const deviceLabel = eqConfig ? eqConfig.name : Storage._deviceTypeLabel(deviceType);

    const contentHtml = `
      <div style="text-align:center;margin-bottom:16px;">
        <p style="font-size:1.1rem;"><strong>机器 #${machineNumber}</strong></p>
        <p style="color:var(--text-secondary);">${deviceLabel} · ${status === 'online' ? '🟢 上线' : '🔴 下线'}</p>
      </div>
      <div class="form-group">
        <label>原因</label>
        <input type="text" id="qt-reason" placeholder="${status === 'online' ? '上线原因' : '下线原因'}">
      </div>
      ${status === 'offline' ? this._buildOfflineSNFields(machineNumber, deviceType) : ''}
      ${status === 'online' ? `
      <div class="form-group" id="qt-sn-group">
        <label>SN码选择 <span style="font-weight:normal;color:var(--text-tertiary);">(选填，仅手套/灵巧手)</span></label>
        <div id="qt-sn-fields">${this._buildSNSelects(deviceType)}</div>
      </div>
      ` : ''}
      <div class="form-group">
        <label>更新人 <span class="required">*</span></label>
        <input type="text" id="qt-user" value="${this._currentUser()}" required>
      </div>
      <div id="qt-preview" class="form-hint" style="margin-top:8px;">${this._getTogglePreview(deviceType, status)}</div>
    `;
    this.showModal(
      status === 'online' ? '🟢 机器上线' : '🔴 机器下线',
      contentHtml,
      async () => {
        const reason = document.getElementById('qt-reason').value.trim();
        // Read per-SN actions (normal/damaged/transfer) and reasons
        const snActionMap = {}; // 'normal' | 'damaged' | 'transfer'
        const snReasonMap = {};
        if (status === 'offline') {
          document.querySelectorAll('.qt-sn-damage').forEach(el => {
            snActionMap[el.dataset.sn] = el.value; // 'normal', 'damaged', or 'transfer'
          });
          // Read damage reasons
          document.querySelectorAll('.qt-sn-damage-reason').forEach(el => {
            if (snActionMap[el.dataset.sn] === 'damaged') {
              snReasonMap[el.dataset.sn] = el.value.trim() || '损坏';
            }
          });
          // Read transfer reasons
          document.querySelectorAll('.qt-sn-transfer-reason').forEach(el => {
            if (snActionMap[el.dataset.sn] === 'transfer') {
              snReasonMap[el.dataset.sn] = el.value.trim() || '调用';
            }
          });
        }
        const user = document.getElementById('qt-user').value.trim();
        if (!user) { this.notify('请输入更新人', 'error'); return false; }

        const machines2 = Storage.getMachines();
        // Check LATEST record status, not just any historical record
        const machineRecords = machines2.filter(m => m.machineNumber === machineNumber);
        const latestRecord = machineRecords.sort((a, b) => new Date(b.updatedAt || b.id).getTime() - new Date(a.updatedAt || a.id).getTime())[0];
        if (latestRecord && latestRecord.status === status) { this.notify(`机器 ${machineNumber} 已经是${status === 'online' ? '上线' : '下线'}状态`, 'warning'); return false; }

        // Collect SN codes (select + custom input)
        const snMap = {};
        document.querySelectorAll('.qt-sn-select').forEach(sel => {
          if (sel.value && sel.value !== '__custom__' && sel.value !== '') {
            snMap[sel.dataset.invType] = sel.value.trim();
          }
        });
        document.querySelectorAll('.qt-sn-input').forEach(input => {
          if (input.value.trim()) snMap[input.dataset.invType] = input.value.trim();
        });
        const pairId = Object.keys(snMap).length > 0 ? Storage._generatePairId() : null;

        const effectiveDeviceType = (status === 'offline')
          ? (machines2.find(m => m.machineNumber === machineNumber && m.status === 'online') || {}).deviceType || deviceType
          : deviceType;

        const needed = Storage.getDeviceConsumptionMap(effectiveDeviceType);

        if (status === 'online') {
          // Validate: all glove/dex SN inputs must be filled
          const missingSns = [];
          for (const [invType, qty] of Object.entries(needed)) {
            const isGloveType = this._isGloveType(invType);
            if (isGloveType && !snMap[invType]) {
              missingSns.push(Storage._typeLabel(invType));
            }
          }
          if (missingSns.length > 0) { this.notify(`请选择SN码：${missingSns.join('、')}`, 'error'); return false; }
          const shortages = [];
          for (const [invType, qty] of Object.entries(needed)) {
            const inv = Storage.getInventory(invType);
            if (inv.quantity < qty) shortages.push(`${Storage._typeLabel(invType)}(需要${qty},当前${inv.quantity})`);
          }
          if (shortages.length > 0) { this.notify(`库存不足：${shortages.join('、')}`, 'error'); return false; }
          for (const [invType, qty] of Object.entries(needed)) {
            Storage.adjustInventory(invType, -qty, user, machineNumber);
            const eqType = (invType === 'left_glove' || invType === 'right_glove') ? 'glove'
              : (invType === 'left_dexterous_hand' || invType === 'right_dexterous_hand') ? 'dexterous_hand' : invType;
            const handType = (invType === 'left_glove' || invType === 'left_dexterous_hand') ? 'left'
              : (invType === 'right_glove' || invType === 'right_dexterous_hand') ? 'right' : null;
            Storage.addTransaction({
              equipmentType: eqType, handType, direction: 'out', quantity: qty,
              snCode: snMap[invType] || '', pairId, machineNumber, updatedBy: user,
              note: `机器${machineNumber}上线自动扣减`,
            });
          }
        } else {
          // Build set of inventory types with damaged/transfer SNs
          const damagedInvTypes = new Set();
          const transferInvTypes = new Set();
          if (status === 'offline') {
            document.querySelectorAll('.qt-sn-damage').forEach(el => {
              if (el.value === 'damaged' && el.dataset.invType) {
                damagedInvTypes.add(el.dataset.invType);
              } else if (el.value === 'transfer' && el.dataset.invType) {
                transferInvTypes.add(el.dataset.invType);
              }
            });
          }
          for (const [invType, qty] of Object.entries(needed)) {
            const isDamaged = damagedInvTypes.has(invType);
            const isTransfer = transferInvTypes.has(invType);
            const sn = document.querySelector(`.qt-sn-damage[data-inv-type="${invType}"]`);
            const snCode = sn ? sn.dataset.sn : (snMap[invType] || '');
            // 损坏和调用都不归还库存
            if (!isDamaged && !isTransfer) {
              Storage.adjustInventory(invType, qty, user, machineNumber);
            }
            const eqType = (invType === 'left_glove' || invType === 'right_glove') ? 'glove'
              : (invType === 'left_dexterous_hand' || invType === 'right_dexterous_hand') ? 'dexterous_hand' : invType;
            const handType = (invType === 'left_glove' || invType === 'left_dexterous_hand') ? 'left'
              : (invType === 'right_glove' || invType === 'right_dexterous_hand') ? 'right' : null;
            const noteLabel = isDamaged ? '损坏' : isTransfer ? '调用' : '自动归还';
            Storage.addTransaction({
              equipmentType: eqType, handType, direction: 'in', quantity: qty,
              snCode: snCode, pairId, machineNumber, updatedBy: user,
              note: `机器${machineNumber}下线${noteLabel}`,
            });
          }
        }

        const now = new Date().toISOString();
        let recordOnlineTime = status === 'online' ? now : null;
        let recordOfflineTime = status === 'offline' ? now : null;
        if (status === 'offline') {
          const onlineRec = machines2.find(m => m.machineNumber === machineNumber && m.status === 'online');
          if (onlineRec) recordOnlineTime = onlineRec.onlineTime || null;
        }

        Storage.addMachine({
          machineNumber, deviceType: effectiveDeviceType, status,
          onlineTime: recordOnlineTime, offlineTime: recordOfflineTime,
          onlineReason: status === 'online' ? reason : '',
          offlineReason: status === 'offline'
            ? (reason ? reason + '; ' : '')
              + Object.entries(snActionMap)
                .filter(([, v]) => v !== 'normal')
                .map(([sn, v]) => sn + '(' + (v === 'damaged' ? '损坏' : '调用') + (snReasonMap[sn] ? ': ' + snReasonMap[sn] : '') + ')')
                .join('; ')
            : '',
          updatedBy: user, updatedAt: now,
        });
        // Update SN registry — ALWAYS update for every inventory type in needed (await server confirmation)
        for (const [invType, qty] of Object.entries(needed)) {
          const eqType = (invType === 'left_glove' || invType === 'right_glove') ? 'glove'
            : (invType === 'left_dexterous_hand' || invType === 'right_dexterous_hand') ? 'dexterous_hand' : invType;
          const hType = (invType === 'left_glove' || invType === 'left_dexterous_hand') ? 'left'
            : (invType === 'right_glove' || invType === 'right_dexterous_hand') ? 'right' : null;
          // Find SN code for this inventory type
          let snCode = '';
          const snEl = document.querySelector(`.qt-sn-damage[data-inv-type="${invType}"]`);
          if (snEl) {
            snCode = snEl.dataset.sn;
            if (snEl.value === 'damaged') {
              await this._registerSNChecked(snCode, eqType, hType, 'damaged', '', snReasonMap[snCode] || reason || '损坏');
            } else if (snEl.value === 'transfer') {
              await this._registerSNChecked(snCode, eqType, hType, 'transferred', '', snReasonMap[snCode] || reason || '调用');
            } else {
              await this._registerSNChecked(snCode, eqType, hType, 'available', '', '');
            }
          } else if (snMap[invType]) {
            snCode = snMap[invType];
            if (status === 'online') {
              await this._registerSNChecked(snCode, eqType, hType, 'in_use', machineNumber);
            } else if (status === 'offline') {
              const isDam = damagedInvTypes.has(invType);
              await this._registerSNChecked(snCode, eqType, hType, isDam ? 'damaged' : 'available', '', isDam ? (snReasonMap[snCode] || reason || '损坏') : '');
            }
          }
        }
        // Also clear old in_use registry entries for this machine when going offline
        if (status === 'offline') {
          const reg = Storage.getSNRegistry();
          const machineInUse = reg.filter(r => r.machineNumber === machineNumber && r.status === 'in_use');
          for (const r of machineInUse) {
            // Check per-SN action selections to avoid overwriting
            const action = snActionMap[r.snCode] || 'normal';
            const invType = (r.equipmentType === 'glove' ? (r.handType === 'left' ? 'left_glove' : 'right_glove')
              : r.equipmentType === 'dexterous_hand' ? (r.handType === 'left' ? 'left_dexterous_hand' : 'right_dexterous_hand')
              : r.equipmentType);
            const isDam = action === 'damaged' || damagedInvTypes.has(invType);
            const isTransfer = action === 'transfer' || transferInvTypes.has(invType);
            if (isDam) {
              await this._registerSNChecked(r.snCode, r.equipmentType, r.handType, 'damaged', '', snReasonMap[r.snCode] || reason || '损坏');
            } else if (isTransfer) {
              await this._registerSNChecked(r.snCode, r.equipmentType, r.handType, 'transferred', '', snReasonMap[r.snCode] || reason || '调用');
            } else {
              await this._registerSNChecked(r.snCode, r.equipmentType, r.handType, 'available', '', '');
            }
          }
        }
        this.notify(`${deviceLabel} ${machineNumber} ${status === 'online' ? '上线' : '下线'}成功！`);
        this.renderMachines();
        return true;
      }
    );
  },

  _getAvailableSNs(inventoryType, handType) {
    const registry = Storage.getSNRegistry();
    // Map inventory type to equipmentType + handType
    let eqType, hType;
    if (inventoryType === 'left_glove') { eqType = 'glove'; hType = 'left'; }
    else if (inventoryType === 'right_glove') { eqType = 'glove'; hType = 'right'; }
    else if (inventoryType === 'left_dexterous_hand') { eqType = 'dexterous_hand'; hType = 'left'; }
    else if (inventoryType === 'right_dexterous_hand') { eqType = 'dexterous_hand'; hType = 'right'; }
    else if (handType) { eqType = inventoryType + '_' + handType; hType = handType; }
    else { eqType = inventoryType; hType = null; }

    // ONLY use registry — it's the single source of truth for SN status
    const deletedSns = new Set(JSON.parse(localStorage.getItem('gms_deleted_sns') || '[]'));
    return registry
      .filter(r => {
        if (r.status !== 'available') return false;
        if (deletedSns.has(r.snCode)) return false;
        if (r.equipmentType !== eqType) return false;
        if (hType && r.handType !== hType) return false;
        return true;
      })
      .map(r => r.snCode);
  },

  _buildOfflineSNFields(machineNumber, deviceType) {
    // Find SN codes currently assigned to this machine
    const registry = Storage.getSNRegistry();
    let assignedSns = registry.filter(r => r.machineNumber === machineNumber && r.status === 'in_use');
    // Fallback: check transactions for the latest online pair (any SN with this machineNumber)
    if (assignedSns.length === 0) {
      const txs = Storage.getTransactions();
      const machineTxs = txs.filter(t => t.machineNumber === machineNumber && t.snCode);
      const pairMap = {};
      machineTxs.forEach(t => { if (!pairMap[t.pairId || '_nopair_']) pairMap[t.pairId || '_nopair_'] = []; pairMap[t.pairId || '_nopair_'].push(t); });
      const pairs = Object.entries(pairMap).sort((a, b) => new Date(b[1][0].timestamp || 0).getTime() - new Date(a[1][0].timestamp || 0).getTime());
      if (pairs.length > 0) {
        // Find the latest "out" direction transactions
        const latestOut = machineTxs.filter(t => t.direction === 'out').sort((a, b) => new Date(b.timestamp || 0).getTime() - new Date(a.timestamp || 0).getTime());
        if (latestOut.length > 0) {
          assignedSns = latestOut.map(t => ({
            snCode: t.snCode,
            equipmentType: t.equipmentType,
            handType: t.handType,
          }));
        }
      }
    }
    if (assignedSns.length === 0) return '<p style="font-size:0.8rem;color:var(--text-tertiary);">该机器无已分配的SN码</p>';

    let html = '<div class="form-group"><label>SN码状态 <span style="font-weight:normal;color:var(--text-tertiary);">（逐个选择是否损坏）</span></label>';
    assignedSns.forEach((sn, i) => {
      const handLabel = sn.handType === 'left' ? '左手' : sn.handType === 'right' ? '右手' : '';
      // Compute inventory type for mapping
      let invType = '';
      if (sn.equipmentType === 'glove') invType = sn.handType === 'left' ? 'left_glove' : 'right_glove';
      else if (sn.equipmentType === 'dexterous_hand') invType = sn.handType === 'left' ? 'left_dexterous_hand' : 'right_dexterous_hand';
      else invType = sn.equipmentType || '';
      html += `
        <div style="margin-bottom:6px;padding:6px 8px;background:var(--bg-tertiary);border-radius:6px;">
          <div style="display:flex;align-items:center;gap:8px;">
            <code style="font-weight:600;flex:1;">${sn.snCode}</code>
            <span style="font-size:0.75rem;color:var(--text-tertiary);">${handLabel}${sn.equipmentType}</span>
            <select class="qt-sn-damage" data-sn="${sn.snCode}" data-inv-type="${invType}" onchange="App._onSnDamageChange(this)" style="width:90px;font-size:0.8rem;">
              <option value="normal">正常</option>
              <option value="damaged">损坏</option>
              <option value="transfer">调用</option>
            </select>
          </div>
          <input type="text" class="qt-sn-reason qt-sn-damage-reason" data-sn="${sn.snCode}" data-inv-type="${invType}" placeholder="填写损坏原因" style="display:none;width:100%;padding:6px 8px;margin-top:4px;font-size:0.8rem;border:1px solid var(--border-color);border-radius:4px;">
          <input type="text" class="qt-sn-reason qt-sn-transfer-reason" data-sn="${sn.snCode}" data-inv-type="${invType}" placeholder="填写调用去向（如：调往XX机器/XX项目）" style="display:none;width:100%;padding:6px 8px;margin-top:4px;font-size:0.8rem;border:1px solid var(--border-color);border-radius:4px;">
        </div>`;
    });
    html += '</div>';
    return html;
  },

  _onSnDamageChange(el) {
    // 显示/隐藏当前SN的损坏原因或调用去向输入框
    const sn = el.dataset.sn;
    const damageInput = document.querySelector(`.qt-sn-damage-reason[data-sn="${sn}"]`);
    const transferInput = document.querySelector(`.qt-sn-transfer-reason[data-sn="${sn}"]`);
    // Hide all first, then show the relevant one
    if (damageInput) { damageInput.style.display = 'none'; damageInput.value = ''; }
    if (transferInput) { transferInput.style.display = 'none'; transferInput.value = ''; }
    if (el.value === 'damaged' && damageInput) {
      damageInput.style.display = '';
    } else if (el.value === 'transfer' && transferInput) {
      transferInput.style.display = '';
    }
  },

  _buildSNSelects(deviceType) {
    const eqConfig = Storage.getEquipmentConfig().find(c => c.id === deviceType);
    if (!eqConfig) return '';
    const invConfig = Storage.getInventoryConfig();
    const invCfgMap = {};
    invConfig.forEach(c => { invCfgMap[c.id] = c; });

    let html = '';
    eqConfig.consumes.forEach(consumed => {
      if (consumed.handType) {
        const cfg = invCfgMap[consumed.inventoryType] || {};
        const label = cfg.name || consumed.inventoryType;
        const handLabel = consumed.handType === 'left' ? '左手' : '右手';
        const availableSns = this._getAvailableSNs(consumed.inventoryType, consumed.handType);
        const selectId = `qt-sn-sel-${consumed.inventoryType}`;
        const inputId = `qt-sn-inp-${consumed.inventoryType}`;
        html += `
          <div style="margin-bottom:8px;">
            <span style="font-size:0.8rem;color:var(--text-tertiary);display:block;margin-bottom:2px;">${handLabel}${label} <span style="color:var(--color-success);">(${availableSns.length}个可用)</span></span>
            <select id="${selectId}" class="qt-sn-select" data-inv-type="${consumed.inventoryType}" data-target="${inputId}" onchange="App._onQtSnSelectChange(this)" style="width:100%;padding:8px;border:1px solid var(--border-color);border-radius:6px;">
              <option value="">-- 选择SN码 --</option>
              ${availableSns.map(s => `<option value="${s}">${s}</option>`).join('')}
              <option value="__custom__">✏️ 输入新SN码</option>
            </select>
            <input type="text" id="${inputId}" class="qt-sn-input" data-inv-type="${consumed.inventoryType}" placeholder="输入新SN码" style="display:none;width:100%;padding:8px;margin-top:4px;border:1px solid var(--border-color);border-radius:6px;" autocomplete="off">
          </div>`;
      }
    });
    return html || '<p style="font-size:0.8rem;color:var(--text-tertiary);">该设备类型不需要SN码</p>';
  },

  _onQtSnSelectChange(sel) {
    const inp = document.getElementById(sel.dataset.target);
    if (sel.value === '__custom__') { sel.style.display = 'none'; if (inp) inp.style.display = ''; }
    else { if (inp) { inp.style.display = 'none'; inp.value = ''; } }
  },

  _getTogglePreview(deviceType, status) {
    const needed = Storage.getDeviceConsumptionMap(deviceType);
    const action = status === 'online' ? '将扣减' : '将归还';
    const items = Object.entries(needed).map(([t, q]) => `${Storage._typeLabel(t)} ${q}个`).join('、');
    return `📋 ${action}: ${items}`;
  },

  _renderMachineSNPairs(machineNumber) {
    // 显示该机器上所有关联的 SN 码
    // 优先从 SN Registry（单一数据源）查询，再从交易记录补充
    const transactions = Storage.getTransactions();
    const snRegistry = Storage.getSNRegistry();

    // 1. 先从 SN Registry 找：当前在此机器上的 SN 码
    const registrySns = snRegistry.filter(r =>
      r.machineNumber === machineNumber && r.snCode
    );

    // 2. 再找与此机器相关的交易中有 SN 码的
    const machineTxs = transactions.filter(t =>
      t.snCode && t.machineNumber === machineNumber
    );

    // 3. 合并 registry SN codes（这些是当前真实配对）
    const seenSns = new Set();
    const allSnEntries = []; // { snCode, equipmentType, handType, status, source }

    // 优先添加 Registry 中的（当前状态最准确）
    registrySns.forEach(r => {
      if (!seenSns.has(r.snCode)) {
        seenSns.add(r.snCode);
        allSnEntries.push({
          snCode: r.snCode,
          equipmentType: r.equipmentType || '',
          handType: r.handType || '',
          status: r.status || 'in_use',
          source: 'registry',
          timestamp: r.updatedAt || '',
          direction: r.status === 'in_use' ? 'out' : 'in',
        });
      }
    });

    // 补充交易中的（可能包含历史记录或 registry 没有的）
    machineTxs.forEach(t => {
      if (!seenSns.has(t.snCode)) {
        seenSns.add(t.snCode);
        allSnEntries.push({
          snCode: t.snCode,
          equipmentType: t.equipmentType || '',
          handType: t.handType || '',
          status: t.direction === 'out' ? 'in_use' : 'available',
          source: 'transaction',
          timestamp: t.timestamp || '',
          direction: t.direction || 'in',
        });
      }
    });

    if (allSnEntries.length === 0) return '';

    const getHand = (t) => {
      if (t.handType === 'left') return '左手';
      if (t.handType === 'right') return '右手';
      if (t.equipmentType && t.equipmentType.endsWith('_left')) return '左手';
      if (t.equipmentType && t.equipmentType.endsWith('_right')) return '右手';
      // Infer from SN registry
      if (t.snCode) {
        const reg = snRegistry.find(r => r.snCode === t.snCode);
        if (reg && reg.handType) return reg.handType === 'left' ? '左手' : '右手';
      }
      return '通用';
    };

    const getEqLabel = (t) => {
      if (t.equipmentType === 'glove') return '🧤 手套';
      if (t.equipmentType === 'dexterous_hand') return '🤖 灵巧手';
      if (t.equipmentType === 'gripper') return '🔧 夹爪';
      return '📦 ' + (t.equipmentType || '设备');
    };

    // Build SN display
    const snDisplay = (sn) => {
      if (!sn || sn === '-') return sn;
      const reg = Storage.getSNByCode(sn);
      if (reg && reg.attachment) {
        return '<a href="#" onclick="event.preventDefault();App._showSNAttachment(\'' + sn + '\')" style="color:var(--color-primary);text-decoration:underline;cursor:pointer;" title="点击查看附件">' + sn + ' 📎</a>';
      }
      return sn;
    };

    // Build status badge for SN code
    const snStatusBadge = (sn) => {
      const reg = Storage.getSNByCode(sn);
      if (!reg) return '';
      const statusMap = {
        available: { cls: 'badge-online', label: '空闲' },
        in_use: { cls: 'badge-warning', label: '使用中' },
        damaged: { cls: 'badge-danger', label: '损坏' },
        in_repair: { cls: 'badge-info', label: '售后中' },
        transferred: { cls: '', label: '已调出' },
      };
      const s = statusMap[reg.status] || { cls: '', label: reg.status || '未知' };
      return '<span class="badge ' + s.cls + '" style="font-size:0.7rem;margin-left:4px;">' + s.label + '</span>';
    };

    let html = '<h4 class="detail-section-title">🏷️ 关联 SN 码</h4><div class="sn-pair-list">';

    // 配对展示：左手 + 右手为一对
    // 先分左右手，再配对展示
    const leftEntries = allSnEntries.filter(e => getHand(e) === '左手');
    const rightEntries = allSnEntries.filter(e => getHand(e) === '右手');
    const otherEntries = allSnEntries.filter(e => getHand(e) !== '左手' && getHand(e) !== '右手');

    // 展示所有当前配对（Registry 来源优先）
    const isActive = allSnEntries.some(e => e.direction === 'out' || e.status === 'in_use');

    // 按左右手配对展示（取最大数量）
    const pairCount = Math.max(leftEntries.length, rightEntries.length, 1);
    for (let i = 0; i < pairCount; i++) {
      const left = leftEntries[i] || null;
      const right = rightEntries[i] || null;
      if (!left && !right) continue;

      const leftActive = left && (left.status === 'in_use' || left.direction === 'out');
      const rightActive = right && (right.status === 'in_use' || right.direction === 'out');
      const pairActive = leftActive || rightActive;

      html +=
        '<div class="sn-pair-card" style="margin-bottom:8px;' + (pairActive ? '' : 'opacity:0.65;') + '">' +
          '<div class="sn-pair-header">' +
            '<span class="sn-pair-id">🔗 ' + (left ? getEqLabel(left) : getEqLabel(right)) + ' 配对 #' + (i + 1) + '</span>' +
            '<span style="font-size:0.7rem;padding:2px 6px;border-radius:4px;' + (pairActive ? 'background:#dcfce7;color:#166534;' : 'background:#f3f4f6;color:#6b7280;') + '">' + (pairActive ? '🟢 当前' : '📦 历史') + '</span>' +
          '</div>' +
          '<div class="sn-pair-body">' +
            '<div class="sn-pair-col"><div class="sn-pair-label">左手 SN码</div><div class="sn-pair-value">' + snDisplay(left ? left.snCode : '-') + (left ? snStatusBadge(left.snCode) : '') + '</div></div>' +
            '<div class="sn-pair-col"><div class="sn-pair-label">右手 SN码</div><div class="sn-pair-value">' + snDisplay(right ? right.snCode : '-') + (right ? snStatusBadge(right.snCode) : '') + '</div></div>' +
          '</div>' +
        '</div>';
    }

    // 展示非左右手的 SN 码（如夹爪等）
    if (otherEntries.length > 0) {
      html += '<div class="sn-pair-card" style="margin-bottom:8px;">' +
        '<div class="sn-pair-header"><span>🔧 其他设备 SN 码</span></div>' +
        '<div class="sn-pair-body">' +
          otherEntries.map(e => '<div class="sn-pair-col"><div class="sn-pair-label">' + getEqLabel(e) + ' ' + getHand(e) + '</div><div class="sn-pair-value" style="font-family:monospace;">' + snDisplay(e.snCode) + snStatusBadge(e.snCode) + '</div></div>').join('') +
        '</div>' +
      '</div>';
    }

    html += '</div>';
    return html;
  },

  _showSNAttachment(snCode) {
    const reg = Storage.getSNByCode(snCode);
    if (!reg || !reg.attachment) return;
    const ext = reg.attachment.split('.').pop().toLowerCase();
    const isImage = ['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext);
    const contentHtml = isImage
      ? `<div style="text-align:center;"><img src="${reg.attachment}" style="max-width:100%;max-height:70vh;border-radius:8px;" alt="${snCode} 附件"></div>`
      : `<div style="text-align:center;"><a href="${reg.attachment}" target="_blank" class="btn btn-primary">📥 打开附件</a></div>`;
    this._showInfoModal(`📎 ${snCode} 附件`, contentHtml);
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

  // ==================== USERS NAV ====================
  _updateUsersNav() {
    // Show user management nav for admin/superadmin
    const user = API.currentUser;
    const navEl = document.getElementById('users-nav') || document.getElementById('nav-users');
    if (navEl) {
      navEl.style.display = (user && (user.role === 'admin' || user.role === 'superadmin')) ? '' : 'none';
    }
  },

  // ==================== TECH SUPPORT ====================
  _updateTechSupportNav() {
    const user = API.currentUser;
    console.log('[_updateTechSupportNav] user:', user ? user.username : 'null', 'role:', user ? user.role : 'null');
    const navBtn = document.getElementById('nav-tech-support');
    if (navBtn) {
      navBtn.style.display = (user && (user.system === 'maintenance' || user.role === 'superadmin')) ? '' : 'none';
    }
    // Show popup-messages nav only for admin/superadmin
    const pmNav = document.getElementById('nav-popup-messages');
    console.log('[_updateTechSupportNav] pmNav found:', !!pmNav);
    if (pmNav) {
      const show = (user && (user.role === 'admin' || user.role === 'superadmin'));
      console.log('[_updateTechSupportNav] show popup:', show, 'role:', user?.role);
      pmNav.style.display = show ? '' : 'none';
    }
  },

  async renderTechSupport(viewMode) {
    if (!viewMode) viewMode = this._tsViewMode || 'card';
    this._tsViewMode = viewMode;
    this._tsDetailId = null;
    let items = [];
    try { items = await API.getTechSupportList(); } catch {}
    this._tsItems = items;

    const SM = { pending:{l:'待响应',c:'ts-status-pending',icon:'🕐'}, responded:{l:'处理中',c:'ts-status-responded',icon:'🔧'}, completed:{l:'已完成',c:'ts-status-completed',icon:'✅'}, closed:{l:'已关闭',c:'ts-status-closed',icon:'📁'} };
    const fm = t => t ? new Date(t).toLocaleString('zh-CN') : '-';

    const counts = { all: items.length, pending: 0, responded: 0, completed: 0 };
    items.forEach(i => { if (counts[i.status] !== undefined) counts[i.status]++; });

    // Stats row
    const statsHtml = `<div class="ts-stats-row">
      <div class="ts-stat-card total"><div class="ts-stat-icon">📋</div><div class="ts-stat-content"><div class="ts-stat-value">${counts.all}</div><div class="ts-stat-label">总记录</div></div></div>
      <div class="ts-stat-card pending"><div class="ts-stat-icon">🕐</div><div class="ts-stat-content"><div class="ts-stat-value">${counts.pending}</div><div class="ts-stat-label">待响应</div></div></div>
      <div class="ts-stat-card responded"><div class="ts-stat-icon">🔧</div><div class="ts-stat-content"><div class="ts-stat-value">${counts.responded}</div><div class="ts-stat-label">处理中</div></div></div>
      <div class="ts-stat-card completed"><div class="ts-stat-icon">✅</div><div class="ts-stat-content"><div class="ts-stat-value">${counts.completed}</div><div class="ts-stat-label">已完成</div></div></div>
    </div>`;

    const toolbar = `<div class="ts-toolbar">
      <div class="ts-filter-bar">
        ${['all','pending','responded','completed'].map(s => `<button class="ts-filter-btn ${s==='all'?'active':''}" onclick="App.filterTechSupport('${s}')" id="ts-filter-${s}">${s==='all'?'全部':s==='pending'?'待响应':s==='responded'?'处理中':'已完成'} (${counts[s]})</button>`).join('')}
      </div>
      <div style="display:flex;gap:6px;">
        <button class="btn btn-sm ${viewMode==='card'?'btn-primary':'btn-outline'}" onclick="App.renderTechSupport('card')">🃏 卡片</button>
        <button class="btn btn-sm ${viewMode==='table'?'btn-primary':'btn-outline'}" onclick="App.renderTechSupport('table')">📋 表格</button>
        <button class="btn btn-sm btn-success" onclick="App.exportTechSupportXLSX()">📥 导出</button>
      </div>
    </div>`;

    const emptyHtml = `<div class="ts-empty"><div class="ts-empty-icon">🔧</div><div class="ts-empty-text">暂无维修记录</div><div class="ts-empty-sub">运营系统提交的技术支持请求将显示在此处</div></div>`;

    let body;
    if (viewMode === 'table') {
      const cols = [
        {k:'machineNumber',l:'设备编号'},{k:'equipmentTypeName',l:'故障设备'},{k:'faultType',l:'故障现象'},
        {k:'submitterName',l:'操作员'},{k:'submittedAt',l:'提交时间'},{k:'status',l:'状态'},
        {k:'responderName',l:'维修人员'},{k:'respondedAt',l:'响应时间'},{k:'completedAt',l:'恢复时间'},
        {k:'totalSeconds',l:'总时长'}
      ];
      const sc = this._tsSortCol || 'submittedAt';
      const sd = this._tsSortDir || 'desc';
      const sorted = [...items].sort((a,b) => { const va=a[sc]||'',vb=b[sc]||''; return sd==='asc'?String(va).localeCompare(String(vb)):String(vb).localeCompare(String(va)); });
      body = `<div class="ts-table-wrap"><table class="ts-log-table"><thead><tr>
        ${cols.map(c => `<th onclick="App._sortTechSupport('${c.k}')">${c.l}<span class="sort-arrow">${sc===c.k?(sd==='asc'?' ▲':' ▼'):''}</span></th>`).join('')}
      </tr></thead><tbody>
        ${sorted.length===0?`<tr><td colspan="10">${emptyHtml}</td></tr>`:''}
        ${sorted.map(item => { const s=SM[item.status]||SM.pending;
          return `<tr data-ts-status="${item.status}" class="ts-row-clickable" onclick="App.renderTechSupportDetail('${item.id}')">
            <td><strong>${item.machineNumber||'-'}</strong></td><td>${item.equipmentTypeName||item.equipmentType||'-'}</td>
            <td>${item.faultType||'-'}</td><td>${item.submitterName||'-'}</td>
            <td style="font-size:0.8rem;white-space:nowrap;">${fm(item.submittedAt)}</td>
            <td><span class="ts-status-badge ${s.c}">${s.icon} ${s.l}</span></td>
            <td>${item.responderName||'-'}</td><td style="font-size:0.8rem;white-space:nowrap;">${fm(item.respondedAt)}</td>
            <td style="font-size:0.8rem;white-space:nowrap;">${fm(item.completedAt)}</td>
            <td>${this._fmtDuration(item.totalSeconds)}</td>
          </tr>`; }).join('')}
      </tbody></table></div>`;
    } else {
      body = `<div class="ts-list" id="ts-list-container">
        ${items.length===0?emptyHtml:''}
        ${items.map(item => { const s=SM[item.status]||SM.pending;
          return `<div class="ts-card ${item.status}" data-ts-status="${item.status}" onclick="App.renderTechSupportDetail('${item.id}')">
            <div class="ts-card-icon">${s.icon}</div>
            <div class="ts-card-title">${item.machineNumber||item.machineId}</div>
            <div class="ts-card-sub">${item.equipmentTypeName||item.equipmentType}  ·  ${item.faultType||'-'}</div>
            <div class="ts-card-footer">
              <span>👤 ${item.submitterName||'-'}</span><span>🕐 ${fm(item.submittedAt)}</span>
              ${item.responderName?`<span>🔧 ${item.responderName}</span>`:''}
              ${item.totalSeconds!=null?`<span>⏱ ${this._fmtDuration(item.totalSeconds)}</span>`:''}
              <span style="margin-left:auto;"><span class="ts-status-badge ${s.c}">${s.l}</span></span>
            </div>
          </div>`; }).join('')}
      </div>`;
    }

    document.getElementById('main-content').innerHTML = `<div class="page-header"><h2>🛠 维修日志</h2><span style="color:var(--text-secondary);font-size:0.85rem;">设备故障与维修记录</span></div>${statsHtml}${toolbar}${body}`;
  },

  _sortTechSupport(col) {
    if (this._tsSortCol === col) {
      this._tsSortDir = this._tsSortDir === 'asc' ? 'desc' : 'asc';
    } else {
      this._tsSortCol = col;
      this._tsSortDir = 'asc';
    }
    this.renderTechSupport('table');
  },

  exportTechSupportXLSX() {
    // Show date range picker dialog
    const today = new Date().toISOString().slice(0, 10);
    const html = `
      <div style="padding:16px;">
        <div class="form-group"><label>📅 日期（留空=全部）</label><input type="date" id="ts-export-date" style="width:100%;padding:8px;"></div>
        <div style="display:flex;gap:8px;margin-top:12px;">
          <div class="form-group" style="flex:1;"><label>🕖 开始时间</label><input type="time" id="ts-export-start" value="07:00" style="width:100%;padding:8px;"></div>
          <div class="form-group" style="flex:1;"><label>🕐 结束时间</label><input type="time" id="ts-export-end" value="02:00" style="width:100%;padding:8px;"></div>
        </div>
        <div style="margin-top:4px;font-size:0.75rem;color:var(--color-text-secondary);">
          💡 结束时间早于开始时间=跨天（如7:00~次日2:00）<br>
          💡 只填日期=导出当天全部记录<br>
          💡 只填时间=仅按时间段筛选<br>
          💡 全留空=导出全部
        </div>
        <div style="display:flex;gap:8px;margin-top:16px;">
          <button class="btn btn-primary" onclick="App._doExportTS()" style="flex:1;">📥 导出</button>
          <button class="btn btn-outline" onclick="App.closeModal()">取消</button>
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
      const label = dateVal || '全部';
      a.download = '维修日志-' + label + '.xlsx';
      a.click();
      this.notify('导出成功');
    } catch(e) { this.notify('导出失败: ' + e.message, 'error'); }
  },

  filterTechSupport(status) {
    document.querySelectorAll('.ts-filter-btn').forEach(b => b.classList.remove('active'));
    const btn = document.getElementById('ts-filter-' + status);
    if (btn) btn.classList.add('active');
    // Filter both card and table views
    document.querySelectorAll('.ts-card, .ts-row-clickable').forEach(el => {
      if (status === 'all') { el.style.display = ''; }
      else { el.style.display = el.dataset.tsStatus === status ? '' : 'none'; }
    });
  },

  async renderTechSupportDetail(id) {
    this._tsDetailId = id;
    let item;
    try { item = await API.getTechSupportDetail(id); } catch {}
    if (!item) { this.notify('无法获取请求详情', 'error'); return; }
    const SM = { pending:{l:'待响应',c:'ts-status-pending'}, responded:{l:'处理中',c:'ts-status-responded'}, completed:{l:'已完成',c:'ts-status-completed'}, closed:{l:'已关闭',c:'ts-status-closed'} };
    const s = SM[item.status] || SM.pending;
    const fm = t => t ? new Date(t).toLocaleString('zh-CN') : '-';

    // Build progress timeline
    const steps = [
      { label:'提交', icon:'📤', done: true, time: item.submittedAt },
      { label:'响应', icon:'🔧', done: item.status==='responded'||item.status==='completed'||item.status==='closed', active: item.status==='pending', time: item.respondedAt },
      { label:'完成', icon:'✅', done: item.status==='completed'||item.status==='closed', active: item.status==='responded', time: item.completedAt },
    ];
    const progressHtml = `<div class="ts-progress-track">${steps.map(st => {
      const cls = st.done ? 'done' : st.active ? 'active' : 'pending';
      return `<div class="ts-progress-step ${cls}"><div class="ts-progress-dot">${st.icon}</div><div class="ts-progress-label">${st.label}</div>${st.time?`<div class="ts-progress-time">${fm(st.time)}</div>`:''}</div>`;
    }).join('')}</div>`;

    document.getElementById('main-content').innerHTML = `<div class="ts-detail-page">
      <div class="page-header" style="margin-bottom:16px;"><h2>🔧 维修详情</h2><button class="btn btn-outline btn-sm" onclick="App.renderTechSupport()">← 返回列表</button></div>
      ${progressHtml}
      <div class="ts-detail-card"><h3>📤 请求信息</h3>
        <div class="ts-detail-grid">
          <div class="ts-detail-field"><span class="lbl">状态</span><span class="val"><span class="ts-status-badge ${s.c}">${s.l}</span></span></div>
          <div class="ts-detail-field"><span class="lbl">故障设备</span><span class="val">${item.equipmentTypeName||item.equipmentType||'-'}</span></div>
          <div class="ts-detail-field"><span class="lbl">设备编号</span><span class="val">${item.machineNumber||item.machineId||'-'}</span></div>
          <div class="ts-detail-field"><span class="lbl">故障现象</span><span class="val">${item.faultType||'-'}</span></div>
          <div class="ts-detail-field"><span class="lbl">操作员</span><span class="val">${item.submitterName||'-'}</span></div>
          <div class="ts-detail-field"><span class="lbl">提交时间</span><span class="val">${fm(item.submittedAt)}</span></div>
          <div class="ts-detail-field full"><span class="lbl">故障说明</span><span class="val">${item.faultDescription||'无'}</span></div>
        </div>
      </div>
      <div class="ts-detail-card"><h3>🔧 处理信息</h3>
        <div class="ts-detail-grid">
          <div class="ts-detail-field"><span class="lbl">维修人员</span><span class="val">${item.responderName||'待分配'}</span></div>
          <div class="ts-detail-field"><span class="lbl">响应时间</span><span class="val">${fm(item.respondedAt)}</span></div>
          <div class="ts-detail-field"><span class="lbl">完成时间</span><span class="val">${fm(item.completedAt)}</span></div>
          <div class="ts-detail-field"><span class="lbl">维修结果</span><span class="val">${item.result||'—'}</span></div>
        </div>
      </div>
      <div class="ts-detail-card"><h3>⏱ 耗时统计</h3>
        <div class="ts-detail-grid">
          <div class="ts-detail-field"><span class="lbl">等待时长</span><span class="val">${this._fmtDuration(item.waitSeconds)}</span></div>
          <div class="ts-detail-field"><span class="lbl">维修时长</span><span class="val">${this._fmtDuration(item.repairSeconds)}</span></div>
          <div class="ts-detail-field"><span class="lbl">总耗时</span><span class="val">${this._fmtDuration(item.totalSeconds)}</span></div>
        </div>
      </div>
      <div class="ts-action-bar">
        ${item.status==='pending'?`<button class="btn btn-primary" onclick="App.doRespondTechSupport('${item.id}')">响应请求</button>`:''}
        ${item.status==='responded'?`<button class="btn btn-success" onclick="App.doCompleteTechSupport('${item.id}')">维修完成</button>`:''}
        <button class="btn btn-outline" onclick="App.renderTechSupport()">返回列表</button>
        ${(API.currentUser.system==='maintenance'&&(API.currentUser.role==='admin'||API.currentUser.role==='superadmin'))?`<button class="btn btn-danger" onclick="App.doDeleteTechSupport('${item.id}')" style="margin-left:auto;">删除记录</button>`:''}
      </div>
    </div>`;
  },

  async doRespondTechSupport(id) {
    if (!confirm('确认响应该技术支持请求？')) return;
    const result = await API.respondTechSupport(id);
    if (result && result.success) {
      this.notify('已响应，请进行维修处理');
      this.renderTechSupportDetail(id);
    } else {
      this.notify(result?.error || result?.message || '响应失败', 'error');
    }
  },

  async doCompleteTechSupport(id) {
    const popup = await API.getRandomPopupMessage('complete');
    const funnyMsg = popup.text || '辛苦了！';
    let suggestions = [];
    try {
      const memList = await API.getMemoryList('repair_result');
      if (Array.isArray(memList)) {
        suggestions = memList.map(m => m.text).slice(0, 20);
      }
    } catch {}
    if (suggestions.length === 0) {
      this._loadRepairResultHistory();
      suggestions = this._getRepairResultHistory();
    }
    this._showLayeredPopup('🔧 维修完成', funnyMsg, '请输入或选择维修结果...', async (resultText) => {
      if (!resultText) {
        this.notify('请输入维修结果', 'error');
        return;
      }
      const result = await API.completeTechSupport(id, resultText);
      if (result && result.success) {
        this._addRepairResultToHistory(resultText);
        API.addMemory('repair_result', resultText).catch(() => {});
        this.notify('维修已完成');
        this.renderTechSupportDetail(id);
      } else {
        this.notify(result?.error || result?.message || '操作失败', 'error');
      }
    }, suggestions);
  },

  async doDeleteTechSupport(id) {
    if (!confirm('⚠ 确定要删除这条维修记录吗？此操作不可恢复！')) return;
    const result = await API.deleteTechSupport(id);
    if (result && result.success) {
      this.notify('维修记录已删除');
      this.renderTechSupport();
    } else {
      this.notify(result?.error || '删除失败', 'error');
    }
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

  // ==================== 维修结果记忆功能 ====================
  _REPAIR_RESULT_KEY: 'gms_repair_result_history',
  _MAX_HISTORY: 50,  // 最多保存50条历史记录

  // 从localStorage加载历史记录
  _loadRepairResultHistory() {
    try {
      const data = localStorage.getItem(this._REPAIR_RESULT_KEY);
      this._repairResultHistory = data ? JSON.parse(data) : [];
    } catch { this._repairResultHistory = []; }
  },

  // 保存历史记录到localStorage
  _saveRepairResultHistory() {
    try {
      localStorage.setItem(this._REPAIR_RESULT_KEY, JSON.stringify(this._repairResultHistory));
    } catch {}
  },

  // 添加新的维修结果到历史（去重，新结果优先）
  _addRepairResultToHistory(result) {
    if (!result || result.trim().length < 2) return;
    const trimmed = result.trim();
    // 移除已存在的相同记录
    this._repairResultHistory = this._repairResultHistory.filter(r => r !== trimmed);
    // 添加到最前面
    this._repairResultHistory.unshift(trimmed);
    // 限制最大数量
    if (this._repairResultHistory.length > this._MAX_HISTORY) {
      this._repairResultHistory = this._repairResultHistory.slice(0, this._MAX_HISTORY);
    }
    this._saveRepairResultHistory();
  },

  // 获取历史记录（最多返回20条）
  _getRepairResultHistory() {
    return this._repairResultHistory.slice(0, 20);
  },

  // 清除历史记录
  _clearRepairResultHistory() {
    this._repairResultHistory = [];
    this._saveRepairResultHistory();
  },

  // Layered popup: top=funny sentence, bottom=textarea + memory tags
  _showLayeredPopup(title, message, inputPlaceholder, onSubmit, suggestions) {
    const overlay = document.getElementById('modal-overlay');
    const body = document.getElementById('modal-body');
    const titleEl = document.getElementById('modal-title');
    const saveBtn = document.getElementById('modal-save');
    const closeBtn = document.getElementById('modal-close-btn');
    const self = this;
    titleEl.textContent = title;

    const hasSuggestions = suggestions && suggestions.length > 0;
    const tagHtml = hasSuggestions ? `
      <div style="margin-top:8px;">
        <div style="font-size:0.75rem;color:var(--text-secondary);margin-bottom:6px;">💡 历史记录（全运维用户共享，点击快速填入）：</div>
        <div style="display:flex;flex-wrap:wrap;gap:6px;max-height:100px;overflow-y:auto;">
          ${suggestions.slice(0, 12).map(s => `<span class="ts-memory-tag" data-text="${s.replace(/"/g, '&quot;')}">${s.length > 25 ? s.slice(0,25)+'...' : s}</span>`).join('')}
        </div>
      </div>` : '';

    body.innerHTML = `
      <div style="display:flex;flex-direction:column;gap:16px;">
        <div style="text-align:center;padding:16px 10px;background:var(--bg-secondary,#f8f9fb);border-radius:var(--radius-lg,14px);border:1px solid var(--border-light,#f3f4f6);">
          <div style="font-size:2.5rem;margin-bottom:10px;">🎊</div>
          <p style="font-size:1rem;line-height:1.6;color:var(--text-primary);font-weight:500;margin:0;">${message}</p>
        </div>
        <div>
          <label style="display:block;font-size:.78rem;font-weight:600;color:var(--text-secondary);margin-bottom:6px;">维修结果说明</label>
          <textarea id="layered-popup-input" class="ts-form-textarea" rows="4" placeholder="${inputPlaceholder || '请输入维修结果...'}" style="width:100%;"></textarea>
          ${tagHtml}
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
    // 记忆标签点击事件
    if (hasSuggestions) {
      body.querySelectorAll('.ts-memory-tag').forEach(tag => {
        tag.addEventListener('click', () => {
          const text = tag.getAttribute('data-text');
          const input = document.getElementById('layered-popup-input');
          if (input && text) input.value = text;
        });
      });
    }
    const inputEl = document.getElementById('layered-popup-input');
    if (inputEl) setTimeout(() => inputEl.focus(), 50);
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
      <button class="btn btn-xs btn-danger" onclick="App.doDeletePopupMessage('${m.id}','${cat}')">✕</button>
    </div>`).join('');

    document.getElementById('main-content').innerHTML = `<div class="page-header"><h2>💬 弹窗句子管理</h2><span style="color:var(--text-secondary);font-size:0.85rem;">管理提交成功和维修完成后的鼓励性消息</span></div>
    <div class="ts-detail-card"><h3>📩 提交后弹窗句子 (${submitMsgs.length}条)</h3>
      <div class="pm-add-row">
        <input type="text" id="pm-new-submit" class="ts-form-input" placeholder="输入新的提交后鼓励语..." style="flex:1;">
        <button class="btn btn-primary btn-sm" onclick="App.doAddPopupMessage('submit')">添加</button>
      </div>
      <div class="pm-list">${renderList(submitMsgs, 'submit') || '<p class="empty-text">暂无句子</p>'}</div>
    </div>
    <div class="ts-detail-card"><h3>✅ 维修完成弹窗句子 (${completeMsgs.length}条)</h3>
      <div class="pm-add-row">
        <input type="text" id="pm-new-complete" class="ts-form-input" placeholder="输入新的维修完成鼓励语..." style="flex:1;">
        <button class="btn btn-primary btn-sm" onclick="App.doAddPopupMessage('complete')">添加</button>
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

  // ==================== 手套调出弹窗 (点击仪表盘卡片) ====================
  async _showTransferModal() {
    let snRegistry = [];
    try { snRegistry = await API.getSNRegistry() || []; } catch {}
    const transferred = snRegistry.filter(s => s.status === 'transferred');
    const hc = s => s ? String(s).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;') : '';

    const snRows = transferred.length === 0
      ? '<p class="empty-text">✅ 当前无调出手套</p>'
      : `<table class="um-table"><thead><tr><th><input type="checkbox" id="tf-check-all" onchange="App._toggleAllTransferChecks(this)"></th><th>SN码</th><th>设备类型</th><th>左右手</th><th>调出时间</th></tr></thead><tbody>`
      + transferred.map(s => `
          <tr>
            <td><input type="checkbox" class="tf-sn-check" value="${hc(s.snCode)}"></td>
            <td><strong>${hc(s.snCode)}</strong></td>
            <td>${hc(s.equipmentType) || '-'}</td>
            <td>${s.handType === 'left' ? '左手' : s.handType === 'right' ? '右手' : '-'}</td>
            <td style="font-size:0.8rem;">${s.updatedAt ? new Date(s.updatedAt).toLocaleString('zh-CN') : '-'}</td>
          </tr>`).join('')
      + '</tbody></table>';

    const html = `
      <div style="padding:4px 0;">
        <div style="display:flex;gap:10px;margin-bottom:14px;flex-wrap:wrap;">
          <div style="flex:1;min-width:90px;background:var(--bg-secondary);border-radius:10px;padding:12px;text-align:center;">
            <div style="font-size:1.6rem;font-weight:700;color:var(--color-warning);">${transferred.length}</div>
            <div style="font-size:0.7rem;color:var(--text-secondary);">当前调出</div>
          </div>
        </div>
        <h4 style="margin:0 0 8px;">📍 调出手套列表</h4>
        ${snRows}
        <div style="margin-top:12px;display:flex;gap:8px;justify-content:flex-end;">
          <button class="btn btn-success btn-sm" id="tf-recall-btn" onclick="App._recallSelectedTransfers()" ${transferred.length === 0 ? 'disabled' : ''}>📥 调回选中</button>
        </div>
      </div>`;

    this.showModal('📤 调出手套 — ' + transferred.length + ' 个在外', html, () => {
      // onSave — 留空，调回用独立按钮
    });
    // 隐藏 modal 的确认按钮，用我们自己的按钮
    const saveBtn = document.getElementById('modal-save');
    if (saveBtn) saveBtn.style.display = 'none';
  },

  _toggleAllTransferChecks(el) {
    document.querySelectorAll('.tf-sn-check').forEach(cb => { cb.checked = el.checked; });
  },

  async _recallSelectedTransfers() {
    var checks = document.querySelectorAll('.tf-sn-check:checked');
    var snCodes = Array.from(checks).map(function(cb) { return cb.value; });
    if (snCodes.length === 0) { this.notify('请勾选要调回的SN码', 'warning'); return; }
    if (!confirm('确认调回 ' + snCodes.length + ' 个手套？')) return;

    var self = this;
    var user = self._currentUser();
    var ok = 0;
    for (var i = 0; i < snCodes.length; i++) {
      var sn = snCodes[i];
      var reg = Storage.getSNByCode(sn);
      if (!reg) continue;
      var invType = reg.equipmentType;
      if (invType === 'glove') invType = reg.handType === 'left' ? 'left_glove' : 'right_glove';
      else if (invType === 'dexterous_hand') invType = reg.handType === 'left' ? 'left_dexterous_hand' : 'right_dexterous_hand';
      else if (!invType) invType = 'left_glove';
      // 恢复 SN 状态 + 加库存（同 _markAsDamaged 逻辑）
      self._registerSN(sn, reg.equipmentType, reg.handType, 'available', '', '');
      Storage.adjustInventory(invType, 1, user, sn);
      Storage.addTransaction({
        equipmentType: reg.equipmentType, handType: reg.handType,
        direction: 'in', quantity: 1, snCode: sn,
        updatedBy: user, note: '调回公司'
      });
      ok++;
    }
    self.notify('✅ 已调回 ' + ok + ' 个手套');
    await Storage._syncFromServer();
    self.closeModal();
    self.renderDashboard();
  },

  async doDeletePopupMessage(id) {
    if (!confirm('确认删除此句子？')) return;
    const result = await API.deletePopupMessage(id);
    if (result && result.success) {
      this.notify('句子已删除');
      this.renderPopupMessages();
    } else {
      this.notify(result?.error || result?.message || '删除失败', 'error');
    }
  },

  // ==================== TRANSACTIONS ====================
  renderTransactions(page = 1) {
    this.currentPage.transactions = page;
    let transactions = Storage.getTransactions();

    // Apply filters
    if (this.filters.equipmentType !== 'all') {
      transactions = transactions.filter(t => t.equipmentType === this.filters.equipmentType);
    }
    if (this.filters.direction !== 'all') {
      transactions = transactions.filter(t => t.direction === this.filters.direction);
    }
    if (this.filters.dateFrom) {
      transactions = transactions.filter(t => new Date(t.timestamp) >= new Date(this.filters.dateFrom));
    }
    if (this.filters.dateTo) {
      const toDate = new Date(this.filters.dateTo);
      toDate.setHours(23, 59, 59, 999);
      transactions = transactions.filter(t => new Date(t.timestamp) <= toDate);
    }
    if (this.filters.search) {
      const s = this.filters.search.toLowerCase();
      transactions = transactions.filter(t => {
        if (t.snCode && t.snCode.toLowerCase().includes(s)) return true;
        if (t.updatedBy && t.updatedBy.toLowerCase().includes(s)) return true;
        if (t.machineNumber && t.machineNumber.toLowerCase().includes(s)) return true;
        if (t.note && t.note.toLowerCase().includes(s)) return true;
        // Also search in labels
        const eqLabel = this._equipmentLabel(t.equipmentType, t.handType);
        if (eqLabel.includes(s)) return true;
        const dirLabel = t.direction === 'in' ? '入库' : '出库';
        if (dirLabel.includes(s)) return true;
        if (t.handType === 'left' && '左手'.includes(s)) return true;
        if (t.handType === 'right' && '右手'.includes(s)) return true;
        return false;
      });
    }

    // Always sort by timestamp descending by default; user can override by clicking column headers
    const sortCol = this.filters.sortColumn || 'timestamp';
    const sortDir = this.filters.sortColumn ? (this.filters.sortDirection === 'desc' ? -1 : 1) : -1;
    transactions.sort((a, b) => {
      let va = a[sortCol] || '', vb = b[sortCol] || '';
      if (sortCol === 'timestamp') { va = new Date(va).getTime(); vb = new Date(vb).getTime(); }
      if (sortCol === 'quantity') { va = parseInt(va) || 0; vb = parseInt(vb) || 0; }
      if (typeof va === 'string') { va = va.toLowerCase(); vb = vb.toLowerCase(); }
      if (va < vb) return -1 * sortDir;
      if (va > vb) return 1 * sortDir;
      return 0;
    });

    const sortArrow = (col) => {
      if (this.filters.sortColumn !== col) return '';
      return this.filters.sortDirection === 'asc' ? ' ▲' : ' ▼';
    };
    const sortableHeader = (col, label) =>
      `<th class="sortable" onclick="App.sortBy('${col}')">${label}${sortArrow(col)}</th>`;

    const totalPages = Math.ceil(transactions.length / this.pageSize) || 1;
    const start = (page - 1) * this.pageSize;
    const paged = transactions.slice(start, start + this.pageSize);

    const empty = transactions.length === 0;
    const activeFilterCount = (this.filters.equipmentType !== 'all' ? 1 : 0) +
      (this.filters.direction !== 'all' ? 1 : 0) +
      (this.filters.dateFrom ? 1 : 0) + (this.filters.dateTo ? 1 : 0) +
      (this.filters.search ? 1 : 0);
    // Pending undo actions
    const undoItems = Storage._undoStack.map((e, i) => ({...e, _idx: i})).filter(e => e.expiresAt > Date.now());
    let undoHtml = '';
    if (undoItems.length > 0) {
      undoHtml = `
        <div class="undo-bar">
          <span class="undo-bar-title">⏪ 可撤销操作 (${undoItems.length}个)</span>
          ${undoItems.map((entry) => {
            const label = entry.action === 'adjustInventory' ? `${Storage._typeLabel(entry.data.type)} 库存变更 (${entry.data.previousQuantity}→${Storage.getInventory(entry.data.type).quantity})` : entry.action;
            const remaining = Math.max(0, Math.floor((entry.expiresAt - Date.now()) / 1000));
            return `<button class="btn btn-sm btn-warning" onclick="App.undoFromTransactions(${entry._idx})" title="剩余 ${remaining} 秒">↩ ${label}</button>`;
          }).join(' ')}
        </div>`;
    }

    const html = `
      <div class="page-header">
        <h2>📋 全部流水记录</h2>
        <div class="header-actions">
          <button class="btn btn-outline" onclick="App.exportCSV()">📥 导出CSV</button>
          <button class="btn btn-outline" onclick="App.exportXLSX()">📥 导出Excel</button>
          <button class="btn btn-outline" onclick="App.printTransactions()">🖨️ 打印</button>
        </div>
      </div>

      ${undoHtml}

      <!-- Stats cards -->
      <div class="ts-stats-row">
        <div class="ts-stat-card total"><div class="ts-stat-icon">📝</div><div class="ts-stat-content"><div class="ts-stat-value">${transactions.length}</div><div class="ts-stat-label">总记录数</div></div></div>
        <div class="ts-stat-card"><div class="ts-stat-icon">📥</div><div class="ts-stat-content"><div class="ts-stat-value">${transactions.filter(t => t.direction === 'in').length}</div><div class="ts-stat-label">入库</div></div></div>
        <div class="ts-stat-card"><div class="ts-stat-icon">📤</div><div class="ts-stat-content"><div class="ts-stat-value">${transactions.filter(t => t.direction === 'out').length}</div><div class="ts-stat-label">出库</div></div></div>
      </div>

      <!-- Toolbar -->
      <div class="ts-toolbar">
        <div class="ts-filter-bar">
          <button class="ts-filter-btn ${this.filters.equipmentType === 'all' ? 'active' : ''}" onclick="App.applyFilter('equipmentType','all')">全部设备</button>
          <button class="ts-filter-btn ${this.filters.equipmentType === 'glove' ? 'active' : ''}" onclick="App.applyFilter('equipmentType','glove')">手套</button>
          <button class="ts-filter-btn ${this.filters.equipmentType === 'dexterous_hand' ? 'active' : ''}" onclick="App.applyFilter('equipmentType','dexterous_hand')">灵巧手</button>
          <button class="ts-filter-btn ${this.filters.equipmentType === 'gripper' ? 'active' : ''}" onclick="App.applyFilter('equipmentType','gripper')">夹爪</button>
        </div>
        <div style="display:flex;gap:6px;">
          <select id="filter-direction" onchange="App.applyFilter('direction', this.value)" style="padding:6px 10px;border:1px solid var(--border-color);border-radius:8px;background:var(--bg-card);">
            <option value="all" ${this.filters.direction === 'all' ? 'selected' : ''}>全部操作</option>
            <option value="in" ${this.filters.direction === 'in' ? 'selected' : ''}>入库</option>
            <option value="out" ${this.filters.direction === 'out' ? 'selected' : ''}>出库</option>
          </select>
          <input type="text" id="filter-search" onkeydown="if(event.key==='Enter')App.applyFilter('search',this.value)" placeholder="🔍 搜索..." style="padding:6px 10px;border:1px solid var(--border-color);border-radius:8px;background:var(--bg-card);min-width:120px;">
          <button class="btn btn-sm btn-outline" onclick="App.clearFilters()">清除</button>
          <button class="btn btn-sm btn-outline" onclick="App.toggleTxViewMode()">
            ${this._txViewMode === 'card' ? '📋 表格' : '🃏 卡片'}
          </button>
        </div>
      </div>

      <!-- Date filter bar -->
      <div class="ts-toolbar" style="margin-top:8px;">
        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          <input type="date" id="filter-date-from" onchange="App.applyFilter('dateFrom', this.value)" placeholder="开始" style="padding:6px 10px;border:1px solid var(--border-color);border-radius:8px;background:var(--bg-card);">
          <span style="display:flex;align-items:center;color:var(--text-secondary);">-</span>
          <input type="date" id="filter-date-to" onchange="App.applyFilter('dateTo', this.value)" placeholder="结束" style="padding:6px 10px;border:1px solid var(--border-color);border-radius:8px;background:var(--bg-card);">
          <button class="btn btn-sm" onclick="App.setQuickTxRange('today')">今天</button>
          <button class="btn btn-sm" onclick="App.setQuickTxRange('week')">本周</button>
          <button class="btn btn-sm" onclick="App.setQuickTxRange('month')">本月</button>
        </div>
      </div>

      <!-- Content area -->
      ${empty ? '<div class="ts-empty" style="margin-top:24px;"><div class="ts-empty-icon">📝</div><div class="ts-empty-text">暂无流水记录</div><div class="ts-empty-sub">进行库存操作后会在这里记录</div></div>' : `
        ${this._txViewMode === 'card' ? `
          <!-- Card view -->
          <div class="ts-list">
            ${paged.map(t => {
              const label = this._equipmentLabel(t.equipmentType, t.handType);
              const handLabel = t.handType === 'left' ? '左手' : t.handType === 'right' ? '右手' : '';
              const isIn = t.direction === 'in';
              return `<div class="ts-card">
                <div class="ts-card-icon" style="background:${isIn ? 'var(--color-success)' : 'var(--color-danger)'};color:white;">${isIn ? '📥' : '📤'}</div>
                <div class="ts-card-title">${label}${handLabel ? ' (' + handLabel + ')' : ''}</div>
                <div class="ts-card-sub">${t.snCode || '无SN码'} · ${t.machineNumber || '无机器编号'}</div>
                <div style="font-size:0.85rem;color:var(--text-secondary);margin-top:4px;">数量：<span style="font-weight:600;color:${isIn ? 'var(--color-success)' : 'var(--color-danger)'}">${isIn ? '+' : '-'}${t.quantity}</span></div>
                ${t.note ? `<div style="font-size:0.8rem;color:var(--text-tertiary);margin-top:2px;">备注：${t.note}</div>` : ''}
                <div class="ts-card-footer">
                  <span>${this._formatTime(t.timestamp)}</span>
                  <span style="margin-left:auto;">
                    ${t.updatedBy || '-'}
                    ${t.attachment ? ' <a href="'+t.attachment+'" target="_blank" title="查看附件">📎</a>' : ''}
                    ${this._isPrivileged() ? `<button class="btn btn-xs btn-danger" onclick="App.deleteTransaction('${t.id}')" style="margin-left:8px;">删除</button>` : ''}
                  </span>
                </div>
              </div>`;
            }).join('')}
          </div>
        ` : `
          <!-- Table view -->
          <div class="desktop-only">
            <div class="table-container">
              <table class="ts-log-table">
                <thead><tr>${sortableHeader('timestamp','时间')}${sortableHeader('equipmentType','设备类型')}${sortableHeader('handType','左右手')}${sortableHeader('direction','操作')}${sortableHeader('quantity','数量')}<th>SN码</th><th>机器编号</th>${sortableHeader('updatedBy','更新人')}<th>备注</th><th>操作</th></tr></thead>
                <tbody>${
                  paged.map(t => `
                    <tr class="clickable" onclick="App.toggleTxDetail('${t.id}')" title="点击查看详情">
                      <td title="${this._formatTime(t.timestamp)}">${this._formatTime(t.timestamp)}</td>
                      <td>${this._equipmentLabel(t.equipmentType, t.handType)}</td>
                      <td>${t.handType === 'left' ? '左手' : t.handType === 'right' ? '右手' : '-'}</td>
                      <td><span class="ts-status-badge ${t.direction === 'in' ? 'ts-status-completed' : 'ts-status-pending'}">${t.direction === 'in' ? '入库' : '出库'}</span></td>
                      <td>${t.direction === 'in' ? '+' : '-'}${t.quantity}</td>
                      <td>${t.snCode || '-'} ${t.attachment ? '<a href="'+t.attachment+'" target="_blank" title="查看附件">📎</a>' : ''}</td>
                      <td>${t.machineNumber || '-'}</td>
                      <td>${t.updatedBy || '-'}</td>
                      <td>${t.note || '-'}</td>
                      <td>${this._isPrivileged() ? `<button class="btn btn-xs btn-danger" onclick="event.stopPropagation();App.deleteTransaction('${t.id}')">删除</button>` : ''}</td>
                    </tr>
                    <tr class="tx-detail" id="tx-detail-${t.id}" style="display:none;">
                      <td colspan="10">
                        <div class="tx-detail-content">
                          <div class="tx-detail-row"><span>时间:</span><strong>${this._formatTime(t.timestamp)}</strong></div>
                          <div class="tx-detail-row"><span>设备:</span><strong>${this._equipmentLabel(t.equipmentType, t.handType)}</strong></div>
                          <div class="tx-detail-row"><span>操作:</span><span class="ts-status-badge ${t.direction === 'in' ? 'ts-status-completed' : 'ts-status-pending'}">${t.direction === 'in' ? '入库' : '出库'}</span></div>
                          <div class="tx-detail-row"><span>数量:</span><strong>${t.quantity}</strong></div>
                          <div class="tx-detail-row"><span>SN码:</span><strong>${t.snCode || '-'}</strong></div>
                          <div class="tx-detail-row"><span>机器编号:</span><strong>${t.machineNumber || '-'}</strong></div>
                          <div class="tx-detail-row"><span>更新人:</span><strong>${t.updatedBy || '-'}</strong></div>
                          <div class="tx-detail-row"><span>备注:</span><strong>${t.note || '-'}</strong></div>
                          <div class="tx-detail-row"><span>记录ID:</span><code style="font-size:0.7rem;">${t.id}</code></div>
                        </div>
                      </td>
                    </tr>
                  `).join('')
                }</tbody>
              </table>
            </div>
          </div>
        `}
      `}

      <!-- Pagination -->
      <div class="pagination" style="${empty ? 'display:none;' : ''}">
        <span>共 ${transactions.length} 条 · ${page}/${totalPages} 页</span>
        <span style="display:flex;align-items:center;gap:4px;">
          每页 <select onchange="App.setPageSize(parseInt(this.value))" value="${this.pageSize}">
            <option value="10" ${this.pageSize === 10 ? 'selected' : ''}>10</option>
            <option value="15" ${this.pageSize === 15 ? 'selected' : ''}>15</option>
            <option value="25" ${this.pageSize === 25 ? 'selected' : ''}>25</option>
            <option value="50" ${this.pageSize === 50 ? 'selected' : ''}>50</option>
          </select> 条
        </span>
        <div class="page-btns">
          <button class="btn btn-sm" ${page <= 1 ? 'disabled' : ''} onclick="App.renderTransactions(${page - 1})">◀</button>
          ${this._renderPageButtons(page, totalPages)}
          <button class="btn btn-sm" ${page >= totalPages ? 'disabled' : ''} onclick="App.renderTransactions(${page + 1})">▶</button>
        </div>
      </div>
    `;
    document.getElementById('main-content').innerHTML = html;
    this._restoreFilterValues();
  },

  _renderPageButtons(current, total) {
    let html = '';
    for (let i = 1; i <= total; i++) {
      if (total <= 7 || i === 1 || i === total || Math.abs(i - current) <= 1) {
        html += `<button class="btn btn-sm ${i === current ? 'btn-primary' : ''}" onclick="App.renderTransactions(${i})">${i}</button>`;
      } else if (i === 2 && current > 3) {
        html += '<span>...</span>';
      } else if (i === total - 1 && current < total - 2) {
        html += '<span>...</span>';
      }
    }
    return html;
  },

  toggleFilterBar() {
    const bar = document.getElementById('tx-filter-bar');
    if (bar) bar.classList.toggle('open');
  },

  clearFilters() {
    clearTimeout(this._searchTimer);
    this._searchTimer = null;
    this.filters = { equipmentType: 'all', direction: 'all', dateFrom: '', dateTo: '', search: '', sortColumn: '', sortDirection: 'asc' };
    this.renderTransactions(1);
  },

  applyFilter(key, value) {
    this.filters[key] = value;
    this.renderTransactions(1);
  },

  sortBy(column) {
    if (this.filters.sortColumn === column) {
      this.filters.sortDirection = this.filters.sortDirection === 'asc' ? 'desc' : 'asc';
    } else {
      this.filters.sortColumn = column;
      this.filters.sortDirection = 'asc';
    }
    this.renderTransactions(1);
  },

  setPageSize(size) {
    this.pageSize = size;
    this.renderTransactions(1);
  },

  toggleTxViewMode() {
    this._txViewMode = this._txViewMode === 'card' ? 'table' : 'card';
    this.renderTransactions(this.currentPage.transactions);
  },

  toggleTxDetail(id) {
    const detailRow = document.getElementById('tx-detail-' + id);
    if (!detailRow) return;
    if (detailRow.style.display === 'none') {
      document.querySelectorAll('.tx-detail').forEach(r => r.style.display = 'none');
      detailRow.style.display = '';
    } else {
      detailRow.style.display = 'none';
    }
  },

  toggleTxCard(card, id) {
    // Close all other expanded cards
    document.querySelectorAll('.tx-mobile-card.expanded').forEach(c => {
      if (c !== card) c.classList.remove('expanded');
    });
    card.classList.toggle('expanded');
  },

  _restoreFilterValues() {
    const el1 = document.getElementById('filter-equipment');
    const el2 = document.getElementById('filter-direction');
    const el3 = document.getElementById('filter-date-from');
    const el4 = document.getElementById('filter-date-to');
    const el5 = document.getElementById('filter-search');
    if (el1) el1.value = this.filters.equipmentType;
    if (el2) el2.value = this.filters.direction;
    if (el3) el3.value = this.filters.dateFrom;
    if (el4) el4.value = this.filters.dateTo;
    if (el5) el5.value = this.filters.search;
  },

  deleteTransaction(id) {
    if (!this._isPrivileged()) { this.notify('无删除权限，仅管理员可删除记录', 'error'); return; }
    const transactions = Storage.getTransactions();
    const tx = transactions.find(t => t.id === id);
    if (!tx) return;

    // Calculate inventory reversal
    const invType = tx.equipmentType === 'glove'
      ? (tx.handType === 'left' ? 'left_glove' : 'right_glove')
      : tx.equipmentType === 'dexterous_hand'
        ? (tx.handType === 'left' ? 'left_dexterous_hand' : 'right_dexterous_hand')
        : tx.equipmentType;
    const reverseDelta = tx.direction === 'in' ? -tx.quantity : tx.quantity;
    const label = Storage._typeLabel(invType);

    const msg = `确认删除此记录并自动${reverseDelta > 0 ? '归还' : '扣减'}库存？<br><br>${label}: ${tx.direction === 'in' ? '入库' : '出库'} ${tx.quantity}个 → 删除后${reverseDelta > 0 ? '增加' : '减少'} ${Math.abs(reverseDelta)}个`;
    this.showConfirm('删除交易记录', msg, () => {
      // Reverse inventory
      const reversalUser = tx.updatedBy || '系统';
      Storage.adjustInventory(invType, reverseDelta, reversalUser, tx.snCode);
      // Record reversal transaction
      Storage.addTransaction({
        equipmentType: tx.equipmentType, handType: tx.handType,
        direction: reverseDelta > 0 ? 'in' : 'out', quantity: Math.abs(reverseDelta),
        snCode: tx.snCode || '', machineNumber: tx.machineNumber || '',
        updatedBy: reversalUser, note: '删除流水记录自动冲正',
      });
      // Update SN registry if SN code exists
      if (tx.snCode) {
        const newStatus = reverseDelta > 0 ? 'available' : null;
        if (newStatus) this._registerSN(tx.snCode, tx.equipmentType, tx.handType, 'available', '', '');
      }

      // Delete from server if online
      if (API.online) { API.deleteTransaction(id).catch(() => {}); }

      // Track deleted tx ID to prevent SSE sync from restoring it
      try {
        const deletedIds = JSON.parse(localStorage.getItem('gms_deleted_tx_ids') || '[]');
        deletedIds.push({ id: id, expires: Date.now() + 60000 });
        // Clean expired entries
        const clean = deletedIds.filter(e => e.expires > Date.now());
        localStorage.setItem('gms_deleted_tx_ids', JSON.stringify(clean));
      } catch {}

      const updated = transactions.filter(t => t.id !== id);
      Storage.saveTransactions(updated);
      this.notify(`记录已删除，库存已自动${reverseDelta > 0 ? '归还' : '扣减'} ${Math.abs(reverseDelta)}个`);
      this.refreshCurrentTab();
    });
  },

  // ==================== REPORTS ====================
  renderReports() {
    const settings = Storage.getSettings();
    const hasDateFilter = this.filters.dateFrom || this.filters.dateTo;
    const html = `
      <div class="page-header">
        <h2>📊 报表统计</h2>
        <div class="header-actions">
          <button class="btn btn-outline" onclick="App.printReports()">🖨️ 打印</button>
          <button class="btn btn-outline" onclick="App.exportReportCSV()">📥 导出CSV</button>
        </div>
      </div>

      <!-- Filter toggle (mobile only) -->
      <div class="filter-toggle-bar">
        <button class="btn btn-outline" onclick="App.toggleReportFilterBar()">
          📅 日期筛选${hasDateFilter ? '<span class="filter-count">1</span>' : ''}
        </button>
      </div>

      <div class="filter-bar collapsible" id="report-filter-bar">
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
          <label style="display:flex;align-items:center;gap:4px;font-size:0.82rem;white-space:nowrap;">开始
            <input type="date" id="report-date-from" onchange="App.renderReports()" value="${this._dateInputValue(this.filters.dateFrom)}" style="font-size:0.8rem;">
          </label>
          <label style="display:flex;align-items:center;gap:4px;font-size:0.82rem;white-space:nowrap;">结束
            <input type="date" id="report-date-to" onchange="App.renderReports()" value="${this._dateInputValue(this.filters.dateTo)}" style="font-size:0.8rem;">
          </label>
        </div>
        <div style="display:flex;gap:4px;flex-wrap:wrap;">
          <button class="btn btn-sm" onclick="App.setQuickReportRange('today')">今天</button>
          <button class="btn btn-sm" onclick="App.setQuickReportRange('week')">本周</button>
          <button class="btn btn-sm" onclick="App.setQuickReportRange('month')">本月</button>
          <button class="btn btn-sm" onclick="App.setQuickReportRange('all')">全部</button>
        </div>
      </div>

      <div class="report-periods" id="report-periods">
        ${this._renderReportCards()}
      </div>

      <div class="dashboard-grid" style="margin-top:16px;gap:14px;">
        <div class="dash-card">
          <h3>📈 各设备出入库统计</h3>
          <div class="chart-container"><canvas id="chart-equipment-stats"></canvas></div>
        </div>
        <div class="dash-card">
          <h3>📅 每日操作趋势</h3>
          <div class="chart-container"><canvas id="chart-daily-trend"></canvas></div>
        </div>
      </div>
    `;
    document.getElementById('main-content').innerHTML = html;
    setTimeout(() => {
      this._restoreReportDateValues();
      this._drawEquipmentStatsChart();
      this._drawDailyTrendChart();
    }, 50);
  },

  _dateInputValue(d) { return d || ''; },

  _getReportFilteredTransactions() {
    // Read date values from DOM if available
    const elFrom = document.getElementById('report-date-from');
    const elTo = document.getElementById('report-date-to');
    const dateFrom = (elFrom && elFrom.value) ? elFrom.value : (this.filters.dateFrom || '');
    const dateTo = (elTo && elTo.value) ? elTo.value : (this.filters.dateTo || '');
    this.filters.dateFrom = dateFrom;
    this.filters.dateTo = dateTo;

    let transactions = Storage.getTransactions();
    if (dateFrom) {
      transactions = transactions.filter(t => new Date(t.timestamp) >= new Date(dateFrom));
    }
    if (dateTo) {
      const toDate = new Date(dateTo);
      toDate.setHours(23, 59, 59, 999);
      transactions = transactions.filter(t => new Date(t.timestamp) <= toDate);
    }
    return transactions;
  },

  _renderReportCards() {
    const transactions = this._getReportFilteredTransactions();
    const stats = this._calcStats(transactions);
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    const weekStart = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

    const todayTx = transactions.filter(t => t.timestamp >= todayStart);
    const weekTx = transactions.filter(t => t.timestamp >= weekStart);
    const monthTx = transactions.filter(t => t.timestamp >= monthStart);

    return `
      ${this._renderReportCard('今日', this._calcStats(todayTx))}
      ${this._renderReportCard('近7天', this._calcStats(weekTx))}
      ${this._renderReportCard('本月', this._calcStats(monthTx))}
      ${this._renderReportCard('总计 (筛选范围内)', stats)}
    `;
  },

  _restoreReportDateValues() {
    const elFrom = document.getElementById('report-date-from');
    const elTo = document.getElementById('report-date-to');
    if (elFrom) elFrom.value = this._dateInputValue(this.filters.dateFrom);
    if (elTo) elTo.value = this._dateInputValue(this.filters.dateTo);
  },

  setQuickTxRange(range) {
    const now = new Date();
    if (range === 'today') {
      this.filters.dateFrom = now.toISOString().slice(0, 10);
      this.filters.dateTo = now.toISOString().slice(0, 10);
    } else if (range === 'week') {
      const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      this.filters.dateFrom = weekAgo.toISOString().slice(0, 10);
      this.filters.dateTo = now.toISOString().slice(0, 10);
    } else if (range === 'month') {
      this.filters.dateFrom = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
      this.filters.dateTo = now.toISOString().slice(0, 10);
    }
    this.renderTransactions(1);
  },

  toggleReportFilterBar() {
    const bar = document.getElementById('report-filter-bar');
    if (bar) bar.classList.toggle('open');
  },

  setQuickReportRange(range) {
    const now = new Date();
    if (range === 'today') {
      this.filters.dateFrom = now.toISOString().slice(0, 10);
      this.filters.dateTo = now.toISOString().slice(0, 10);
    } else if (range === 'week') {
      const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      this.filters.dateFrom = weekAgo.toISOString().slice(0, 10);
      this.filters.dateTo = now.toISOString().slice(0, 10);
    } else if (range === 'month') {
      this.filters.dateFrom = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
      this.filters.dateTo = now.toISOString().slice(0, 10);
    } else if (range === 'all') {
      this.filters.dateFrom = '';
      this.filters.dateTo = '';
    }
    this.renderReports();
  },

  exportReportCSV() {
    const transactions = this._getReportFilteredTransactions();
    const stats = this._calcStats(transactions);
    const rows = [
      '指标,数量',
      `手套入库,${stats.gloveIn}`,
      `手套出库,${stats.gloveOut}`,
      `灵巧手入库,${stats.dexIn}`,
      `灵巧手出库,${stats.dexOut}`,
      `Pika入库,${stats.gripIn}`,
      `Pika出库,${stats.gripOut}`,
      `总操作次数,${stats.total}`,
    ];
    const csv = rows.join('\n');
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `报表统计-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    this.notify('报表CSV导出成功');
  },

  _calcStats(txs) {
    const gloveIn = txs.filter(t => t.equipmentType === 'glove' && t.direction === 'in').reduce((s, t) => s + t.quantity, 0);
    const gloveOut = txs.filter(t => t.equipmentType === 'glove' && t.direction === 'out').reduce((s, t) => s + t.quantity, 0);
    const dexIn = txs.filter(t => t.equipmentType === 'dexterous_hand' && t.direction === 'in').reduce((s, t) => s + t.quantity, 0);
    const dexOut = txs.filter(t => t.equipmentType === 'dexterous_hand' && t.direction === 'out').reduce((s, t) => s + t.quantity, 0);
    const gripIn = txs.filter(t => t.equipmentType === 'gripper' && t.direction === 'in').reduce((s, t) => s + t.quantity, 0);
    const gripOut = txs.filter(t => t.equipmentType === 'gripper' && t.direction === 'out').reduce((s, t) => s + t.quantity, 0);
    return { gloveIn, gloveOut, dexIn, dexOut, gripIn, gripOut, total: txs.length };
  },

  _renderReportCard(title, stats) {
    return `
      <div class="report-card">
        <h4>${title}</h4>
        <div class="report-stats">
          <div class="report-row"><span>🧤 手套入库:</span><strong>${stats.gloveIn}</strong></div>
          <div class="report-row"><span>🧤 手套出库:</span><strong>${stats.gloveOut}</strong></div>
          <div class="report-row"><span>🤖 灵巧手入库:</span><strong>${stats.dexIn}</strong></div>
          <div class="report-row"><span>🤖 灵巧手出库:</span><strong>${stats.dexOut}</strong></div>
          <div class="report-row"><span>🔧 Pika入库:</span><strong>${stats.gripIn}</strong></div>
          <div class="report-row"><span>🔧 Pika出库:</span><strong>${stats.gripOut}</strong></div>
          <div class="report-row"><span>📋 总操作次数:</span><strong>${stats.total}</strong></div>
        </div>
      </div>
    `;
  },

  // ==================== EQUIPMENT TYPE CONFIG ====================
  renderEquipmentConfig() {
    const configs = Storage.getEquipmentConfig();
    const html = `
      <div class="page-header">
        <h2>🔩 设备类型配置</h2>
        <div class="header-actions">
          <button class="btn btn-primary" onclick="App.showEquipmentConfigForm()">+ 添加设备类型</button>
        </div>
      </div>
      <p class="form-hint">设备类型定义了机器上/下线时自动消耗和归还哪些库存物品。修改后仅对新记录生效。</p>
      <div class="table-container">
        <table class="data-table">
          <thead><tr><th>图标</th><th>名称</th><th>消耗库存</th><th>创建时间</th><th>操作</th></tr></thead>
          <tbody>${configs.length === 0 ? '<tr><td colspan="5" class="empty-text">暂无设备类型</td></tr>' :
            configs.map(c => `
              <tr>
                <td><span style="font-size:1.5rem;">${c.icon || '📦'}</span></td>
                <td><strong>${c.name}</strong></td>
                <td>${(c.consumes || []).map(i => `${Storage._typeLabel(i.inventoryType) || i.inventoryType} x${i.quantity}`).join('、') || '-'}</td>
                <td>${this._formatTime(c.createdAt)}</td>
                <td>
                  <button class="btn btn-xs btn-outline" onclick="App.showEquipmentConfigForm('${c.id}')">编辑</button>
                  <button class="btn btn-xs btn-danger" onclick="App.deleteEquipmentConfig('${c.id}')">删除</button>
                </td>
              </tr>
            `).join('')
          }</tbody>
        </table>
      </div>
    `;
    document.getElementById('main-content').innerHTML = html;
  },

  showEquipmentConfigForm(editId) {
    const configs = Storage.getEquipmentConfig();
    const existing = editId ? configs.find(c => c.id === editId) : null;
    const inventoryConfig = Storage.getInventoryConfig();
    const invOptions = inventoryConfig.map(ic => `<option value="${ic.id}">${ic.icon || ''} ${ic.name}</option>`).join('');
    const consumes = existing ? existing.consumes : [];
    const consumesHtml = consumes.map((c, i) => `
      <div class="consume-row" style="display:flex;gap:8px;align-items:center;margin-bottom:8px;flex-wrap:wrap;">
        <select class="consume-type" style="flex:2;min-width:120px;">${invOptions.replace(new RegExp(`value="${c.inventoryType}"`), `value="${c.inventoryType}" selected`)}</select>
        <select class="consume-hand" style="width:80px;">
          <option value="" ${!c.handType ? 'selected' : ''}>不区分</option>
          <option value="left" ${c.handType === 'left' ? 'selected' : ''}>左手</option>
          <option value="right" ${c.handType === 'right' ? 'selected' : ''}>右手</option>
        </select>
        <input type="number" class="consume-qty" value="${c.quantity}" min="1" style="width:70px;" placeholder="数量">
        <button class="btn btn-xs btn-danger" onclick="this.closest('.consume-row').remove()">✕</button>
      </div>
    `).join('');

    const contentHtml = `
      <div class="form-group">
        <label>设备名称 <span class="required">*</span></label>
        <input type="text" id="eq-name" value="${existing ? existing.name : ''}" placeholder="例如：纯手套设备" required>
      </div>
      <div class="form-group">
        <label>图标 (表情符号)</label>
        <input type="text" id="eq-icon" value="${existing ? existing.icon : '🧤'}" placeholder="输入或粘贴任意表情符号，例如 🧤🤖🔧">
        <p class="form-hint">可直接输入任意表情符号（Win+. 打开系统表情面板）</p>
      </div>
      <div class="form-group">
        <label>消耗库存物品</label>
        <div id="consumes-container">${consumesHtml || '<p style="color:var(--text-tertiary);font-size:0.8rem;">暂未添加消耗物品</p>'}</div>
        <button class="btn btn-sm btn-outline" style="margin-top:8px;" onclick="App._addConsumeRow()">+ 添加库存消耗</button>
        <p class="form-hint" style="margin-top:8px;">上/下线时自动消耗/归还的库存物品及数量</p>
      </div>
    `;
    this.showModal(existing ? '编辑设备类型' : '添加设备类型', contentHtml, () => {
      const name = document.getElementById('eq-name').value.trim();
      const icon = document.getElementById('eq-icon').value.trim();
      if (!name) { this.notify('请输入设备名称', 'error'); return false; }
      const consumeRows = document.querySelectorAll('#consumes-container .consume-row');
      const newConsumes = [];
      consumeRows.forEach(row => {
        const sel = row.querySelector('.consume-type');
        const qty = row.querySelector('.consume-qty');
        if (sel && sel.value) {
          const hand = row.querySelector('.consume-hand');
          newConsumes.push({ inventoryType: sel.value, handType: hand && hand.value ? hand.value : null, quantity: parseInt(qty.value) || 1 });
        }
      });
      const cfg = { id: existing ? existing.id : 'eq-' + Date.now().toString(36), name, icon: icon || '📦', consumes: newConsumes, createdAt: existing ? existing.createdAt : new Date().toISOString() };
      let allConfigs = Storage.getEquipmentConfig();
      if (existing) {
        allConfigs = allConfigs.map(c => c.id === editId ? cfg : c);
      } else {
        allConfigs.push(cfg);
      }
      Storage.saveEquipmentConfig(allConfigs);
      this.notify(existing ? '设备类型已更新' : '设备类型已添加');
      this.renderEquipmentConfig();
      return true;
    });
    // Store invOptions for _addConsumeRow
    this._invOptionsCache = invOptions;
  },

  _addConsumeRow() {
    const container = document.getElementById('consumes-container');
    if (!container) return;
    const invOptions = this._invOptionsCache || '';
    const row = document.createElement('div');
    row.className = 'consume-row';
    row.style.cssText = 'display:flex;gap:8px;align-items:center;margin-bottom:8px;';
    row.innerHTML = `<select class="consume-type" style="flex:2;">${invOptions}</select><select class="consume-hand" style="width:80px;"><option value="">不区分</option><option value="left">左手</option><option value="right">右手</option></select><input type="number" class="consume-qty" value="1" min="1" style="width:70px;" placeholder="数量"><button class="btn btn-xs btn-danger" onclick="this.closest('.consume-row').remove()">✕</button>`;
    const emptyMsg = container.querySelector('p');
    if (emptyMsg) emptyMsg.remove();
    container.appendChild(row);
  },

  deleteEquipmentConfig(id) {
    let configs = Storage.getEquipmentConfig();
    const cfg = configs.find(c => c.id === id);
    if (!cfg) return;
    this.showConfirm('删除设备类型', `确定要删除 "${cfg.name}" 吗？已存在的机器记录不受影响。`, () => {
      configs = configs.filter(c => c.id !== id);
      Storage.saveEquipmentConfig(configs);
      this.notify(`设备类型 "${cfg.name}" 已删除`);
      this.renderEquipmentConfig();
    });
  },

  // ==================== INVENTORY TYPE CONFIG ====================
  renderInventoryConfig() {
    const configs = Storage.getInventoryConfig();
    const html = `
      <div class="page-header">
        <h2>📦 库存类型配置</h2>
        <div class="header-actions">
          <button class="btn btn-primary" onclick="App.showInventoryConfigForm()">+ 添加库存类型</button>
        </div>
      </div>
      <p class="form-hint">库存类型定义了可以追踪库存量的物品类别。添加后会在侧边栏出现对应的管理页面。</p>
      <div class="table-container">
        <table class="data-table">
          <thead><tr><th>图标</th><th>名称</th><th>左右手</th><th>创建时间</th><th>操作</th></tr></thead>
          <tbody>${configs.length === 0 ? '<tr><td colspan="5" class="empty-text">暂无库存类型</td></tr>' :
            configs.map(c => `
              <tr>
                <td><span style="font-size:1.5rem;">${c.icon || '📦'}</span></td>
                <td><strong>${c.name}</strong></td>
                <td>${c.hasLeftRight ? '✅ 区分左右' : '—'}</td>
                <td>${this._formatTime(c.createdAt)}</td>
                <td>
                  <button class="btn btn-xs btn-outline" onclick="App.showInventoryConfigForm('${c.id}')">编辑</button>
                  <button class="btn btn-xs btn-danger" onclick="App.deleteInventoryConfig('${c.id}')">删除</button>
                </td>
              </tr>
            `).join('')
          }</tbody>
        </table>
      </div>
    `;
    document.getElementById('main-content').innerHTML = html;
  },

  showInventoryConfigForm(editId) {
    const configs = Storage.getInventoryConfig();
    const existing = editId ? configs.find(c => c.id === editId) : null;
    const contentHtml = `
      <div class="form-group">
        <label>库存名称 <span class="required">*</span></label>
        <input type="text" id="inv-name" value="${existing ? existing.name : ''}" placeholder="例如：传感器" required>
      </div>
      <div class="form-group">
        <label>图标 (表情符号)</label>
        <input type="text" id="inv-icon" value="${existing ? existing.icon : '📦'}" placeholder="输入或粘贴任意表情符号，例如 📦🔧📊">
        <p class="form-hint">可直接输入任意表情符号（Win+. 打开系统表情面板）</p>
      </div>
      <div class="form-group">
        <label>区分左右手</label>
        <label class="switch">
          <input type="checkbox" id="inv-leftright" ${existing && existing.hasLeftRight ? 'checked' : ''}>
          <span class="slider"></span>
        </label>
        <p class="form-hint" style="margin-top:8px;">启用后将自动创建左手和右手两个独立库存项</p>
      </div>
    `;
    this.showModal(existing ? '编辑库存类型' : '添加库存类型', contentHtml, () => {
      const name = document.getElementById('inv-name').value.trim();
      const icon = document.getElementById('inv-icon').value.trim();
      const hasLeftRight = document.getElementById('inv-leftright').checked;
      if (!name) { this.notify('请输入库存名称', 'error'); return false; }
      const cfg = { id: existing ? existing.id : 'inv-' + Date.now().toString(36), name, icon: icon || '📦', hasLeftRight, createdAt: existing ? existing.createdAt : new Date().toISOString() };
      let allConfigs = Storage.getInventoryConfig();
      if (existing) {
        allConfigs = allConfigs.map(c => c.id === editId ? cfg : c);
      } else {
        allConfigs.push(cfg);
        // Also initialize inventory for new type
        if (hasLeftRight) {
          Storage.setInventory(cfg.id + '_left', 0, '系统');
          Storage.setInventory(cfg.id + '_right', 0, '系统');
        } else {
          Storage.setInventory(cfg.id, 0, '系统');
        }
      }
      Storage.saveInventoryConfig(allConfigs);
      this.refreshSidebarInventory();
      this.notify(existing ? '库存类型已更新' : '库存类型已添加');
      this.renderInventoryConfig();
      return true;
    });
  },

  deleteInventoryConfig(id) {
    let configs = Storage.getInventoryConfig();
    const cfg = configs.find(c => c.id === id);
    if (!cfg) return;
    this.showConfirm('删除库存类型', `确定要删除 "${cfg.name}" 吗？已存在的库存和交易记录不受影响。`, () => {
      configs = configs.filter(c => c.id !== id);
      Storage.saveInventoryConfig(configs);
      this.refreshSidebarInventory();
      this.notify(`库存类型 "${cfg.name}" 已删除`);
      this.renderInventoryConfig();
    });
  },

  refreshSidebarInventory() {
    const select = document.getElementById('sidebar-device-select');
    if (!select) return;
    const configs = Storage.getInventoryConfig();

    // Build dropdown options
    // Default grouped options
    const defaultOpts = [
      { value: 'glove', label: '🧤 手套库存', isDefault: true },
      { value: 'dexterous', label: '🤖 灵巧手', isDefault: true },
      { value: 'gripper', label: '🔧 夹爪', isDefault: true },
    ];

    // Custom options from config
    const customOpts = [];
    const defaultIds = ['left_glove', 'right_glove', 'left_dexterous_hand', 'right_dexterous_hand', 'gripper'];
    configs.forEach(c => {
      if (defaultIds.includes(c.id)) return;
      if (c.hasLeftRight) {
        customOpts.push({ value: c.id + '_left', label: `${c.icon || '📦'} ${c.name}左手` });
        customOpts.push({ value: c.id + '_right', label: `${c.icon || '📦'} ${c.name}右手` });
      } else {
        customOpts.push({ value: c.id, label: `${c.icon || '📦'} ${c.name}` });
      }
    });

    const currentVal = select.value;
    select.innerHTML = '<option value="">-- 选择设备 --</option>';

    if (defaultOpts.length > 0) {
      defaultOpts.forEach(o => {
        const opt = document.createElement('option');
        opt.value = o.value; opt.textContent = o.label;
        select.appendChild(opt);
      });
    }
    if (customOpts.length > 0) {
      customOpts.forEach(o => {
        const opt = document.createElement('option');
        opt.value = o.value; opt.textContent = o.label;
        select.appendChild(opt);
      });
    }

    // Add action option
    const divider2 = document.createElement('option');
    divider2.disabled = true; divider2.textContent = '──────────────';
    select.appendChild(divider2);
    const actionOpt = document.createElement('option');
    actionOpt.value = '__manage__'; actionOpt.textContent = '⚙ 管理设备类型...';
    select.appendChild(actionOpt);

    // Restore selection
    if (currentVal) select.value = currentVal;

    // Show/hide add button for admin
    const addBtn = document.getElementById('sidebar-add-device-btn');
    if (addBtn) {
      const isPrivileged = API.currentUser && (API.currentUser.role === 'admin' || API.currentUser.role === 'superadmin');
      addBtn.style.display = isPrivileged ? '' : 'none';
    }
  },

  onSidebarDeviceChange(value) {
    if (!value) return;
    if (value === '__manage__') {
      this.switchTab('equipment-config');
      // Reset select back
      const select = document.getElementById('sidebar-device-select');
      if (select) select.value = '';
      return;
    }
    this.switchTab(value);
  },

  // ==================== CONFIRM DIALOG ====================
  showConfirm(title, message, onConfirm) {
    const overlay = document.getElementById('modal-overlay');
    const body = document.getElementById('modal-body');
    const titleEl = document.getElementById('modal-title');
    const saveBtn = document.getElementById('modal-save');
    const closeBtn = document.getElementById('modal-close-btn');

    titleEl.textContent = title;
    body.innerHTML = `<div style="text-align:center;padding:10px 0;"><p style="font-size:0.95rem;white-space:pre-line;">${message}</p></div>`;
    saveBtn.textContent = '确认';
    saveBtn.className = 'btn btn-danger';
    closeBtn.textContent = '取消';
    overlay.style.display = 'flex';

    const cleanup = () => {
      saveBtn.textContent = '确认';
      saveBtn.className = 'btn btn-primary';
      closeBtn.textContent = '取消';
      document.getElementById('modal-close').onclick = () => { overlay.style.display = 'none'; };
      overlay.onclick = (e) => { if (e.target === overlay) overlay.style.display = 'none'; };
    };

    document.getElementById('modal-save').onclick = async () => {
      overlay.style.display = 'none';
      cleanup();
      if (onConfirm) await onConfirm();
    };
    document.getElementById('modal-close').onclick = () => { overlay.style.display = 'none'; cleanup(); };
    closeBtn.onclick = () => { overlay.style.display = 'none'; cleanup(); };
    overlay.onclick = (e) => { if (e.target === overlay) { overlay.style.display = 'none'; cleanup(); } };
  },

  // ==================== UNDO ====================
  notifyWithUndo(message) {
    // Undo is now in the transactions page — just show a regular notification
    this.notify(message);
  },

  undoLastAction(el) {
    // Remove the notification first
    if (el) { clearTimeout(el._timeout); el.classList.add('fade-out'); setTimeout(() => el.remove(), 300); }
    const entry = Storage.popUndo();
    if (!entry) { this.notify('无法撤销，操作已过期', 'warning'); return; }
    if (entry.action === 'adjustInventory') {
      const d = entry.data;
      const currentQty = Storage.getInventory(d.type).quantity;
      const delta = d.previousQuantity - currentQty;
      Storage.setInventory(d.type, d.previousQuantity, d.updatedBy || '系统');
      if (API.online) {
        API.adjustInventory(d.type, delta, d.updatedBy || '系统', '').catch(() => {});
      }
      // Record undo transaction
      const handType = (d.type === 'left_glove' || d.type === 'left_dexterous_hand') ? 'left'
        : (d.type === 'right_glove' || d.type === 'right_dexterous_hand') ? 'right' : null;
      Storage.addTransaction({
        equipmentType: d.type, handType, direction: delta > 0 ? 'in' : 'out',
        quantity: Math.abs(delta), snCode: '', machineNumber: '',
        updatedBy: d.updatedBy || '系统', note: '撤销操作',
      });
      this.notify('操作已撤销');
      this.refreshCurrentTab();
    }
  },

  undoFromTransactions(idx) {
    const entry = Storage._undoStack[idx];
    if (!entry || entry.expiresAt < Date.now()) { this.notify('无法撤销，操作已过期', 'warning'); this.renderTransactions(this.currentPage.transactions); return; }
    // Remove from stack
    Storage._undoStack.splice(idx, 1);
    if (entry.action === 'adjustInventory') {
      const d = entry.data;
      const currentQty = Storage.getInventory(d.type).quantity;
      const delta = d.previousQuantity - currentQty;
      Storage.setInventory(d.type, d.previousQuantity, d.updatedBy || '系统');
      if (API.online) {
        API.adjustInventory(d.type, delta, d.updatedBy || '系统', '').catch(() => {});
      }
      const handType = (d.type === 'left_glove' || d.type === 'left_dexterous_hand') ? 'left'
        : (d.type === 'right_glove' || d.type === 'right_dexterous_hand') ? 'right' : null;
      Storage.addTransaction({
        equipmentType: d.type, handType, direction: delta > 0 ? 'in' : 'out',
        quantity: Math.abs(delta), snCode: '', machineNumber: '',
        updatedBy: d.updatedBy || '系统', note: '撤销操作',
      });
      this.notify('操作已撤销');
      this.renderTransactions(this.currentPage.transactions);
    }
  },

  // ==================== AUDIT LOG ====================
  _auditActionLabel(action) {
    const map = {
      'inventory_update': '库存更新',
      'machine_add': '添加机器',
      'machine_status': '机器上下线',
      'machine_delete': '删除机器',
      'transaction': '流水记录',
      'transaction_delete': '删除流水',
      'clear_all': '清空数据',
      'user_add': '添加用户',
      'user_delete': '删除用户',
      'settings_update': '系统设置',
      'equipment_config': '设备配置',
      'inventory_config': '库存配置',
      'backup_restore': '备份恢复',
    };
    return map[action] || action;
  },

  renderAuditLog() {
    const logs = Storage.getAuditLog();
    const html = `
      <div class="page-header">
        <h2>📝 操作审计日志</h2>
        <span class="page-subtitle">记录所有系统操作，最多保留1000条</span>
      </div>
      <div class="table-container">
        <table class="data-table">
          <thead><tr><th>时间</th><th>操作类型</th><th>详情</th><th>操作人</th></tr></thead>
          <tbody>${logs.length === 0 ? '<tr><td colspan="4" class="empty-text">暂无审计记录</td></tr>' :
            logs.map(l => `
              <tr>
                <td>${this._formatTime(l.timestamp)}</td>
                <td><span class="badge badge-info">${this._auditActionLabel(l.action)}</span></td>
                <td>${l.detail}</td>
                <td>${l.user}</td>
              </tr>
            `).join('')
          }</tbody>
        </table>
      </div>
    `;
    document.getElementById('main-content').innerHTML = html;
  },

  // ==================== USER MANAGEMENT ====================
  async renderUserManagement() {
    let users = await this._fetchUsers();
    if (this.currentTab !== 'users') return;
    // Merge permissions from localStorage
    const localUsers = Storage.getUsers();
    users = users.map(u => {
      const local = localUsers.find(l => l.username === u.username);
      if (local && local.permissions) u.permissions = local.permissions;
      return u;
    });
    const currentUser = API.currentUser;
    const isSuperAdmin = currentUser && currentUser.role === 'superadmin';
    const isAdmin = currentUser && (currentUser.role === 'admin' || currentUser.role === 'superadmin');

    const roleLabel = (role) => {
      if (role === 'superadmin') return '超级管理员';
      if (role === 'admin') return '管理员';
      return '普通用户';
    };
    const roleBadge = (role) => {
      if (role === 'superadmin') return 'badge-superadmin';
      if (role === 'admin') return 'badge-admin';
      return 'badge-user';
    };
    const canDelete = (u) => {
      if (u.id === currentUser.id) return false; // can't delete self
      if (u.role === 'superadmin') return false; // no one can delete superadmin
      if (isSuperAdmin) return true; // superadmin can delete anyone (except superadmin)
      if (isAdmin && u.role === 'user') return true; // admin can delete users
      return false;
    };
    const canEdit = (u) => {
      if (u.id === currentUser.id) return true; // everyone can edit self
      if (isSuperAdmin) {
        if (u.system !== currentUser.system) return false; // different system
        if (u.role === 'superadmin' && u.id !== currentUser.id) return false; // can't edit other superadmin
        return true; // superadmin can edit admins and users in same system
      }
      if (isAdmin && u.role === 'user') {
        return u.parentId === currentUser.id || u.createdBy === currentUser.id;
      }
      return false;
    };

    const onCount = users.filter(u => u.online).length;
    const offCount = users.filter(u => !u.online).length;
    const html = `
      <div class="page-header">
        <h2>👥 用户管理</h2>
        <div class="header-actions" style="display:flex;gap:8px;align-items:center;">
          <select id="um-status-filter" onchange="App._filterUserTable()" style="padding:6px 10px;border:1px solid var(--border-color);border-radius:6px;font-size:0.8rem;">
            <option value="all">全部 (${users.length})</option>
            <option value="online">🟢 在线 (${onCount})</option>
            <option value="offline">⚫ 离线 (${offCount})</option>
          </select>
          <button class="btn btn-primary" onclick="App.showAddUserForm()">+ 添加用户</button>
        </div>
      </div>
      <div class="table-container">
        <table class="data-table" id="um-user-table">
          <thead><tr><th>在线</th><th>用户名</th><th>角色</th><th>权限</th><th>所属系统</th><th>创建时间</th><th>操作</th></tr></thead>
          <tbody>${users.length === 0 ? '<tr><td colspan="7" class="empty-text">暂无用户</td></tr>' :
            users.map(u => {
              const perms = u.permissions || {};
              const canDelSN = perms.canDeleteSN;
              return `
              <tr data-user-status="${u.online ? 'online' : 'offline'}">
                <td><span class="online-dot ${u.online ? 'online' : 'offline'}" title="${u.online ? '在线' : '离线'}"></span></td>
                <td><strong>${u.displayName || u.username}</strong>${currentUser && u.id === currentUser.id ? ' <span class="badge badge-info">当前</span>' : ''}</td>
                <td><span class="badge ${roleBadge(u.role)}">${roleLabel(u.role)}</span></td>
                <td>
                  ${isSuperAdmin && u.role !== 'superadmin' ? `<button class="btn btn-xs ${canDelSN ? 'btn-success' : 'btn-outline'}" onclick="App._toggleSNDeletePerm('${u.id}')" title="${canDelSN ? '点击取消SN码删除权限' : '点击授予SN码删除权限'}">🗑 ${canDelSN ? '已授权' : '未授权'}</button>`
                  : (canDelSN ? '<span class="badge badge-info">SN删除</span>' : '<span class="text-muted" style="font-size:0.75rem;">-</span>')}
                </td>
                <td>${u.system === 'operations' ? '📊 运营系统' : '🔧 运维系统'}</td>
                <td>${this._formatTime(u.createdAt)}</td>
                <td>${canEdit(u) ? `<button class="btn btn-xs btn-outline" onclick="App._showEditUser('${u.id}', '${u.username}')">修改</button>` : ''} ${canDelete(u) ? `<button class="btn btn-xs btn-danger" onclick="App.deleteUser('${u.id}', '${u.username}')">删除</button>` : (canEdit(u) ? '' : '<span class="text-tertiary" style="font-size:0.75rem;">受保护</span>')}</td>
              </tr>`;
            }).join('')
          }</tbody>
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
    const isSuperAdmin = API.currentUser && API.currentUser.role === 'superadmin';
    const contentHtml = `
      <div class="form-group">
        <label>中文名 <span class="required">*</span></label>
        <input type="text" id="new-displayname" placeholder="输入中文姓名（用于显示）" required>
      </div>
      <div class="form-group">
        <label>用户名 <span class="required">*</span></label>
        <input type="text" id="new-username" placeholder="输入登录用户名" required>
      </div>
      <div class="form-group">
        <label>密码 <span class="required">*</span></label>
        <input type="password" id="new-password" placeholder="输入密码" required>
      </div>
      <div class="form-group">
        <label>角色</label>
        <select id="new-role">
          <option value="user">普通用户</option>
          ${isSuperAdmin ? '<option value="admin">管理员</option>' : ''}
        </select>
        <p class="form-hint" style="margin-top:8px;">${isSuperAdmin ? '超级管理员可创建管理员或普通用户' : '管理员只能创建普通用户'}</p>
      </div>
      ${isSuperAdmin ? `
      <div class="form-group">
        <label>所属系统</label>
        <select id="new-system">
          <option value="maintenance">运维系统</option>
          <option value="operations">运营系统</option>
        </select>
      </div>` : ''}
    `;
    this.showModal('添加用户', contentHtml, async () => {
      const displayName = document.getElementById('new-displayname').value.trim();
      const username = document.getElementById('new-username').value.trim();
      const password = document.getElementById('new-password').value.trim();
      const role = document.getElementById('new-role').value;
      const system = isSuperAdmin ? document.getElementById('new-system').value : '';
      if (!displayName) { this.notify('请输入中文名', 'error'); return false; }
      if (!username || !password) { this.notify('请输入用户名和密码', 'error'); return false; }
      if (username.length < 2) { this.notify('用户名至少2个字符', 'error'); return false; }
      if (password.length < 4) { this.notify('密码至少4个字符', 'error'); return false; }

      const result = await this._addUser(username, password, role, system, displayName);
      if (!result.success) { this.notify(result.message, 'error'); return false; }
      this.notify(`用户 ${displayName}(${username}) 创建成功`);
      this.renderUserManagement();
      return true;
    });
  },

  async _toggleSNDeletePerm(userId) {
    // Refresh users from both server and local
    const serverUsers = await this._fetchUsers();
    const localUsers = Storage.getUsers();
    const serverUser = serverUsers.find(u => u.id === userId);
    if (!serverUser || serverUser.role === 'superadmin') return;
    let localUser = localUsers.find(u => u.username === serverUser.username);
    if (!localUser) {
      localUser = { ...serverUser };
      localUsers.push(localUser);
    }
    if (!localUser.permissions) localUser.permissions = {};
    localUser.permissions.canDeleteSN = !localUser.permissions.canDeleteSN;
    Storage.saveUsers(localUsers);
    if (API.currentUser && API.currentUser.username === serverUser.username) {
      API.currentUser.permissions = localUser.permissions;
    }
    this.notify(`${serverUser.username} SN码删除权限已${localUser.permissions.canDeleteSN ? '授予' : '撤销'}`);
    this.renderUserManagement();
  },

  _hasSNDeletePerm() {
    const u = API.currentUser;
    if (!u) return false;
    if (u.role === 'superadmin' || u.role === 'admin') return true;
    // Regular users need explicit permission
    const users = Storage.getUsers();
    const stored = users.find(lu => lu.username === u.username);
    return stored && stored.permissions && stored.permissions.canDeleteSN;
  },

  async deleteUser(id, username) {
    this.showConfirm('删除用户', `确定删除用户 "${username}"？此操作不可恢复。`, async () => {
      const result = await this._deleteUser(id);
      if (!result.success) { this.notify(result.message, 'error'); return; }
      // Also remove from localStorage
      const localUsers = Storage.getUsers();
      Storage.saveUsers(localUsers.filter(u => u.username !== username));
      this.notify(`用户 ${username} 已删除`);
      this.renderUserManagement();
    });
  },

  async _fetchUsers() {
    if (!API.online) return [];
    try {
      const res = await fetch(API.baseURL + '/api/users', { headers: API._headers() });
      if (!res.ok) return [];
      return await res.json();
    } catch { return []; }
  },

  async _addUser(username, password, role, system, displayName) {
    if (!API.online) return { success: false, message: '离线模式不支持用户管理' };
    try {
      const body = { username, password, role, displayName };
      if (system) body.system = system;
      const res = await fetch(API.baseURL + '/api/users', {
        method: 'POST', headers: API._headers(),
        body: JSON.stringify(body),
      });
      const data = await res.json();
      return res.ok ? { success: true } : { success: false, message: data.error };
    } catch { return { success: false, message: '网络错误' }; }
  },

  async _deleteUser(id) {
    if (!API.online) return { success: false, message: '离线模式不支持用户管理' };
    try {
      const res = await fetch(API.baseURL + '/api/users/' + id, {
        method: 'DELETE', headers: API._headers(),
      });
      const data = await res.json();
      return res.ok ? { success: true } : { success: false, message: data.error };
    } catch { return { success: false, message: '网络错误' }; }
  },

  async _updateUser(userId, username, password) {
    if (!API.online) return { success: false, message: '离线模式不支持用户管理' };
    try {
      const res = await fetch(API.baseURL + '/api/users/' + userId, {
        method: 'PUT', headers: API._headers(),
        body: JSON.stringify({ username, password }),
      });
      const data = await res.json();
      return res.ok ? { success: true } : { success: false, message: data.error };
    } catch { return { success: false, message: '网络错误' }; }
  },

  _showEditUser(userId, currentUsername) {
    const html = `
      <div class="form-group"><label>用户名 <span class="required">*</span></label><input type="text" id="edit-user-name" value="${currentUsername}" required></div>
      <div class="form-group"><label>新密码</label><input type="password" id="edit-user-pwd" placeholder="留空则不修改密码"></div>
      <div class="form-group"><label>确认新密码</label><input type="password" id="edit-user-pwd2" placeholder="再次输入新密码"></div>
    `;
    this.showModal('修改账户', html, async () => {
      const name = document.getElementById('edit-user-name').value.trim();
      const pwd = document.getElementById('edit-user-pwd').value;
      const pwd2 = document.getElementById('edit-user-pwd2').value;
      if (!name) { this.notify('用户名不能为空', 'error'); return false; }
      if (pwd && pwd !== pwd2) { this.notify('两次密码不一致', 'error'); return false; }
      const result = await this._updateUser(userId, name, pwd || undefined);
      if (result.success) {
        this.notify('账户已修改');
        // If edited self, update currentUser info
        if (userId === API.currentUser?.id) {
          API.currentUser.username = name;
          localStorage.setItem('gms_current_user', JSON.stringify(API.currentUser));
        }
        this.renderUserManagement();
      } else {
        this.notify(result.message || '修改失败', 'error');
        return false;
      }
    });
  },

  // ==================== SETTINGS ====================
  renderSettings() {
    const settings = Storage.getSettings();
    const allData = Storage.exportAllData();
    const dataSize = (new Blob([allData]).size / 1024).toFixed(1);
    const lastBackup = this._getLastBackupTime();

    const html = `
      <div class="page-header"><h2>⚙️ 系统设置</h2></div>
      <div class="settings-grid">
        <div class="settings-card">
          <h3>🎨 外观</h3>
          <div class="form-group">
            <label>深色模式</label>
            <label class="switch">
              <input type="checkbox" ${settings.darkMode ? 'checked' : ''} onchange="App.toggleTheme()">
              <span class="slider"></span>
            </label>
          </div>
          <p class="form-hint">系统会自动跟随设备主题，手动切换后将固定主题</p>
        </div>
        <div class="settings-card">
          <h3>📊 仪表板卡片配置</h3>
          <p class="form-hint">选择要在系统总览中显示的库存卡片</p>
          <div id="dashboard-cards-checklist">${this._renderDashboardCardsChecklist(settings)}</div>
          <button class="btn btn-primary btn-sm" onclick="App.saveDashboardCards()">保存卡片配置</button>
        </div>
        <div class="settings-card">
          <h3>💾 数据管理</h3>
          <p>当前数据大小: <strong>${dataSize} KB</strong></p>
          ${lastBackup ? `<p class="form-hint">最近备份: ${this._formatTime(lastBackup)}</p>` : '<p class="form-hint">尚未备份</p>'}
          <p class="form-hint">备份包含全部数据（含附件图片），恢复将覆盖当前数据</p>
          <div style="display:flex;gap:8px;flex-wrap:wrap;">
            <button class="btn btn-primary" onclick="App._backupData()">📤 备份数据 (含图片)</button>
            <input type="file" id="restore-file-input" accept=".zip,.json" style="display:none;" onchange="App._restoreData(this)">
            <button class="btn btn-outline" onclick="document.getElementById('restore-file-input').click()">📥 恢复数据</button>
            ${API.currentUser && (API.currentUser.role === 'admin' || API.currentUser.role === 'superadmin') ? '<button class="btn btn-danger" onclick="App.resetAllData()">🗑️ 清空所有数据</button>' : ''}
          </div>
          <div id="restore-result" style="margin-top:8px;font-size:0.8rem;"></div>
        </div>
        <div class="settings-card">
          <h3>🔍 数据完整性</h3>
          <p class="form-hint">检查库存、机器、交易记录的一致性</p>
          <button class="btn btn-outline" onclick="App.checkDataIntegrity()">执行检查</button>
          <div id="integrity-result" style="margin-top:12px;"></div>
        </div>
        <div class="settings-card">
          <h3>ℹ️ 关于</h3>
          <p><strong>手套管理系统 v3.9</strong> <span style="font-size:0.75rem;color:var(--text-tertiary);">2026-06-04</span></p>
          <p style="font-size:0.8rem;color:var(--text-secondary);">设备库存与机器管理系统 · 支持长期稳定运行</p>
          <div style="margin-top:8px;font-size:0.75rem;line-height:1.8;">
            <select id="version-select" onchange="App._showVersionDetail(this.value)" style="width:100%;padding:6px;border-radius:6px;border:1px solid var(--border-color);margin-bottom:8px;">
              <option value="">-- 选择版本查看更新内容 --</option>
              <option value="v3.7">v3.7 — 2026-06-03</option>
              <option value="v3.6">v3.6 — 2026-06-03</option>
              <option value="v3.5">v3.5 — 2026-06-02</option>
              <option value="v3.0">v3.0 — 2026-05-29</option>
            </select>
            <div id="version-detail" style="color:var(--text-tertiary);">
              <strong>v3.7 (2026-06-03)：</strong><br>
              · 修复空闲库存计算公式（available = inv.quantity）<br>
              · 修复全部库存计数公式（库存量+使用中+损坏）<br>
              · 注册表更新改为无条件执行（消除数据不一致）<br>
              · SN码页面可点击📷按钮上传/更换照片<br>
              · 出库输入SN码自动显示已有附件缩略图<br>
              · 批量发货给厂家（多选+全选+快递单号选填）<br>
              · 仪表盘卡片支持拖拽排序<br>
              · 服务器长期运行保护（崩溃恢复、自动备份、WAL检查点）<br>
              · 优雅关闭（SIGTERM→检查点→关闭数据库）<br>
              · 新增启动脚本（Windows .bat + Linux .sh + systemd服务）<br>
              · 审计日志操作类型中文显示<br>
              · 仪表板卡片配置支持新的汇总卡片<br>
            </div>
          </div>
        </div>
      </div>
    `;
    document.getElementById('main-content').innerHTML = html;
  },

  _getLastBackupTime() {
    const keys = Object.values(Storage.KEYS);
    let latest = 0;
    keys.forEach(k => {
      const data = localStorage.getItem(k);
      if (data) {
        try {
          const parsed = JSON.parse(data);
          if (parsed.updatedAt) {
            const t = new Date(parsed.updatedAt).getTime();
            if (t > latest) latest = t;
          }
        } catch {}
      }
    });
    // Also check equipment/inventory config
    ['gms_equipment_config', 'gms_inventory_config'].forEach(k => {
      const data = localStorage.getItem(k);
      if (data) {
        try {
          const arr = JSON.parse(data);
          arr.forEach(item => {
            if (item.createdAt) {
              const t = new Date(item.createdAt).getTime();
              if (t > latest) latest = t;
            }
          });
        } catch {}
      }
    });
    return latest > 0 ? new Date(latest).toISOString() : null;
  },

  _backupData() {
    if (!API.online) {
      // 离线回退：仅导出JSON（不含图片）
      const json = Storage.exportAllData();
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `手套管理系统备份-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      this.notify('离线备份已下载（不含图片）', 'warning');
      return;
    }
    // 在线：从服务端下载完整ZIP（含图片）
    fetch(API.baseURL + '/api/export/full', { headers: API._headers() })
      .then(res => {
        if (!res.ok) throw new Error('导出失败');
        return res.blob();
      })
      .then(blob => {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `手套管理系统备份-${new Date().toISOString().slice(0, 10)}.zip`;
        a.click();
        URL.revokeObjectURL(url);
        this.notify('数据已备份（含图片）');
      })
      .catch(e => this.notify('备份失败: ' + e.message, 'error'));
  },

  _restoring: false,

  async _restoreData(fileInput) {
    const file = fileInput.files[0];
    if (!file) return;
    const el = document.getElementById('restore-result');
    const isZip = file.name.endsWith('.zip');

    this.showConfirm('恢复数据', '恢复将<strong>覆盖</strong>当前全部数据，此操作不可恢复！确定继续？', async () => {
      if (el) el.innerHTML = '<span style="color:var(--color-warning);">⏳ 正在恢复...</span>';
      this._restoring = true;
      try {
        if (isZip && API.online) {
          // ZIP文件：发送到服务端全量恢复（含图片）
          const arrayBuf = await file.arrayBuffer();
          const base64 = this._arrayBufferToBase64(arrayBuf);
          const res = await fetch(API.baseURL + '/api/import/full', {
            method: 'POST',
            headers: API._headers(),
            body: JSON.stringify({ zipData: base64 })
          });
          const data = await res.json();
          if (!res.ok || !data.success) {
            if (el) el.innerHTML = '<span style="color:red;">❌ ' + (data.error || data.message || '恢复失败') + '</span>';
            this._restoring = false;
            return;
          }
          await Storage._fullSyncFromServer();
        } else {
          // JSON文件：离线恢复或旧版备份
          const text = await file.text();
          const result = Storage.importAllData(text);
          if (!result.success) { if (el) el.innerHTML = '<span style="color:red;">❌ ' + result.message + '</span>'; this._restoring = false; return; }
          if (API.online) {
            await API.clearAllData();
            const machines = Storage.getMachines();
            const txs = Storage.getTransactions();
            const reg = Storage.getSNRegistry();
            for (const m of machines) { await API.addMachine(m).catch(() => {}); }
            for (const tx of txs) { await API.addTransaction(tx).catch(() => {}); }
            for (const r of reg) { await API.upsertSNRegistry(r).catch(() => {}); }
            await API.saveSettings(Storage.getSettings()).catch(() => {});
            await new Promise(r => setTimeout(r, 3000));
            await Storage._fullSyncFromServer();
          }
        }
        if (el) el.innerHTML = '<span style="color:#10b981;">✅ 数据已恢复！</span>';
        this.notify('数据已恢复');
        this.renderDashboard();
        this.refreshSidebarInventory();
        this.refreshCurrentTab();
      } catch(e) {
        if (el) el.innerHTML = '<span style="color:red;">❌ ' + e.message + '</span>';
        this.notify('恢复失败: ' + e.message, 'error');
      }
      this._restoring = false;
    });
    fileInput.value = '';
  },

  _arrayBufferToBase64(buffer) {
    let binary = '';
    const bytes = new Uint8Array(buffer);
    const chunkSize = 8192;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
    }
    return btoa(binary);
  },

  checkDataIntegrity() {
    const issues = [];
    const txs = Storage.getTransactions();
    const machines = Storage.getMachines();

    // Check for negative inventory
    const invTypes = ['left_glove', 'right_glove', 'left_dexterous_hand', 'right_dexterous_hand', 'gripper'];
    invTypes.forEach(t => {
      const inv = Storage.getInventory(t);
      if (inv.quantity < 0) {
        issues.push({ type: 'error', msg: `${Storage._typeLabel(t)} 库存为负数 (${inv.quantity})` });
      }
    });

    // Check for machines without device type
    machines.forEach(m => {
      if (!m.deviceType) {
        issues.push({ type: 'warning', msg: `机器 ${m.machineNumber} (${m.id}) 缺少设备类型` });
      }
    });

    // Check for duplicate online status
    const onlineByMachine = {};
    machines.filter(m => m.status === 'online').forEach(m => {
      onlineByMachine[m.machineNumber] = (onlineByMachine[m.machineNumber] || 0) + 1;
    });
    Object.entries(onlineByMachine).forEach(([num, count]) => {
      if (count > 1) {
        issues.push({ type: 'warning', msg: `机器 ${num} 存在 ${count} 条在线记录（应只有1条）` });
      }
    });

    // Check for transactions referencing non-existent machine
    const machineNumbers = new Set(machines.map(m => m.machineNumber));
    txs.forEach(t => {
      if (t.machineNumber && !machineNumbers.has(t.machineNumber)) {
        issues.push({ type: 'warning', msg: `流水 ${t.id} 引用不存在机器 ${t.machineNumber}` });
      }
    });

    // Check custom inventory types with negative stock
    const invConfig = Storage.getInventoryConfig();
    invConfig.forEach(c => {
      const types = c.hasLeftRight ? [c.id + '_left', c.id + '_right'] : [c.id];
      types.forEach(t => {
        if (!invTypes.includes(t)) {
          const inv = Storage.getInventory(t);
          if (inv.quantity < 0) {
            issues.push({ type: 'error', msg: `${Storage._typeLabel(t)} 库存为负数 (${inv.quantity})` });
          }
        }
      });
    });

    const resultEl = document.getElementById('integrity-result');
    if (!resultEl) return;
    if (issues.length === 0) {
      resultEl.innerHTML = '<div class="alert-banner success" style="margin-top:8px;">✅ 数据完整性检查通过，未发现问题</div>';
    } else {
      const issueHtml = issues.map(i => `<div class="integrity-issue ${i.type}">${i.type === 'error' ? '❌' : '⚠'} ${i.msg}</div>`).join('');
      resultEl.innerHTML = `<div style="margin-top:8px;"><strong>发现 ${issues.length} 个问题:</strong>${issueHtml}</div>`;
    }
    if (API.online) {
      API.getDataIntegrity().then(data => {
        if (data && data.issues && data.issues.length > 0) {
          const serverIssues = data.issues.map(i => `<div class="integrity-issue warning">🖥 ${i}</div>`).join('');
          resultEl.innerHTML += `<div style="margin-top:8px;"><strong>服务器端检查:</strong>${serverIssues}</div>`;
        }
      }).catch(() => {});
    }
  },

  saveThreshold() {
    const val = parseInt(document.getElementById('setting-threshold').value) || 10;
    const settings = Storage.getSettings();
    settings.lowStockThreshold = val;
    Storage.saveSettings(settings);
    this.notify(`低库存阈值已设置为 ${val}`);
  },

  _renderDashboardCardsChecklist(settings) {
    const cards = settings.dashboardCards || ['totalGloves', 'damagedGloves', 'inRepairGloves', 'left_glove', 'right_glove', 'left_dexterous_hand', 'right_dexterous_hand', 'gripper', 'onlineMachines', 'todayTransactions'];
    const invConfig = Storage.getInventoryConfig();
    let html = '';
    // Inventory types from config
    invConfig.forEach(c => {
      if (c.hasLeftRight) {
        html += this._cardCheckbox(cards, c.id + '_left', (c.icon || '📦') + ' ' + c.name + '左手');
        html += this._cardCheckbox(cards, c.id + '_right', (c.icon || '📦') + ' ' + c.name + '右手');
      } else {
        html += this._cardCheckbox(cards, c.id, (c.icon || '📦') + ' ' + c.name);
      }
    });
    // Special cards
    html += this._cardCheckbox(cards, 'totalGloves', '🧤 手套总数');
    html += this._cardCheckbox(cards, 'totalDexterous', '🤖 灵巧手总数');
    html += this._cardCheckbox(cards, 'damagedGloves', '⚠️ 损坏设备');
    html += this._cardCheckbox(cards, 'inRepairGloves', '🔧 售后中设备');
    html += this._cardCheckbox(cards, 'onlineMachines', '🖥️ 在线机器数量');
    html += this._cardCheckbox(cards, 'todayTransactions', '📋 今日操作记录');
    return html;
  },

  _cardCheckbox(cards, value, label) {
    const checked = cards.includes(value) ? 'checked' : '';
    return `<label style="display:block;margin:6px 0;cursor:pointer;"><input type="checkbox" value="${value}" ${checked} onchange="App._onCardCheckChange()"> ${label}</label>`;
  },

  _onCardCheckChange() {
    // No-op, just for tracking — actual save happens in saveDashboardCards
  },

  saveDashboardCards() {
    const checks = document.querySelectorAll('#dashboard-cards-checklist input[type="checkbox"]');
    const selected = [];
    checks.forEach(cb => { if (cb.checked) selected.push(cb.value); });
    if (selected.length === 0) { this.notify('至少需要选择一个卡片', 'error'); return; }
    const settings = Storage.getSettings();
    settings.dashboardCards = selected;
    Storage.saveSettings(settings);
    this.notify('仪表板卡片配置已保存');
    this.renderDashboard();
  },

  // ==================== EXPORT / IMPORT ====================
  exportAllData() {
    this._backupData();
  },

  importAllData(input) {
    this._restoreData(input);
  },

  resetAllData() {
    if (!API.currentUser || (API.currentUser.role !== 'admin' && API.currentUser.role !== 'superadmin')) {
      this.notify('仅超级管理员可执行此操作', 'error');
      return;
    }
    this.showConfirm('清空所有数据', '确定要清空所有数据吗？此操作不可恢复！', () => {
      this.showConfirm('二次确认', '再次确认：清空所有手套库存、灵巧手库存、夹爪库存、机器记录和流水记录？', async () => {
        await Storage.clearAllData();
        this.notify('所有数据已清空');
        this.switchTab('dashboard');
      });
    });
  },

  exportXLSX() {
    if (!API.online) { this.notify('离线模式不支持Excel导出，请使用CSV导出', 'error'); return; }
    fetch(API.baseURL + '/api/export/xlsx', { headers: API._headers() })
      .then(res => { if (!res.ok) throw new Error(); return res.blob(); })
      .then(blob => {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `流水记录-${new Date().toISOString().slice(0, 10)}.xlsx`;
        a.click();
        URL.revokeObjectURL(url);
        this.notify('Excel导出成功');
      })
      .catch(() => this.notify('导出失败', 'error'));
  },

  exportCSV() {
    const transactions = Storage.getTransactions();
    const headers = ['时间', '设备类型', '左右手', '出入库', '数量', 'SN码', '机器编号', '更新人', '备注'];
    const rows = transactions.map(t => [
      this._formatTime(t.timestamp),
      this._equipmentLabel(t.equipmentType, t.handType),
      t.handType === 'left' ? '左手' : t.handType === 'right' ? '右手' : '-',
      t.direction === 'in' ? '入库' : '出库',
      t.quantity,
      t.snCode || '',
      t.machineNumber || '',
      t.updatedBy || '',
      t.note || '',
    ]);
    const csvRows = [headers, ...rows].map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
    const blob = new Blob(['\uFEFF' + csvRows], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `流水记录-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    this.notify('CSV导出成功');
  },

  printTransactions() {
    const transactions = Storage.getTransactions();
    let html = `<html><head><meta charset="utf-8"><title>流水记录</title>
      <style>body{font-family:sans-serif;padding:20px}table{border-collapse:collapse;width:100%}th,td{border:1px solid #ddd;padding:8px;text-align:left;font-size:12px}th{background:#f5f5f5}h2{text-align:center}</style></head>
      <body><h2>流水记录报表</h2><p>打印时间: ${new Date().toLocaleString()}</p>
      <table><tr><th>时间</th><th>设备类型</th><th>左右手</th><th>操作</th><th>数量</th><th>SN码</th><th>更新人</th></tr>
      ${transactions.map(t => `<tr><td>${this._formatTime(t.timestamp)}</td><td>${this._equipmentLabel(t.equipmentType, t.handType)}</td><td>${t.handType === 'left' ? '左手' : t.handType === 'right' ? '右手' : '-'}</td><td>${t.direction === 'in' ? '入库' : '出库'}</td><td>${t.quantity}</td><td>${t.snCode || '-'} ${t.attachment ? '<a href="'+t.attachment+'" target="_blank" title="查看附件">📎</a>' : ''}</td><td>${t.updatedBy || '-'}</td></tr>`).join('')}
      </table></body></html>`;
    const w = window.open('', '_blank', 'width=900,height=600');
    w.document.write(html);
    w.document.close();
    setTimeout(() => w.print(), 500);
  },

  printReports() {
    const transactions = this._getReportFilteredTransactions();
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    const weekStart = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

    const todayTx = transactions.filter(t => t.timestamp >= todayStart);
    const weekTx = transactions.filter(t => t.timestamp >= weekStart);
    const monthTx = transactions.filter(t => t.timestamp >= monthStart);

    const allStats = this._calcStats(transactions);
    const todayStats = this._calcStats(todayTx);
    const weekStats = this._calcStats(weekTx);
    const monthStats = this._calcStats(monthTx);

    const leftGlove = Storage.getInventory('left_glove');
    const rightGlove = Storage.getInventory('right_glove');
    const leftDex = Storage.getInventory('left_dexterous_hand');
    const rightDex = Storage.getInventory('right_dexterous_hand');
    const gripper = Storage.getInventory('gripper');
    const onlineCount = Storage.getOnlineMachineCount();
    const machines = Storage.getMachines();
    const totalMachines = [...new Set(machines.map(m => m.machineNumber))].length;

    const printHtml = `
      <html><head><meta charset="utf-8"><title>报表统计</title>
      <style>
        body { font-family: "Microsoft YaHei", sans-serif; padding: 20px 30px; color: #1a1a1a; font-size: 13px; }
        h1 { text-align: center; font-size: 20px; margin-bottom: 4px; }
        .subtitle { text-align: center; font-size: 11px; color: #888; margin-bottom: 20px; }
        table { border-collapse: collapse; width: 100%; margin-bottom: 16px; }
        th, td { border: 1px solid #ccc; padding: 6px 8px; font-size: 11px; }
        th { background: #f0f0f0; font-weight: 600; }
        .section { margin-bottom: 20px; }
        .section h3 { font-size: 14px; border-bottom: 2px solid #333; padding-bottom: 4px; margin-bottom: 8px; }
        .stat-grid { display: flex; flex-wrap: wrap; gap: 10px; margin-bottom: 16px; }
        .stat-item { flex: 1; min-width: 140px; background: #f9fafb; padding: 10px; border-radius: 4px; text-align: center; }
        .stat-item .value { font-size: 18px; font-weight: 700; }
        .stat-item .label { font-size: 10px; color: #888; }
        @media print { body { padding: 0; } }
      </style></head>
      <body>
        <h1>运维系统 · 报表统计</h1>
        <p class="subtitle">打印时间: ${new Date().toLocaleString()}</p>

        <div class="section"><h3>当前库存</h3>
          <table><tr><th>左手手套</th><th>右手手套</th><th>左手灵巧手</th><th>右手灵巧手</th><th>夹爪(Pika)</th><th>在线机器</th><th>总机器数</th></tr>
            <tr><td>${leftGlove.quantity}</td><td>${rightGlove.quantity}</td><td>${leftDex.quantity}</td><td>${rightDex.quantity}</td><td>${gripper.quantity}</td><td>${onlineCount}</td><td>${totalMachines}</td></tr>
          </table>
        </div>

        <div class="section"><h3>操作统计</h3>
          <table>
            <tr><th>指标</th><th>今日</th><th>近7天</th><th>本月</th><th>总计</th></tr>
            <tr><td>手套入库</td><td>${todayStats.gloveIn}</td><td>${weekStats.gloveIn}</td><td>${monthStats.gloveIn}</td><td>${allStats.gloveIn}</td></tr>
            <tr><td>手套出库</td><td>${todayStats.gloveOut}</td><td>${weekStats.gloveOut}</td><td>${monthStats.gloveOut}</td><td>${allStats.gloveOut}</td></tr>
            <tr><td>灵巧手入库</td><td>${todayStats.dexIn}</td><td>${weekStats.dexIn}</td><td>${monthStats.dexIn}</td><td>${allStats.dexIn}</td></tr>
            <tr><td>灵巧手出库</td><td>${todayStats.dexOut}</td><td>${weekStats.dexOut}</td><td>${monthStats.dexOut}</td><td>${allStats.dexOut}</td></tr>
            <tr><td>Pika入库</td><td>${todayStats.gripIn}</td><td>${weekStats.gripIn}</td><td>${monthStats.gripIn}</td><td>${allStats.gripIn}</td></tr>
            <tr><td>Pika出库</td><td>${todayStats.gripOut}</td><td>${weekStats.gripOut}</td><td>${monthStats.gripOut}</td><td>${allStats.gripOut}</td></tr>
            <tr><th>总操作次数</th><th>${todayStats.total}</th><th>${weekStats.total}</th><th>${monthStats.total}</th><th>${allStats.total}</th></tr>
          </table>
        </div>
      </body></html>`;
    const w = window.open('', '_blank', 'width=900,height=700');
    w.document.write(printHtml);
    w.document.close();
    setTimeout(() => w.print(), 500);
  },

  // ==================== CHARTS ====================
  _showVersionDetail(ver) {
    const el = document.getElementById('version-detail');
    if (!el) return;
    const versions = {
      'v3.7': '<strong>v3.7 (2026-06-03)：</strong><br>· SN码页面分三区（使用中/闲置中/售后损坏）<br>· SN码删除按钮（超管专属，清理照片+流水）<br>· 维修完成支持多选批量操作<br>· 照片随SN码删除自动清理磁盘文件<br>· 修复照片上传_compressImage缺失导致上传无效<br>· 修复snCard函数this丢失导致页面空白<br>· 版本更新规则：每三次对话记为一次版本更新',
      'v3.6': '<strong>v3.6 (2026-06-03)：</strong><br>· 修复空闲库存计算公式（available = inv.quantity）<br>· 修复全部库存计数公式（库存量+使用中+损坏）<br>· 注册表更新改为无条件执行<br>· SN码页面📷按钮上传/更换照片<br>· 出库输入SN码自动显示附件缩略图<br>· 批量发货（多选+全选+快递单号选填）<br>· 仪表盘卡片拖拽排序<br>· 服务器长期运行保护<br>· 优雅关闭+自动备份<br>· 审计日志中文显示<br>· 仪表板卡片配置新增汇总卡片',
      'v3.5': '<strong>v3.5 (2026-06-02)：</strong><br>· 售后管理流程（损坏→发货→维修→回库）<br>· 机器下线逐只选择损坏/正常/调用<br>· SN码照片附件（自动压缩+OCR）<br>· 仪表盘全部/损坏/售后中汇总卡片<br>· 库存页空闲/使用中/损坏/售后明细<br>· 流水记录附件缩略图查看<br>· 售后流程流水记录追踪<br>· 图片上传自动压缩',
      'v3.0': '<strong>v3.0 (2026-05-29)：</strong><br>· SN码注册表（全生命周期追踪）<br>· 售后管理页面<br>· 机器详情SN配对<br>· 数据库性能优化（索引/缓存/WAL）<br>· 修复流水记录重复/丢失<br>· 修复清空数据保留用户配置<br>· 服务器ID一致性修复<br>· 全部库存=空闲+使用中+损坏<br>· 损坏手套不回到空闲库存',
    };
    el.innerHTML = versions[ver] || '';
  },

  _onDashDrop(e) {
    e.preventDefault();
    const draggedType = e.dataTransfer.getData('text/plain');
    const target = e.target.closest('.stat-card');
    if (!target || !draggedType) return;
    const targetType = target.getAttribute('data-card');
    if (!targetType || targetType === draggedType) return;
    const settings = Storage.getSettings();
    const cards = [...(settings.dashboardCards || [])];
    const from = cards.indexOf(draggedType);
    const to = cards.indexOf(targetType);
    if (from >= 0 && to >= 0) {
      cards.splice(from, 1);
      cards.splice(to, 0, draggedType);
      settings.dashboardCards = cards;
      Storage.saveSettings(settings);
      this.renderDashboard();
    }
  },

  _drawInventoryTrendChart() {
    const canvas = document.getElementById('chart-inventory-trend');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const transactions = Storage.getTransactions();
    const days = [];
    const now = new Date();
    for (let i = 6; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      days.push(d.toISOString().slice(0, 10));
    }

    const leftGloveData = days.map(day => {
      const txs = transactions.filter(t => t.equipmentType === 'glove' && t.handType === 'left' && t.timestamp.startsWith(day));
      return txs.reduce((sum, t) => sum + (t.direction === 'in' ? t.quantity : -t.quantity), 0);
    });
    const rightGloveData = days.map(day => {
      const txs = transactions.filter(t => t.equipmentType === 'glove' && t.handType === 'right' && t.timestamp.startsWith(day));
      return txs.reduce((sum, t) => sum + (t.direction === 'in' ? t.quantity : -t.quantity), 0);
    });

    this._drawLineChart(ctx, days.map(d => d.slice(5)), [
      { label: '左手手套', data: this._cumulativeSum(leftGloveData), color: '#4f46e5' },
      { label: '右手手套', data: this._cumulativeSum(rightGloveData), color: '#7c3aed' },
    ]);
  },

  _drawMachineStatusChart() {
    const canvas = document.getElementById('chart-machine-status');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const machines = Storage.getMachines();
    const onlineCount = Storage.getOnlineMachineCount();
    const offlineCount = [...new Set(machines.map(m => m.machineNumber))].length - onlineCount;

    this._drawPieChart(ctx, [
      { label: '在线', value: Math.max(0, onlineCount), color: '#22c55e' },
      { label: '离线', value: Math.max(0, offlineCount), color: '#ef4444' },
    ]);
  },

  _drawEquipmentStatsChart() {
    const canvas = document.getElementById('chart-equipment-stats');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const txs = this._getReportFilteredTransactions();
    const gloveIn = txs.filter(t => t.equipmentType === 'glove' && t.direction === 'in').reduce((s, t) => s + t.quantity, 0);
    const gloveOut = txs.filter(t => t.equipmentType === 'glove' && t.direction === 'out').reduce((s, t) => s + t.quantity, 0);
    const dexIn = txs.filter(t => t.equipmentType === 'dexterous_hand' && t.direction === 'in').reduce((s, t) => s + t.quantity, 0);
    const dexOut = txs.filter(t => t.equipmentType === 'dexterous_hand' && t.direction === 'out').reduce((s, t) => s + t.quantity, 0);
    const gripIn = txs.filter(t => t.equipmentType === 'gripper' && t.direction === 'in').reduce((s, t) => s + t.quantity, 0);
    const gripOut = txs.filter(t => t.equipmentType === 'gripper' && t.direction === 'out').reduce((s, t) => s + t.quantity, 0);

    this._drawBarChart(ctx,
      ['手套入库', '手套出库', '灵巧手入库', '灵巧手出库', 'Pika入库', 'Pika出库'],
      [
        { label: '数量', data: [gloveIn, gloveOut, dexIn, dexOut, gripIn, gripOut], color: '#4f46e5' },
      ]
    );
  },

  _drawDailyTrendChart() {
    const canvas = document.getElementById('chart-daily-trend');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const txs = this._getReportFilteredTransactions();
    const days = [];
    const now = new Date();
    for (let i = 29; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      days.push(d.toISOString().slice(0, 10));
    }
    const data = days.map(day => txs.filter(t => t.timestamp.startsWith(day)).length);

    this._drawLineChart(ctx, days.map(d => d.slice(5)), [
      { label: '操作次数', data, color: '#0891b2' },
    ]);
  },

  // Simple canvas chart renderers (no external library needed)
  _drawLineChart(ctx, labels, datasets) {
    const dpr = window.devicePixelRatio || 1;
    const w = ctx.canvas.offsetWidth || 500;
    const h = ctx.canvas.offsetHeight || 220;
    ctx.canvas.width = w * dpr;
    ctx.canvas.height = h * dpr;
    ctx.scale(dpr, dpr);
    const pad = { top: 20, right: 20, bottom: 30, left: 40 };
    const pw = w - pad.left - pad.right;
    const ph = h - pad.top - pad.bottom;

    ctx.clearRect(0, 0, w, h);

    const allValues = datasets.flatMap(d => d.data);
    const maxVal = Math.max(...allValues, 1);
    const minVal = Math.min(0, ...allValues);

    // Grid lines
    ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--border-color').trim() || '#e5e7eb';
    ctx.lineWidth = 0.5;
    for (let i = 0; i <= 4; i++) {
      const y = pad.top + (ph / 4) * i;
      ctx.beginPath();
      ctx.moveTo(pad.left, y);
      ctx.lineTo(w - pad.right, y);
      ctx.stroke();
      ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--text-secondary').trim() || '#6b7280';
      ctx.font = '10px sans-serif';
      ctx.fillText(Math.round(maxVal - (maxVal - minVal) / 4 * i), pad.left - 35, y + 3);
    }

    // Labels
    ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--text-secondary').trim() || '#6b7280';
    ctx.font = '9px sans-serif';
    const step = Math.max(1, Math.floor(labels.length / 8));
    labels.forEach((l, i) => {
      if (i % step === 0) {
        const x = pad.left + (pw / (labels.length - 1)) * i;
        ctx.fillText(l, x - 10, h - pad.bottom + 15);
      }
    });

    // Lines
    datasets.forEach(ds => {
      ctx.strokeStyle = ds.color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ds.data.forEach((val, i) => {
        const x = pad.left + (pw / (ds.data.length - 1)) * i;
        const y = pad.top + ph - ((val - minVal) / (maxVal - minVal || 1)) * ph;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();

      // Dots
      ds.data.forEach((val, i) => {
        const x = pad.left + (pw / (ds.data.length - 1)) * i;
        const y = pad.top + ph - ((val - minVal) / (maxVal - minVal || 1)) * ph;
        ctx.fillStyle = ds.color;
        ctx.beginPath();
        ctx.arc(x, y, 3, 0, Math.PI * 2);
        ctx.fill();
      });
    });

    // Legend
    let lx = pad.left;
    datasets.forEach(ds => {
      ctx.fillStyle = ds.color;
      ctx.fillRect(lx, 5, 10, 10);
      ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--text-primary').trim() || '#111827';
      ctx.font = '10px sans-serif';
      ctx.fillText(ds.label, lx + 14, 14);
      lx += ctx.measureText(ds.label).width + 30;
    });
  },

  _drawPieChart(ctx, slices) {
    const dpr = window.devicePixelRatio || 1;
    const w = ctx.canvas.offsetWidth || 200;
    const h = ctx.canvas.offsetHeight || 180;
    ctx.canvas.width = w * dpr;
    ctx.canvas.height = h * dpr;
    ctx.scale(dpr, dpr);
    const cx = w / 2;
    const cy = h / 2;
    const r = Math.min(cx, cy) - 15;

    ctx.clearRect(0, 0, w, h);

    const total = slices.reduce((s, sl) => s + sl.value, 0) || 1;
    let angle = -Math.PI / 2;

    slices.forEach(sl => {
      const sliceAngle = (sl.value / total) * Math.PI * 2;
      ctx.fillStyle = sl.color;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, r, angle, angle + sliceAngle);
      ctx.closePath();
      ctx.fill();
      angle += sliceAngle;
    });

    // Center hole (donut style)
    ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--bg-card').trim() || '#ffffff';
    ctx.beginPath();
    ctx.arc(cx, cy, r * 0.55, 0, Math.PI * 2);
    ctx.fill();

    // Legend
    let ly = 10;
    slices.forEach(sl => {
      ctx.fillStyle = sl.color;
      ctx.fillRect(10, ly, 8, 8);
      ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--text-primary').trim() || '#111827';
      ctx.font = '10px sans-serif';
      ctx.fillText(`${sl.label}: ${sl.value}`, 24, ly + 8);
      ly += 16;
    });
  },

  _drawBarChart(ctx, labels, datasets) {
    const dpr = window.devicePixelRatio || 1;
    const w = ctx.canvas.offsetWidth || 500;
    const h = ctx.canvas.offsetHeight || 220;
    ctx.canvas.width = w * dpr;
    ctx.canvas.height = h * dpr;
    ctx.scale(dpr, dpr);
    const pad = { top: 20, right: 20, bottom: 40, left: 40 };
    const pw = w - pad.left - pad.right;
    const ph = h - pad.top - pad.bottom;

    ctx.clearRect(0, 0, w, h);

    const allValues = datasets.flatMap(d => d.data);
    const maxVal = Math.max(...allValues, 1);

    ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--border-color').trim() || '#e5e7eb';
    ctx.lineWidth = 0.5;
    for (let i = 0; i <= 4; i++) {
      const y = pad.top + (ph / 4) * i;
      ctx.beginPath();
      ctx.moveTo(pad.left, y);
      ctx.lineTo(w - pad.right, y);
      ctx.stroke();
    }

    const barWidth = (pw / labels.length) * 0.6;
    const gap = (pw / labels.length) * 0.4;

    datasets.forEach(ds => {
      ds.data.forEach((val, i) => {
        const x = pad.left + (pw / labels.length) * i + gap / 2;
        const barH = (val / maxVal) * ph;
        const y = pad.top + ph - barH;

        const gradient = ctx.createLinearGradient(x, y, x, pad.top + ph);
        gradient.addColorStop(0, ds.color);
        gradient.addColorStop(1, ds.color + '88');
        ctx.fillStyle = gradient;
        ctx.fillRect(x, y, barWidth, barH);
        ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--text-secondary').trim() || '#6b7280';
        ctx.font = '9px sans-serif';
        ctx.fillText(val, x + barWidth / 2 - 8, y - 4);
      });
    });

    ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--text-secondary').trim() || '#6b7280';
    ctx.font = '9px sans-serif';
    labels.forEach((l, i) => {
      const x = pad.left + (pw / labels.length) * i + gap / 2;
      ctx.save();
      ctx.translate(x + barWidth / 2, h - pad.bottom + 15);
      ctx.rotate(-0.5);
      ctx.fillText(l, 0, 0);
      ctx.restore();
    });
  },

  // ==================== HELPERS ====================
  _formatTime(ts) {
    if (!ts) return '-';
    const d = new Date(ts);
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}:${String(d.getSeconds()).padStart(2,'0')}`;
  },

  _relativeTime(ts) {
    if (!ts) return '-';
    const now = Date.now();
    const then = new Date(ts).getTime();
    const diff = now - then;
    const seconds = Math.floor(diff / 1000);
    if (seconds < 60) return '刚刚';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}分钟前`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}小时前`;
    const days = Math.floor(hours / 24);
    if (days < 30) return `${days}天前`;
    return this._formatTime(ts).slice(0, 10);
  },

  _snDatalist() {
    // 从SN注册表获取，过滤已删除的（墓碑中的SN码）
    const registry = Storage.getSNRegistry();
    const deletedSns = new Set(JSON.parse(localStorage.getItem('gms_deleted_sns') || '[]'));
    const sns = registry
      .filter(r => r.snCode && !deletedSns.has(r.snCode))
      .map(r => r.snCode);
    return sns.map(s => `<option value="${s}">`).join('');
  },

  // 自定义 SN 自动补全下拉（支持任意位置匹配，替代浏览器 datalist 的前缀限制）
  _suggestionsVisible: false,
  _suggestionDropdown: null,

  _showSNAutocomplete(inputEl) {
    const q = inputEl.value.trim().toLowerCase();
    // 移除旧下拉
    this._hideSNAutocomplete();

    if (!q || q.length < 1) return;

    // 从 SN 注册表获取所有 SN 码（排除已删除）
    const registry = Storage.getSNRegistry();
    const deletedSns = new Set(JSON.parse(localStorage.getItem('gms_deleted_sns') || '[]'));
    const allSNs = registry
      .filter(r => r.snCode && !deletedSns.has(r.snCode))
      .map(r => r.snCode);

    // 子串匹配（大小写不敏感），优先显示开头匹配的
    const startsWith = [];
    const contains = [];
    allSNs.forEach(sn => {
      const lower = sn.toLowerCase();
      if (lower === q) return; // 完全相同就跳过
      if (lower.startsWith(q)) {
        startsWith.push(sn);
      } else if (lower.includes(q)) {
        contains.push(sn);
      }
    });

    const matches = [...startsWith, ...contains].slice(0, 15);

    if (matches.length === 0) return;

    // 创建下拉
    const dropdown = document.createElement('div');
    dropdown.className = 'sn-autocomplete-dropdown';
    dropdown.style.cssText = `
      position:absolute; z-index:9999; max-height:240px; overflow-y:auto;
      background:var(--bg-primary,#fff); border:1px solid var(--border-color,#e5e7eb);
      border-radius:8px; box-shadow:0 8px 24px rgba(0,0,0,0.15);
      width:${inputEl.offsetWidth}px; margin-top:2px;
      font-size:0.85rem;
    `;

    matches.forEach((sn, i) => {
      const item = document.createElement('div');
      item.className = 'sn-autocomplete-item';
      // 高亮匹配部分
      const idx = sn.toLowerCase().indexOf(q);
      const before = sn.substring(0, idx);
      const match = sn.substring(idx, idx + q.length);
      const after = sn.substring(idx + q.length);
      item.innerHTML = before + '<strong style="color:var(--color-primary,#6366f1);">' + match + '</strong>' + after;
      item.style.cssText = `
        padding:8px 12px; cursor:pointer; border-bottom:1px solid var(--border-light,#f3f4f6);
        white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
      `;
      item.dataset.sn = sn;
      item.addEventListener('mousedown', (e) => {
        e.preventDefault(); // 防止 blur 先触发
        inputEl.value = sn;
        inputEl.dispatchEvent(new Event('input', { bubbles: true }));
        this._hideSNAutocomplete();
        inputEl.focus();
      });
      // hover 效果
      item.addEventListener('mouseenter', () => {
        item.style.background = 'var(--bg-secondary,#f3f4f6)';
        dropdown.querySelectorAll('.sn-autocomplete-item').forEach(el => {
          if (el !== item) el.style.background = '';
        });
      });
      item.addEventListener('mouseleave', () => {
        item.style.background = '';
      });
      dropdown.appendChild(item);
    });

    // 定位到 input 下方
    const rect = inputEl.getBoundingClientRect();
    dropdown.style.position = 'fixed';
    dropdown.style.left = rect.left + 'px';
    dropdown.style.top = (rect.bottom + 2) + 'px';
    dropdown.style.width = rect.width + 'px';

    document.body.appendChild(dropdown);
    this._suggestionDropdown = dropdown;
    this._suggestionsVisible = true;

    // 点击其他地方关闭
    const closeHandler = (e) => {
      if (!dropdown.contains(e.target) && e.target !== inputEl) {
        this._hideSNAutocomplete();
        document.removeEventListener('click', closeHandler);
      }
    };
    setTimeout(() => document.addEventListener('click', closeHandler), 50);

    // 输入框失焦时延迟关闭（让 mousedown 先执行）
    const blurHandler = () => {
      setTimeout(() => {
        if (this._suggestionDropdown === dropdown) {
          this._hideSNAutocomplete();
        }
      }, 150);
    };
    inputEl.addEventListener('blur', blurHandler, { once: true });
    dropdown._blurHandler = blurHandler;

    // 键盘导航
    const keyHandler = (e) => {
      if (!this._suggestionsVisible) {
        inputEl.removeEventListener('keydown', keyHandler);
        return;
      }
      const items = dropdown.querySelectorAll('.sn-autocomplete-item');
      if (items.length === 0) return;
      let activeIdx = -1;
      items.forEach((el, i) => { if (el.style.background) activeIdx = i; });

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        activeIdx = (activeIdx + 1) % items.length;
        items.forEach((el, i) => {
          el.style.background = i === activeIdx ? 'var(--bg-secondary,#f3f4f6)' : '';
        });
        items[activeIdx].scrollIntoView({ block: 'nearest' });
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        activeIdx = activeIdx <= 0 ? items.length - 1 : activeIdx - 1;
        items.forEach((el, i) => {
          el.style.background = i === activeIdx ? 'var(--bg-secondary,#f3f4f6)' : '';
        });
        items[activeIdx].scrollIntoView({ block: 'nearest' });
      } else if (e.key === 'Enter') {
        if (activeIdx >= 0) {
          e.preventDefault();
          inputEl.value = items[activeIdx].dataset.sn;
          inputEl.dispatchEvent(new Event('input', { bubbles: true }));
          this._hideSNAutocomplete();
        }
      } else if (e.key === 'Escape') {
        this._hideSNAutocomplete();
      }
    };
    inputEl.addEventListener('keydown', keyHandler);
    dropdown._keyHandler = keyHandler;
  },

  _hideSNAutocomplete() {
    if (this._suggestionDropdown) {
      if (this._suggestionDropdown._keyHandler) {
        // 清理键盘监听（通过比较引用）
      }
      this._suggestionDropdown.remove();
      this._suggestionDropdown = null;
    }
    this._suggestionsVisible = false;
  },

  _readAttachment(fileEl) {
    return new Promise((resolve) => {
      const file = fileEl.files[0];
      if (!file) { resolve(null); return; }
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(file);
    });
  },

  async _uploadAttachment(fileEl) {
    const file = fileEl.files[0];
    if (!file) return null;
    // Try server upload first
    if (API.online) {
      try {
        const dataUrl = await this._readAttachment(fileEl);
        if (!dataUrl) return null;
        const headers = { 'Content-Type': 'application/json' };
        if (API.token) headers['Authorization'] = 'Bearer ' + API.token;
        const res = await API._fetchWithTimeout(API.baseURL + '/api/upload', {
          method: 'POST',
          headers,
          body: JSON.stringify({ filename: file.name, data: dataUrl }),
        }, 15000);
        const result = await res.json();
        if (res.ok && result.path) return result.path;
      } catch (e) { /* fallback to base64 */ }
    }
    // Offline fallback: store base64 data URL
    return await this._readAttachment(fileEl);
  },

  _ocrWorker: null,

  async _getOCRWorker() {
    if (this._ocrWorker) return this._ocrWorker;
    this._ocrWorker = await Tesseract.createWorker('eng');
    return this._ocrWorker;
  },

  async _onAttachmentChange(fileInput, snInputId) {
    const file = fileInput.files[0];
    if (!file) return;
    // Only OCR if SN field is empty
    const snInput = document.getElementById(snInputId);
    if (!snInput || snInput.value.trim()) return;

    // Only OCR image files
    if (!file.type.startsWith('image/')) return;

    try {
      snInput.placeholder = '正在识别SN码...';
      snInput.style.color = '#9ca3af';
      const worker = await this._getOCRWorker();
      const imgUrl = URL.createObjectURL(file);
      const { data } = await worker.recognize(imgUrl);
      URL.revokeObjectURL(imgUrl);
      const text = data.text || '';
      // Look for SN code patterns: alphanumeric with optional hyphens
      // Examples: SN-001, GL-2024-001, L-001, SN001, glove-01, GH-1234
      const patterns = [
        /[A-Za-z]{2,4}[-–]\d{2,}[A-Za-z\d]*/g,   // XX-001, XXX-001X
        /[A-Za-z]\d{3,}[A-Za-z]?/g,                 // L001, R001X
        /\bSN[-\s]?\d{2,}[A-Za-z]?\b/gi,            // SN001, SN-001
        /\b[A-Z]{1,2}\d{3,6}\b/g,                   // GH1234, A123456
        /\b[A-Za-z]+[-\s]\d{3,}[A-Za-z]?\b/g,       // glove-001, hand 002
      ];
      let detected = null;
      for (const pattern of patterns) {
        const matches = text.match(pattern);
        if (matches && matches.length > 0) {
          // Pick the most SN-like match (longer, more structured)
          const sorted = matches.sort((a, b) => b.length - a.length);
          detected = sorted[0].replace(/\s/g, '-').toUpperCase();
          break;
        }
      }
      if (detected) {
        snInput.value = detected;
        snInput.style.color = '';
        snInput.style.borderColor = '#10b981';
        setTimeout(() => { snInput.style.borderColor = ''; }, 3000);
        this.notify(`已从图片识别SN码: ${detected}`, 'success');
      }
    } catch (e) {
      // OCR failed, silently ignore
    } finally {
      snInput.placeholder = snInput.value ? snInput.placeholder : '输入SN码';
      if (!snInput.value) snInput.style.color = '';
    }
  },

  _attachmentThumb(attachment) {
    if (!attachment) return '<span class="text-muted">-</span>';
    const src = attachment.startsWith('/uploads/') ? attachment : attachment;
    if (src.startsWith('data:image/') || src.startsWith('/uploads/')) {
      return `<a href="${src}" target="_blank" title="点击查看大图"><img src="${src}" style="width:40px;height:40px;object-fit:cover;border-radius:4px;cursor:pointer;"></a>`;
    }
    if (src.startsWith('data:application/pdf')) {
      return '<a href="'+src+'" target="_blank" title="PDF附件">📄</a>';
    }
    return '<a href="'+src+'" target="_blank" title="附件">📎</a>';
  },

  _currentUser() {
    return (API.currentUser && API.currentUser.username) || '';
  },

  _getHandType(invType) {
    if (invType === 'left_glove' || invType === 'left_dexterous_hand') return 'left';
    if (invType === 'right_glove' || invType === 'right_dexterous_hand') return 'right';
    if (invType.endsWith('_left')) return 'left';
    if (invType.endsWith('_right')) return 'right';
    return null;
  },

  _getEquipmentType(invType) {
    if (invType === 'left_glove' || invType === 'right_glove') return 'glove';
    if (invType === 'left_dexterous_hand' || invType === 'right_dexterous_hand') return 'dexterous_hand';
    return invType;
  },

  _isGloveType(invType) {
    return invType === 'left_glove' || invType === 'right_glove'
      || invType === 'left_dexterous_hand' || invType === 'right_dexterous_hand'
      || invType.endsWith('_left') || invType.endsWith('_right');
  },

  // Map equipmentType + handType to inventory type key
  _snToInvType(equipmentType, handType) {
    if (equipmentType === 'glove') return handType === 'left' ? 'left_glove' : 'right_glove';
    if (equipmentType === 'dexterous_hand') return handType === 'left' ? 'left_dexterous_hand' : 'right_dexterous_hand';
    if (handType) return equipmentType + '_' + handType;
    return equipmentType || 'left_glove';
  },

  _isPrivileged() {
    return API.currentUser && (API.currentUser.role === 'admin' || API.currentUser.role === 'superadmin');
  },

  _equipmentLabel(type, handType) {
    if (type === 'glove') return handType === 'left' ? '左手手套' : '右手手套';
    if (type === 'dexterous_hand') return handType === 'left' ? '左手灵巧手' : (handType === 'right' ? '右手灵巧手' : '灵巧手');
    if (type === 'gripper') return '夹爪(Pika)';
    return type;
  },

  _cumulativeSum(arr) {
    let sum = 0;
    return arr.map(v => sum += v);
  },

  refreshCurrentTab() {
    // Direct render call — NO innerHTML clear first (avoids flicker)
    // Each render function manages its own content.innerHTML
    const tab = this.currentTab;
    const invConfig = Storage.getInventoryConfig();

    switch (tab) {
      case 'dashboard': this.renderDashboard(); break;
      case 'glove': this.renderGloveInventory(); break;
      case 'dexterous': this.renderDexterousHand(); break;
      case 'gripper': this.renderGripper(); break;
      case 'machines': this.renderMachines(); break;
      case 'transactions': this.renderTransactions(); break;
      case 'reports': this.renderReports(); break;
      case 'settings': this.renderSettings(); break;
      case 'audit': this.renderAuditLog(); break;
      case 'users': this.renderUserManagement(); break;
      case 'equipment-config': this.renderEquipmentConfig(); break;
      case 'sn-codes': this.renderSNCodes(); break;
      case 'after-sales': this.renderAfterSales(); break;
      case 'inventory-config': this.renderInventoryConfig(); break;
      case 'tech-support':
        if (this._tsDetailId) {
          this.renderTechSupportDetail(this._tsDetailId);
        } else {
          this.renderTechSupport();
        }
        break;
      default:
        const matched = invConfig.find(c => tab === c.id || tab === c.id + '_left' || tab === c.id + '_right');
        if (matched) {
          this.renderDynamicInventory(tab, matched);
        } else {
          this.renderDashboard();
        }
        break;
    }
  },

  globalSearch(query) {
    // Clear old filters and set search
    this.filters = { equipmentType: 'all', direction: 'all', dateFrom: '', dateTo: '', search: query, sortColumn: '', sortDirection: 'asc' };
    this.switchTab('transactions');
    // Restore search input value after tab switch
    setTimeout(() => {
      const el = document.getElementById('filter-search');
      if (el) el.value = query;
    }, 100);
  },

  startAutoRefresh() {
    // 15秒无感刷新：只刷新当前视图数据，不重新渲染整个页面
    if (this._autoRefreshId) clearInterval(this._autoRefreshId);
    this._autoRefreshId = setInterval(() => {
      if (!API.online) return;
      // 跳过正在输入的
      const activeEl = document.activeElement;
      if (activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA' || activeEl.tagName === 'SELECT')) return;
      // 跳过弹窗打开时
      const modal = document.getElementById('modal-overlay');
      if (modal && modal.style.display !== 'none' && !modal.classList.contains('hidden')) return;
      this.refreshCurrentView();
    }, 15000);
  },

  // 无感刷新当前视图 — 仅更新数据，不闪屏不打断操作
  // 报表/审计/售后等含图表的页面跳过定时刷新，避免图表重绘闪烁
  refreshCurrentView() {
    const tab = this.currentTab;
    // 仅刷新数据频繁变化的视图
    if (tab === 'dashboard') {
      this.renderDashboard();
    } else if (tab === 'transactions') {
      this.renderTransactions(this.currentPage.transactions);
    } else if (tab === 'machines') {
      this.renderMachines();
    } else if (tab === 'tech-support') {
      // 技术支持页面：如果正在查看详情，则刷新详情；否则刷新列表
      if (this._tsDetailId) {
        this.renderTechSupportDetail(this._tsDetailId);
      } else {
        this.renderTechSupport(this._tsViewMode);
      }
    }
    // reports/audit/after-sales — 含图表，跳过定时刷新，用户可手动点刷新按钮
  },

  bindKeyboardShortcuts() {
    document.addEventListener('keydown', (e) => {
      // '?' key shows keyboard shortcuts help
      if (e.key === '?' && !e.ctrlKey && !e.metaKey && !e.altKey
        && document.activeElement && document.activeElement.tagName !== 'INPUT'
        && document.activeElement.tagName !== 'TEXTAREA'
        && document.activeElement.tagName !== 'SELECT') {
        e.preventDefault();
        this.showKeyboardHelp();
        return;
      }
      if (e.ctrlKey || e.metaKey) {
        switch (e.key) {
          case '1': e.preventDefault(); this.switchTab('dashboard'); break;
          case '2': e.preventDefault(); this.switchTab('glove'); break;
          case '3': e.preventDefault(); this.switchTab('dexterous'); break;
          case '4': e.preventDefault(); this.switchTab('gripper'); break;
          case '5': e.preventDefault(); this.switchTab('machines'); break;
          case '6': e.preventDefault(); this.switchTab('transactions'); break;
          case '7': e.preventDefault(); this.switchTab('reports'); break;
          case 's': e.preventDefault(); document.getElementById('search-global')?.focus(); break;
          case 'e': e.preventDefault(); this.exportCSV(); break;
        }
      }
    });
  },

  showKeyboardHelp() {
    const shortcuts = [
      ['Ctrl+1', '系统总览'], ['Ctrl+2', '手套库存'], ['Ctrl+3', '灵巧手'],
      ['Ctrl+4', '夹爪'], ['Ctrl+5', '机器管理'], ['Ctrl+6', '流水记录'],
      ['Ctrl+7', '报表统计'], ['Ctrl+S', '全局搜索'], ['Ctrl+E', '导出CSV'],
      ['?', '显示此帮助'],
    ];
    const html = `
      <div class="keyboard-help">
        <p>按 <kbd>?</kbd> 可随时打开此帮助</p>
        <table>${shortcuts.map(s => `<tr><td><kbd>${s[0]}</kbd></td><td>${s[1]}</td></tr>`).join('')}</table>
      </div>
    `;
    this._showInfoModal('键盘快捷键', html);
  },
};

// Initialize on DOM ready
document.addEventListener('DOMContentLoaded', () => App.init());
