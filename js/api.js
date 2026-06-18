/**
 * API Client Layer
 * Communicates with the backend server when available, falls back to localStorage.
 * Provides the same interface as the original Storage object.
 */
const API = {
  baseURL: '',
  token: null,
  currentUser: null,
  online: false,
  eventSource: null,
  _refreshTimer: null,

  async init() {
    this.token = localStorage.getItem('gms_token') || sessionStorage.getItem('gms_token');
    this.currentUser = JSON.parse(localStorage.getItem('gms_user') || sessionStorage.getItem('gms_user') || 'null');
    this.baseURL = window.__GMS_SERVER_URL__ || window.location.origin;

    // Fast switch: system switcher set this flag — skip health check, assume online
    const fastSwitch = localStorage.getItem('gms_fast_switch');
    if (fastSwitch && this.token) {
      localStorage.removeItem('gms_fast_switch');
      this.online = true;
    } else {
      this.online = await this._checkServer();
    }

    // Auto-restore from login history (same device, within 10 min)
    if (!this.currentUser) {
      const hist = this._getLoginHistory();
      if (hist) {
        this.currentUser = { username: hist.username, role: hist.role, system: hist.system };
        localStorage.setItem('gms_user', JSON.stringify(this.currentUser));
        // Try to restore token from localStorage
        const savedToken = localStorage.getItem('gms_login_token');
        if (savedToken) {
          this.token = savedToken;
          localStorage.setItem('gms_token', savedToken);
        }
      }
    }

    if (this.online && this.token) {
      const valid = await this._validateToken();
      if (!valid) {
        // Token expired (server restarted) — force full re-login
        this.logout();
        return true; // Still online, just need fresh login
      }
      this._listenSSE();
      this._setupBeforeUnload();
    }
    return this.online;
  },

  async _checkServer() {
    // Retry up to 2 times for LAN reliability
    for (let i = 0; i < 2; i++) {
      try {
        const res = await this._fetchWithTimeout(this.baseURL + '/api/health', {}, 5000);
        if (res.ok) return true;
      } catch {}
      if (i < 1) await new Promise(r => setTimeout(r, 1000));
    }
    return false;
  },

  async _validateToken() {
    try {
      const res = await this._fetchWithTimeout(this.baseURL + '/api/settings', {
        headers: { 'Authorization': 'Bearer ' + this.token }
      }, 3000);
      return res.ok;
    } catch { return false; }
  },

  async login(username, password) {
    // Try server first
    if (this.online) {
      try {
        const res = await this._fetchWithTimeout(this.baseURL + '/api/auth/login', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username, password })
        }, 5000);
        const data = await res.json();
        if (res.ok) {
          this.token = data.token;
          this.currentUser = data.user;
          localStorage.setItem('gms_token', data.token);
          localStorage.setItem('gms_user', JSON.stringify(data.user));
          this._saveLoginHistory(data.user);
          this._listenSSE();
          this._setupBeforeUnload();
          // 记住登录态（Cookie 7天有效）
          this._setCookie('gms_logged', '1', 7);
          // 🔴 微信级实时: 启动 WebSocket 双向通信
          if (typeof Realtime !== 'undefined') {
            Realtime.init(data.token);
            Realtime.requestNotificationPermission();
          }
          return { success: true, user: data.user };
        }
        return { success: false, message: data.error };
      } catch (e) {
        // Server unreachable, fall through to offline
      }
    }

    // Offline login: check against localStorage users
    const users = Storage.getUsers();
    const user = users.find(u => u.username === username);
    if (!user) return { success: false, message: '用户名或密码错误' };

    const hash = await this._hashPassword(password);
    if (hash !== user.passwordHash) return { success: false, message: '用户名或密码错误' };

    this.currentUser = { username: user.username, role: user.role, system: user.system || 'maintenance' };
    this.online = false;
    localStorage.setItem('gms_user', JSON.stringify(this.currentUser));
    localStorage.removeItem('gms_token'); sessionStorage.removeItem('gms_token');
    this._saveLoginHistory(this.currentUser);
    return { success: true, user: this.currentUser };
  },

  async _hashPassword(password) {
    const encoder = new TextEncoder();
    const data = encoder.encode(password + 'gms-salt');
    const hash = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
  },

  logout() {
    this.token = null;
    this.currentUser = null;
    this.online = false;
    localStorage.removeItem('gms_token'); sessionStorage.removeItem('gms_token');
    localStorage.removeItem('gms_user'); sessionStorage.removeItem('gms_user');
    localStorage.removeItem('gms_login_history');
    localStorage.removeItem('gms_login_token');
    if (this.eventSource) { this.eventSource.close(); this.eventSource = null; }
    // Clear all periodic timers
    if (this._autoRefreshInterval) { clearInterval(this._autoRefreshInterval); this._autoRefreshInterval = null; }
    if (this._heartbeatInterval) { clearInterval(this._heartbeatInterval); this._heartbeatInterval = null; }
    if (this._pollingInterval) { clearInterval(this._pollingInterval); this._pollingInterval = null; }
  },

  _setupBeforeUnload() {
    // No beacon on unload — token expires naturally after 3 min inactivity.
    // Previously caused redirect-loop because navigating index→operations
    // would delete the token before operations could validate it.
  },

  _getDeviceId() {
    let id = localStorage.getItem('gms_device_id');
    if (!id) { id = 'dev-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); localStorage.setItem('gms_device_id', id); }
    return id;
  },

  _saveLoginHistory(user) {
    const history = { username: user.username, role: user.role, system: user.system || 'maintenance', deviceId: this._getDeviceId(), loginAt: Date.now() };
    localStorage.setItem('gms_login_history', JSON.stringify(history));
    if (this.token) localStorage.setItem('gms_login_token', this.token);
  },

  _getLoginHistory() {
    try {
      const data = JSON.parse(localStorage.getItem('gms_login_history'));
      if (!data) return null;
      const elapsed = Date.now() - data.loginAt;
      if (elapsed > 24 * 60 * 60 * 1000) { localStorage.removeItem('gms_login_history'); return null; }
      if (data.deviceId !== this._getDeviceId()) { localStorage.removeItem('gms_login_history'); return null; }
      return data;
    } catch { return null; }
  },

  _listenSSE() {
    if (this.eventSource) { this.eventSource.close(); this.eventSource = null; }
    if (this._pollingInterval) { clearInterval(this._pollingInterval); this._pollingInterval = null; }
    // Start periodic auto-refresh safety net (every 30s)
    this._startAutoRefresh();
    // Start token heartbeat (every 10min to keep session alive)
    this._startTokenHeartbeat();

    this._sseFailures = 0;
    this._sseLastFail = 0;

    try {
      this.eventSource = new EventSource(this.baseURL + '/api/events');
      // Helper: sync data silently, then do targeted UI patch (no innerHTML clear)
      // Uses separate timers per event type to avoid race conditions
      const silentSync = () => {
        if (this._syncTimer) clearTimeout(this._syncTimer);
        const restoring = (typeof App !== 'undefined' && App._restoring)
                       || (typeof OpsApp !== 'undefined' && OpsApp._restoring);
        this._syncTimer = setTimeout(async () => {
          if (API.online && !restoring) {
            await Storage._syncFromServer();
            this._notifyUIUpdate();
          }
        }, 3000);
      };
      const silentSyncCfg = () => {
        if (this._syncCfgTimer) clearTimeout(this._syncCfgTimer);
        this._syncCfgTimer = setTimeout(async () => {
          if (API.online) {
            await Storage._syncFromServer();
            if (typeof App !== 'undefined' && App.refreshSidebarInventory) App.refreshSidebarInventory();
            this._notifyUIUpdate();
          }
        }, 500);
      };
      this.eventSource.addEventListener('inventory_updated', silentSync);
      this.eventSource.addEventListener('machines_updated', silentSync);
      this.eventSource.addEventListener('transactions_updated', silentSync);
      this.eventSource.addEventListener('settings_updated', silentSync);
      this.eventSource.addEventListener('equipment_config_updated', silentSyncCfg);
      this.eventSource.addEventListener('inventory_config_updated', silentSyncCfg);
      this.eventSource.addEventListener('users_updated', silentSync);
      this.eventSource.addEventListener('sn_registry_updated', silentSync);
      this.eventSource.addEventListener('audit_log_updated', silentSync);
      this.eventSource.addEventListener('ops_orders_updated', silentSync);
      this.eventSource.addEventListener('ops_customers_updated', silentSync);
      this.eventSource.addEventListener('ops_production_updated', silentSync);
      this.eventSource.addEventListener('tech_support_updated', silentSync);
      this.eventSource.addEventListener('group_transfer_updated', silentSync);
      this.eventSource.onopen = () => {
        // SSE connected — reset failure counter
        this._sseFailures = 0;
        this._sseLastFail = 0;
      };
      this.eventSource.onerror = () => {
        const now = Date.now();
        if (now - this._sseLastFail < 60000) {
          this._sseFailures++;
        } else {
          this._sseFailures = 1;
        }
        this._sseLastFail = now;
        // If SSE fails 3+ times within 60s, fall back to polling
        if (this._sseFailures >= 3) {
          this._startPolling();
        }
      };
    } catch (e) {
      // SSE not supported, fall back to polling immediately
      this._startPolling();
    }
  },

  // Polling fallback when SSE is unavailable (e.g. behind CloudBase gateway)
  _startPolling() {
    if (this.eventSource) { this.eventSource.close(); this.eventSource = null; }
    if (this._pollingInterval) return; // already polling
    console.log('[API] SSE unavailable, falling back to polling every 5s');
    this._pollingInterval = setInterval(async () => {
      if (!this.online || !this.token) return;
      try {
        const res = await this._fetchWithTimeout(this.baseURL + '/api/sync', {
          headers: this._headers()
        }, 8000);
        if (res.ok) {
          const data = await res.json();
          if (typeof Storage !== 'undefined' && Storage._applySync) {
            Storage._applySync(data);
          }
          this._notifyUIUpdate();
        }
      } catch {}
      // Retry SSE every ~5 minutes
      if (this._sseAttempts === undefined) this._sseAttempts = 0;
      this._sseAttempts++;
      if (this._sseAttempts >= 60) {
        this._sseAttempts = 0;
        if (this._pollingInterval) { clearInterval(this._pollingInterval); this._pollingInterval = null; }
        this._listenSSE();
      }
    }, 5000);
  },

  // ==================== AUTO-REFRESH SAFETY NET ====================
  // Periodic data sync every 30s — ensures data freshness even if SSE events are missed
  _startAutoRefresh() {
    if (this._autoRefreshInterval) clearInterval(this._autoRefreshInterval);
    this._autoRefreshInterval = setInterval(async () => {
      if (!this.online || !this.token) return;
      // Skip if user is actively typing
      const activeEl = document.activeElement;
      if (activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA' || activeEl.tagName === 'SELECT')) return;
      try {
        await Storage._syncFromServer();
        this._notifyUIUpdate();
      } catch {}
    }, 30000); // 30 seconds
  },

  // ==================== TOKEN HEARTBEAT ====================
  // Lightweight API call every 10 minutes to keep the token's sliding window alive
  _startTokenHeartbeat() {
    if (this._heartbeatInterval) clearInterval(this._heartbeatInterval);
    this._heartbeatInterval = setInterval(async () => {
      if (!this.online || !this.token) return;
      try {
        const res = await this._fetchWithTimeout(this.baseURL + '/api/health', {
          headers: this._headers()
        }, 5000);
        if (!res.ok) {
          // Token may have expired — force re-login
          console.warn('[API] Token heartbeat failed, session may have expired');
        }
      } catch {}
    }, 10 * 60 * 1000); // 10 minutes
  },

  // Targeted UI update after SSE data sync — renders directly without innerHTML clear, no flicker
  _notifyUIUpdate() {
    // Skip if user is typing or modal is open
    const activeEl = document.activeElement;
    if (activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA' || activeEl.tagName === 'SELECT')) return;
    const modal = document.getElementById('modal-overlay');
    if (modal && modal.style.display === 'flex') return;

    // Always refresh sidebar inventory dropdown (lightweight, no visible flicker)
    if (typeof App !== 'undefined' && App.refreshSidebarInventory) App.refreshSidebarInventory();
    if (typeof OpsApp !== 'undefined' && OpsApp.refreshSidebarInventory) OpsApp.refreshSidebarInventory();

    // Only auto-render lightweight tabs — skip heavy data pages (transactions, machines, etc.)
    // that the user can manually refresh. This avoids scroll loss and CPU waste.
    const lightTabs = ['dashboard', 'glove', 'dexterous', 'gripper', 'reports', 'after-sales'];

    if (typeof App !== 'undefined' && App.refreshCurrentTab && App.currentTab) {
      if (lightTabs.includes(App.currentTab) || App.currentTab.indexOf('_') > -1) {
        App.refreshCurrentTab();
      }
    }
    // OpsApp: NEVER auto-render from SSE to avoid disrupting user input.
    // Data is synced to localStorage silently. Users see updates on manual refresh or tab switch.
  },

  _headers() {
    return this.token ? { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + this.token } : { 'Content-Type': 'application/json' };
  },

  _setCookie(name, value, days) {
    const d = new Date();
    d.setTime(d.getTime() + (days * 24 * 60 * 60 * 1000));
    document.cookie = name + '=' + encodeURIComponent(value) + ';expires=' + d.toUTCString() + ';path=/;SameSite=Lax';
  },

  _getCookie(name) {
    const match = document.cookie.match(new RegExp('(^| )' + name + '=([^;]+)'));
    return match ? decodeURIComponent(match[2]) : null;
  },

  _fetchWithTimeout(url, options, timeoutMs = 5000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(timer));
  },

  async _fetch(method, path, body) {
    if (!this.online) return null;
    try {
      const opts = { method, headers: this._headers() };
      if (body) opts.body = JSON.stringify(body);
      const res = await this._fetchWithTimeout(this.baseURL + path, opts);
      return await res.json();
    } catch { return null; }
  },

  // Inventory
  async getAllInventory() {
    if (!this.online) return [];
    const data = await this._fetch('GET', '/api/inventory');
    return Array.isArray(data) ? data : [];
  },

  async getInventory(type) {
    if (!this.online) return Storage._local.getInventory(type);
    const data = await this._fetch('GET', '/api/inventory/' + type);
    return data && !data.error ? { quantity: data.quantity, updatedAt: data.updatedAt, updatedBy: data.updatedBy } : Storage._local.getInventory(type);
  },

  async adjustInventory(type, delta, updatedBy, snCode) {
    if (!this.online) return Storage._local.adjustInventory(type, delta, updatedBy, snCode);
    const data = await this._fetch('POST', '/api/inventory/' + type, { delta, snCode, updatedBy });
    return data && data.success ? data : { success: false, message: data?.error || '请求失败' };
  },

  // Machines
  async getMachines() {
    if (!this.online) return Storage._local.getMachines();
    const data = await this._fetch('GET', '/api/machines');
    return Array.isArray(data) ? data : Storage._local.getMachines();
  },

  async addMachine(machine) {
    if (!this.online) return Storage._local.addMachine(machine);
    const data = await this._fetch('POST', '/api/machines', machine);
    return data?.success ? (this.getMachines ? await this.getMachines() : []) : Storage._local.addMachine(machine);
  },

  async deleteMachine(id) {
    if (!this.online) return Storage._local.deleteMachine(id);
    await this._fetch('DELETE', '/api/machines/' + id);
  },

  // Transactions
  async getTransactions(limit = 2000) {
    if (!this.online) return Storage._local.getTransactions();
    const data = await this._fetch('GET', '/api/transactions?limit=' + limit);
    return Array.isArray(data) ? data : Storage._local.getTransactions();
  },

  async addTransaction(tx) {
    if (!this.online) return Storage._local.addTransaction(tx);
    await this._fetch('POST', '/api/transactions', tx);
  },

  async deleteTransaction(id) {
    if (!this.online) return Storage._local.deleteTransaction(id);
    await this._fetch('DELETE', '/api/transactions/' + id);
  },

  // Audit Log
  async getAuditLog() {
    if (!this.online) return Storage._local.getAuditLog();
    const data = await this._fetch('GET', '/api/audit-log');
    return Array.isArray(data) ? data : Storage._local.getAuditLog();
  },

  // Settings
  async getSettings() {
    if (!this.online) return Storage._local.getSettings();
    const data = await this._fetch('GET', '/api/settings');
    return data && !data.error ? data : Storage._local.getSettings();
  },

  async saveSettings(settings) {
    if (!this.online) return Storage._local.saveSettings(settings);
    await this._fetch('POST', '/api/settings', settings);
  },

  // Equipment Config
  async getEquipmentConfig() {
    if (!this.online) return null;
    const data = await this._fetch('GET', '/api/equipment-config');
    return Array.isArray(data) ? data : null;
  },
  async saveEquipmentConfig(config) {
    if (!this.online) return;
    await this._fetch('POST', '/api/equipment-config', config);
  },
  async deleteEquipmentConfig(id) {
    if (!this.online) return;
    await this._fetch('DELETE', '/api/equipment-config/' + id);
  },

  // Inventory Config
  async getInventoryConfig() {
    if (!this.online) return null;
    const data = await this._fetch('GET', '/api/inventory-config');
    return Array.isArray(data) ? data : null;
  },
  async saveInventoryConfig(config) {
    if (!this.online) return;
    await this._fetch('POST', '/api/inventory-config', config);
  },
  async deleteInventoryConfig(id) {
    if (!this.online) return;
    await this._fetch('DELETE', '/api/inventory-config/' + id);
  },

  // Clear all data
  async clearAllData() {
    if (!this.online) return false;
    const data = await this._fetch('POST', '/api/clear-all-data');
    return data && data.success;
  },

  // SN Registry
  async getSNRegistry() {
    if (!this.online && Storage.getSNRegistry) return Storage.getSNRegistry();
    const data = await this._fetch('GET', '/api/sn-registry');
    return Array.isArray(data) ? data : [];
  },
  async upsertSNRegistry(entry) {
    if (!this.online && Storage.upsertSNRegistry) return Storage.upsertSNRegistry(entry);
    return await this._fetch('POST', '/api/sn-registry', entry);
  },
  async shipSN(snCode, trackingNumber) {
    if (!this.online) return null;
    return await this._fetch('POST', '/api/sn-registry/ship', { snCode, trackingNumber });
  },
  async repairCompleteSN(snCode) {
    if (!this.online) return null;
    return await this._fetch('POST', '/api/sn-registry/repair-complete', { snCode });
  },
  async deleteSNFull(snCode) {
    if (!this.online) return { success: false, message: 'offline' };
    return await this._fetch('POST', '/api/sn-registry/delete-full', { snCode });
  },
  async deleteUpload(filePath) {
    if (!this.online) return null;
    return await this._fetch('POST', '/api/delete-upload', { filePath });
  },

  // Data integrity
  async getDataIntegrity() {
    if (!this.online) return { issues: [], count: 0 };
    const data = await this._fetch('GET', '/api/data-integrity');
    return data || { issues: [], count: 0 };
  },

  // Tech Support
  async getTechSupportList() {
    if (!this.online) return [];
    const data = await this._fetch('GET', '/api/tech-support');
    return Array.isArray(data) ? data : [];
  },

  async getTechSupportDetail(id) {
    if (!this.online) return null;
    const data = await this._fetch('GET', '/api/tech-support/' + id);
    return data && !data.error ? data : null;
  },

  async submitTechSupport(payload) {
    if (!this.online) return { success: false, message: '离线模式不支持提交' };
    const data = await this._fetch('POST', '/api/tech-support', payload);
    return data || { success: false, message: '请求失败' };
  },

  async respondTechSupport(id) {
    if (!this.online) return { success: false, message: '离线模式不支持响应' };
    const data = await this._fetch('POST', '/api/tech-support/' + id + '/respond');
    return data || { success: false, message: '请求失败' };
  },

  async completeTechSupport(id, result) {
    if (!this.online) return { success: false, message: '离线模式不支持完成' };
    const data = await this._fetch('POST', '/api/tech-support/' + id + '/complete', { result });
    return data || { success: false, message: '请求失败' };
  },

  async deleteTechSupport(id) {
    if (!this.online) return { success: false, message: '离线模式不支持删除' };
    const data = await this._fetch('DELETE', '/api/tech-support/' + id);
    return data || { success: false, message: '请求失败' };
  },

  // Group Transfer
  async getGroupTransfers() {
    if (!this.online) return [];
    const data = await this._fetch('GET', '/api/group/transfers');
    return Array.isArray(data) ? data : [];
  },
  async getGroupMembers() {
    if (!this.online) return [];
    const data = await this._fetch('GET', '/api/group/members');
    return Array.isArray(data) ? data : [];
  },
  async createGroupTransfer(payload) {
    if (!this.online) return { success: false, message: '离线模式不支持' };
    const data = await this._fetch('POST', '/api/group/transfer', payload);
    return data || { success: false, message: '请求失败' };
  },
  async approveGroupTransfer(id) {
    if (!this.online) return { success: false, message: '离线模式不支持' };
    const data = await this._fetch('POST', '/api/group/transfer/' + id + '/approve');
    return data || { success: false, message: '请求失败' };
  },
  async rejectGroupTransfer(id) {
    if (!this.online) return { success: false, message: '离线模式不支持' };
    const data = await this._fetch('POST', '/api/group/transfer/' + id + '/reject');
    return data || { success: false, message: '请求失败' };
  },
  async cancelGroupTransfer(id) {
    if (!this.online) return { success: false, message: '离线模式不支持' };
    const data = await this._fetch('POST', '/api/group/transfer/' + id + '/cancel');
    return data || { success: false, message: '请求失败' };
  },

  async getSubordinates() {
    if (!this.online) return [];
    const data = await this._fetch('GET', '/api/users/subordinates');
    return Array.isArray(data) ? data : [];
  },

  async addUser(userData) {
    if (!this.online) return { success: false, message: '离线模式不支持添加用户' };
    const data = await this._fetch('POST', '/api/users', userData);
    return data || { success: false, message: '请求失败' };
  },

  async deleteUser(userId) {
    if (!this.online) return { success: false, message: '离线模式不支持删除用户' };
    const data = await this._fetch('DELETE', '/api/users/' + userId);
    return data || { success: false, message: '请求失败' };
  },

  async promoteUser(userId) {
    if (!this.online) return { success: false, message: '离线模式不支持操作' };
    const data = await this._fetch('POST', '/api/users/' + userId + '/promote');
    return data || { success: false, message: '请求失败' };
  },

  async resetPassword(userId, newPassword) {
    if (!this.online) return { success: false, message: '离线模式不支持重置密码' };
    const data = await this._fetch('POST', '/api/users/' + userId + '/reset-password', { newPassword });
    return data || { success: false, message: '请求失败' };
  },

  async getUsers() {
    if (!this.online) return [];
    const data = await this._fetch('GET', '/api/users');
    return Array.isArray(data) ? data : [];
  },

  // Popup Messages
  async getPopupMessages(category) {
    if (!this.online) return [];
    const url = '/api/popup-messages' + (category ? '?category=' + category : '');
    const data = await this._fetch('GET', url);
    return Array.isArray(data) ? data : [];
  },
  // ====== 手套调出/调回 ======
  async transferGloves(payload) {
    return this._fetch('/api/transfers', 'POST', payload);
  },
  async recallGloves(payload) {
    return this._fetch('/api/transfers/recall', 'POST', payload);
  },
  async getTransfers() {
    return this._fetch('/api/transfers');
  },
  async getTransferStats() {
    return this._fetch('/api/transfers/stats');
  },

  async getRandomPopupMessage(category) {
    if (!this.online) return { text: '操作成功！' };
    const data = await this._fetch('GET', '/api/popup-messages/random?category=' + (category || 'submit'));
    return data || { text: '操作成功！' };
  },
  async addPopupMessage(category, text) {
    if (!this.online) return { success: false, message: '离线模式不支持' };
    const data = await this._fetch('POST', '/api/popup-messages', { category, text });
    return data || { success: false, message: '请求失败' };
  },
  async deletePopupMessage(id) {
    if (!this.online) return { success: false, message: '离线模式不支持' };
    const data = await this._fetch('DELETE', '/api/popup-messages/' + id);
    return data || { success: false, message: '请求失败' };
  },
};
