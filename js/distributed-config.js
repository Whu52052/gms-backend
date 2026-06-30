/**
 * ===================================================================
 *  分布式高可用配置模块
 *  
 *  功能:
 *    - 多服务器故障切换（主服务器挂了自动切次服务器）
 *    - 健康检查 + 自动恢复
 *    - 读写分离支持（写走主库，读走从库）
 *    - 本地缓存降级（所有服务器都挂了时用 localStorage）
 * ===================================================================
 */

const DistributedConfig = {
  // ========== 服务器列表 ==========
  // 主服务器 + 次服务器列表，按优先级排序
  servers: [
    // 主服务器（优先级最高）
    {
      id: 'primary',
      name: '主服务器',
      url: '', // 动态检测：window.location.origin 或自定义
      weight: 3,
      priority: 1,
      role: 'primary', // primary | secondary
      enabled: true,
      lastCheck: null,
      healthy: true,
      latency: 0,
    },
    // 次服务器 1（生产环境请修改为实际地址）
    {
      id: 'secondary-1',
      name: '次服务器1',
      url: '', // 例如: 'http://192.168.1.234:8765'
      weight: 2,
      priority: 2,
      role: 'secondary',
      enabled: true,
      lastCheck: null,
      healthy: false, // 初始假设不健康，健康检查后更新
      latency: Infinity,
    },
    // 次服务器 2（可选）
    {
      id: 'secondary-2',
      name: '次服务器2',
      url: '',
      weight: 1,
      priority: 3,
      role: 'secondary',
      enabled: false, // 默认禁用，有需要再启用
      lastCheck: null,
      healthy: false,
      latency: Infinity,
    },
  ],

  // ========== 配置 ==========
  config: {
    // 健康检查间隔（毫秒）
    healthCheckInterval: 30000, // 30秒
    
    // 健康检查超时
    healthCheckTimeout: 5000, // 5秒
    
    // 故障切换阈值（连续失败多少次才切换）
    failThreshold: 3,
    
    // 恢复阈值（连续成功多少次才恢复）
    recoverThreshold: 2,
    
    // 降级模式：所有服务器都挂了时使用 localStorage
    fallbackToLocal: true,
    
    // 读写分离：读请求走次服务器（减轻主服务器压力）
    readFromSecondary: true,
    
    // 自动切换：主服务器挂了自动切到次服务器
    autoSwitch: true,
  },

  // ========== 状态 ==========
  state: {
    currentServer: null, // 当前使用的服务器
    failCount: {}, // { serverId: failCount }
    recoverCount: {}, // { serverId: recoverCount }
    isDegraded: false, // 是否处于降级模式（所有服务器都挂了）
    lastSwitchTime: null,
    healthCheckTimer: null,
  },

  // ========== 初始化 ==========
  init() {
    // 从 localStorage 加载用户自定义服务器列表
    this._loadServerConfig();
    
    // 设置主服务器 URL（当前 origin）
    const primary = this.servers.find(s => s.role === 'primary');
    if (primary && !primary.url) {
      primary.url = window.location.origin;
    }
    
    // 初始化计数器
    this.servers.forEach(s => {
      this.state.failCount[s.id] = 0;
      this.state.recoverCount[s.id] = 0;
    });
    
    // 选择初始服务器
    this._selectBestServer();
    
    // 启动健康检查
    this._startHealthCheck();
    
    console.log('[Distributed] 初始化完成，当前服务器:', this.state.currentServer?.name);
    return this.state.currentServer;
  },

  // ========== 从 localStorage 加载服务器配置 ==========
  _loadServerConfig() {
    try {
      const saved = localStorage.getItem('gms_distributed_servers');
      if (saved) {
        const config = JSON.parse(saved);
        if (config.servers && Array.isArray(config.servers)) {
          // 合并用户配置（只更新 URL 和 enabled）
          config.servers.forEach(userServer => {
            const server = this.servers.find(s => s.id === userServer.id);
            if (server) {
              if (userServer.url) server.url = userServer.url;
              if (userServer.enabled !== undefined) server.enabled = userServer.enabled;
            }
          });
          console.log('[Distributed] 已加载用户服务器配置');
        }
      }
    } catch (e) {
      console.warn('[Distributed] 加载服务器配置失败:', e.message);
    }
  },

  // ========== 保存服务器配置到 localStorage ==========
  saveServerConfig() {
    try {
      const config = {
        servers: this.servers.map(s => ({
          id: s.id,
          url: s.url,
          enabled: s.enabled,
        })),
        config: this.config,
      };
      localStorage.setItem('gms_distributed_servers', JSON.stringify(config));
    } catch (e) {
      console.warn('[Distributed] 保存服务器配置失败:', e.message);
    }
  },

  // ========== 选择最佳服务器 ==========
  _selectBestServer() {
    // 优先级排序：健康 > 优先级 > 响应时间
    const healthyServers = this.servers
      .filter(s => s.enabled && s.url && s.healthy)
      .sort((a, b) => {
        // 优先选健康的
        if (a.healthy !== b.healthy) return b.healthy ? 1 : -1;
        // 然后按优先级
        if (a.priority !== b.priority) return a.priority - b.priority;
        // 最后按响应时间
        return a.latency - b.latency;
      });
    
    if (healthyServers.length > 0) {
      this.state.currentServer = healthyServers[0];
      this.state.isDegraded = false;
    } else {
      // 所有服务器都不健康，选择优先级最高的（期待恢复）
      const fallback = this.servers
        .filter(s => s.enabled && s.url)
        .sort((a, b) => a.priority - b.priority)[0];
      
      if (fallback) {
        this.state.currentServer = fallback;
        this.state.isDegraded = true;
        console.warn('[Distributed] 所有服务器不健康，降级模式');
      } else {
        // 完全没有可用服务器
        this.state.currentServer = null;
        this.state.isDegraded = true;
        console.error('[Distributed] 无可用服务器');
      }
    }
    
    return this.state.currentServer;
  },

  // ========== 健康检查 ==========
  async _checkServerHealth(server) {
    if (!server || !server.url) return false;
    
    const startTime = Date.now();
    try {
      const res = await fetch(server.url + '/api/status', {
        method: 'GET',
        signal: AbortSignal.timeout(this.config.healthCheckTimeout),
      });
      
      const latency = Date.now() - startTime;
      
      if (res.ok) {
        const data = await res.json();
        server.healthy = true;
        server.latency = latency;
        server.lastCheck = Date.now();
        
        // 检查数据库连接状态
        if (data.dbConnected === false) {
          console.warn(`[Distributed] ${server.name} 数据库断开`);
          server.healthy = false;
        }
        
        return true;
      } else {
        server.healthy = false;
        server.latency = Infinity;
        server.lastCheck = Date.now();
        return false;
      }
    } catch (e) {
      server.healthy = false;
      server.latency = Infinity;
      server.lastCheck = Date.now();
      console.warn(`[Distributed] ${server.name} 健康检查失败:`, e.message);
      return false;
    }
  },

  // ========== 启动健康检查循环 ==========
  _startHealthCheck() {
    if (this.state.healthCheckTimer) {
      clearInterval(this.state.healthCheckTimer);
    }
    
    // 初始立即检查一次
    this._runHealthCheck();
    
    // 定期检查
    this.state.healthCheckTimer = setInterval(() => {
      this._runHealthCheck();
    }, this.config.healthCheckInterval);
  },

  // ========== 执行健康检查 ==========
  async _runHealthCheck() {
    const checks = this.servers
      .filter(s => s.enabled && s.url)
      .map(s => this._checkServerHealth(s));
    
    await Promise.allSettled(checks);
    
    // 处理故障/恢复计数
    this.servers.forEach(s => {
      if (!s.enabled || !s.url) return;
      
      if (s.healthy) {
        this.state.failCount[s.id] = 0;
        this.state.recoverCount[s.id]++;
        
        // 恢复阈值触发：切换回更高优先级服务器
        if (this.state.recoverCount[s.id] >= this.config.recoverThreshold) {
          if (s.priority < (this.state.currentServer?.priority || Infinity)) {
            console.log(`[Distributed] ${s.name} 已恢复，准备切换`);
            this._switchServer(s);
          }
        }
      } else {
        this.state.recoverCount[s.id] = 0;
        this.state.failCount[s.id]++;
        
        // 故障阈值触发：切换到其他服务器
        if (this.state.failCount[s.id] >= this.config.failThreshold) {
          if (s.id === this.state.currentServer?.id) {
            console.warn(`[Distributed] ${s.name} 连续失败 ${this.state.failCount[s.id]} 次，切换服务器`);
            this._switchToNextHealthy();
          }
        }
      }
    });
    
    // 更新 API.baseURL
    if (this.state.currentServer && API.baseURL !== this.state.currentServer.url) {
      API.baseURL = this.state.currentServer.url;
      console.log('[Distributed] API.baseURL 更新为:', API.baseURL);
    }
  },

  // ========== 切换服务器 ==========
  _switchServer(newServer) {
    if (!newServer || newServer.id === this.state.currentServer?.id) return;
    
    const oldServer = this.state.currentServer;
    this.state.currentServer = newServer;
    this.state.lastSwitchTime = Date.now();
    
    // 更新 API.baseURL
    API.baseURL = newServer.url;
    
    // 重新建立 SSE 连接
    if (API.eventSource) {
      API.eventSource.close();
      API.eventSource = null;
    }
    if (API.online && API.token) {
      API._listenSSE();
    }
    
    // 通知用户
    console.log(`[Distributed] 服务器切换: ${oldServer?.name || '无'} → ${newServer.name}`);
    
    // 触发全局事件
    window.dispatchEvent(new CustomEvent('gms:server-switch', {
      detail: { from: oldServer, to: newServer }
    }));
  },

  // ========== 切换到下一个健康服务器 ==========
  _switchToNextHealthy() {
    const healthyServers = this.servers
      .filter(s => s.enabled && s.url && s.healthy && s.id !== this.state.currentServer?.id)
      .sort((a, b) => a.priority - b.priority);
    
    if (healthyServers.length > 0) {
      this._switchServer(healthyServers[0]);
    } else {
      // 所有服务器都不健康，进入降级模式
      this.state.isDegraded = true;
      console.error('[Distributed] 所有服务器不健康，进入降级模式');
      
      window.dispatchEvent(new CustomEvent('gms:degraded-mode', {
        detail: { reason: 'all_servers_down' }
      }));
    }
  },

  // ========== 获取当前服务器 ==========
  getCurrentServer() {
    return this.state.currentServer;
  },

  // ========== 获取所有服务器状态 ==========
  getServerStatus() {
    return {
      current: this.state.currentServer,
      servers: this.servers.map(s => ({
        id: s.id,
        name: s.name,
        url: s.url,
        healthy: s.healthy,
        latency: s.latency,
        priority: s.priority,
        role: s.role,
      })),
      isDegraded: this.state.isDegraded,
    };
  },

  // ========== 添加新服务器 ==========
  addServer(serverConfig) {
    const newServer = {
      id: serverConfig.id || `secondary-${Date.now()}`,
      name: serverConfig.name || '新服务器',
      url: serverConfig.url,
      weight: serverConfig.weight || 1,
      priority: serverConfig.priority || this.servers.length + 1,
      role: 'secondary',
      enabled: true,
      lastCheck: null,
      healthy: false,
      latency: Infinity,
    };
    
    this.servers.push(newServer);
    this.state.failCount[newServer.id] = 0;
    this.state.recoverCount[newServer.id] = 0;
    this.saveServerConfig();
    
    // 立即检查健康
    this._checkServerHealth(newServer);
    
    console.log('[Distributed] 新服务器已添加:', newServer.name);
    return newServer;
  },

  // ========== 移除服务器 ==========
  removeServer(serverId) {
    const idx = this.servers.findIndex(s => s.id === serverId);
    if (idx >= 0) {
      this.servers.splice(idx, 1);
      delete this.state.failCount[serverId];
      delete this.state.recoverCount[serverId];
      this.saveServerConfig();
      console.log('[Distributed] 服务器已移除:', serverId);
    }
  },

  // ========== 禁用/启用服务器 ==========
  toggleServer(serverId, enabled) {
    const server = this.servers.find(s => s.id === serverId);
    if (server) {
      server.enabled = enabled;
      this.saveServerConfig();
      console.log(`[Distributed] ${server.name} ${enabled ? '已启用' : '已禁用'}`);
    }
  },

  // ========== 手动切换服务器 ==========
  manualSwitch(serverId) {
    const server = this.servers.find(s => s.id === serverId);
    if (server && server.enabled && server.url) {
      this._switchServer(server);
      return true;
    }
    return false;
  },

  // ========== 请求路由（读写分离） ==========
  getRequestUrl(requestType = 'write') {
    // 写请求：必须走当前服务器（可能是主服务器）
    if (requestType === 'write' || !this.config.readFromSecondary) {
      return this.state.currentServer?.url || '';
    }
    
    // 读请求：可以走延迟最低的健康服务器
    const readServers = this.servers
      .filter(s => s.enabled && s.url && s.healthy)
      .sort((a, b) => a.latency - b.latency);
    
    if (readServers.length > 0) {
      return readServers[0].url;
    }
    
    return this.state.currentServer?.url || '';
  },

  // ========== 停止健康检查 ==========
  stop() {
    if (this.state.healthCheckTimer) {
      clearInterval(this.state.healthCheckTimer);
      this.state.healthCheckTimer = null;
    }
  },

  // ========== 重启健康检查 ==========
  restart() {
    this.stop();
    this._startHealthCheck();
  },
};

// 导出到全局
window.DistributedConfig = DistributedConfig;