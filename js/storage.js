/**
 * Data storage layer - all data persisted in localStorage
 */
const Storage = {
  KEYS: {
    LEFT_GLOVE: 'gms_left_glove',
    RIGHT_GLOVE: 'gms_right_glove',
    LEFT_DEXTEROUS_HAND: 'gms_left_dexterous_hand',
    RIGHT_DEXTEROUS_HAND: 'gms_right_dexterous_hand',
    GRIPPER: 'gms_gripper',
    MACHINES: 'gms_machines',
    TRANSACTIONS: 'gms_transactions',
    SETTINGS: 'gms_settings',
    AUDIT_LOG: 'gms_audit_log',
    SN_REGISTRY: 'gms_sn_registry',
  },

  // Pure localStorage fallback (used by API.js when server unreachable)
  _local: {
    getInventory(type) {
      const map = {
        left_glove: 'gms_left_glove', right_glove: 'gms_right_glove',
        left_dexterous_hand: 'gms_left_dexterous_hand', right_dexterous_hand: 'gms_right_dexterous_hand',
        gripper: 'gms_gripper',
      };
      const key = map[type] || type;
      const data = localStorage.getItem(key);
      return data ? JSON.parse(data) : { quantity: 0, updatedAt: null, updatedBy: '' };
    },

    adjustInventory(type, delta, updatedBy, snCode) {
      const current = this.getInventory(type);
      const newQty = current.quantity + delta;
      if (newQty < 0) return { success: false, message: '库存不足' };
      const data = { quantity: newQty, updatedAt: new Date().toISOString(), updatedBy };
      const map = {
        left_glove: 'gms_left_glove', right_glove: 'gms_right_glove',
        left_dexterous_hand: 'gms_left_dexterous_hand', right_dexterous_hand: 'gms_right_dexterous_hand',
        gripper: 'gms_gripper',
      };
      localStorage.setItem(map[type] || type, JSON.stringify(data));
      return { success: true, newQuantity: newQty };
    },

    getMachines() {
      const data = localStorage.getItem('gms_machines');
      return data ? JSON.parse(data) : [];
    },

    saveMachines(machines) {
      localStorage.setItem('gms_machines', JSON.stringify(machines));
    },

    addMachine(machine) {
      const machines = this.getMachines();
      machines.push(machine);
      this.saveMachines(machines);
      return machines;
    },

    deleteMachine(id) {
      let machines = this.getMachines();
      machines = machines.filter(m => m.id !== id);
      this.saveMachines(machines);
    },

    getTransactions() {
      const data = localStorage.getItem('gms_transactions');
      return data ? JSON.parse(data) : [];
    },

    saveTransactions(transactions) {
      localStorage.setItem('gms_transactions', JSON.stringify(transactions));
    },

    addTransaction(tx) {
      const transactions = this.getTransactions();
      transactions.unshift(tx);
      this.saveTransactions(transactions);
      return tx;
    },

    deleteTransaction(id) {
      let transactions = this.getTransactions();
      transactions = transactions.filter(t => t.id !== id);
      this.saveTransactions(transactions);
    },

    getAuditLog() {
      const data = localStorage.getItem('gms_audit_log');
      return data ? JSON.parse(data) : [];
    },

    getSettings() {
      const data = localStorage.getItem('gms_settings');
      return data ? JSON.parse(data) : { darkMode: false, lowStockThreshold: 10, language: 'zh', dashboardCards: ['totalGloves', 'totalDexterous', 'left_glove', 'right_glove', 'left_dexterous_hand', 'right_dexterous_hand', 'gripper', 'onlineMachines', 'todayTransactions'] };
    },

    saveSettings(settings) {
      localStorage.setItem('gms_settings', JSON.stringify(settings));
    },
  },

  // One-time migration from old single dexterous_hand key
  _migrate() {
    const oldKey = 'gms_dexterous_hand';
    const oldData = localStorage.getItem(oldKey);
    if (oldData) {
      const parsed = JSON.parse(oldData);
      const halfQty = Math.floor(parsed.quantity / 2);
      if (!localStorage.getItem(this.KEYS.LEFT_DEXTEROUS_HAND)) {
        localStorage.setItem(this.KEYS.LEFT_DEXTEROUS_HAND, JSON.stringify({
          quantity: halfQty, updatedAt: parsed.updatedAt, updatedBy: parsed.updatedBy
        }));
      }
      if (!localStorage.getItem(this.KEYS.RIGHT_DEXTEROUS_HAND)) {
        localStorage.setItem(this.KEYS.RIGHT_DEXTEROUS_HAND, JSON.stringify({
          quantity: parsed.quantity - halfQty, updatedAt: parsed.updatedAt, updatedBy: parsed.updatedBy
        }));
      }
      localStorage.removeItem(oldKey);
    }
  },

  // ========== Inventory Getters/Setters ==========
  getInventory(type) {
    const key = this._inventoryKey(type);
    const data = localStorage.getItem(key);
    return data ? JSON.parse(data) : { quantity: 0, updatedAt: null, updatedBy: '' };
  },

  setInventory(type, quantity, updatedBy) {
    const data = { quantity, updatedAt: new Date().toISOString(), updatedBy };
    localStorage.setItem(this._inventoryKey(type), JSON.stringify(data));
    this._addAuditLog('inventory_update', `更新${this._typeLabel(type)}库存为 ${quantity}`, updatedBy);
    return data;
  },

  // Explicitly clear transient operational data (transactions, SN registry, undo stack)
  clearOperationalData() {
    try {
      this.saveTransactions([]);
      this.saveSNRegistry([]);
      this._undoStack = [];
      localStorage.removeItem('gms_undo_stack');
      localStorage.removeItem('gms_login_token');
    } catch (e) {}
  },

  adjustInventory(type, delta, updatedBy, snCode) {
    const current = this.getInventory(type);
    const localQty = current.quantity + delta;
    if (localQty < 0) return { success: false, message: `${this._typeLabel(type)}库存不足，无法出库` };
    this.pushUndo('adjustInventory', { type, previousQuantity: current.quantity, updatedBy });
    // Optimistic local update first for responsive UI
    this.setInventory(type, localQty, updatedBy);
    if (API.online) {
      // Override with server's authoritative value when response arrives
      API.adjustInventory(type, delta, updatedBy, snCode)
        .then(result => {
          if (result && result.success) {
            this.setInventory(type, result.newQuantity, updatedBy);
          }
        })
        .catch(() => {});
    }
    return { success: true, newQuantity: localQty };
  },

  _inventoryKey(type) {
    const map = {
      left_glove: this.KEYS.LEFT_GLOVE,
      right_glove: this.KEYS.RIGHT_GLOVE,
      left_dexterous_hand: this.KEYS.LEFT_DEXTEROUS_HAND,
      right_dexterous_hand: this.KEYS.RIGHT_DEXTEROUS_HAND,
      gripper: this.KEYS.GRIPPER,
    };
    return map[type] || type;
  },

  _typeLabel(type) {
    const map = {
      left_glove: '左手手套', right_glove: '右手手套',
      left_dexterous_hand: '左手灵巧手', right_dexterous_hand: '右手灵巧手',
      dexterous_hand: '灵巧手',
      gripper: '夹爪',
    };
    return map[type] || type;
  },

  // ========== Machine Management ==========
  getMachines() {
    const data = localStorage.getItem(this.KEYS.MACHINES);
    return data ? JSON.parse(data) : [];
  },

  saveMachines(machines) {
    localStorage.setItem(this.KEYS.MACHINES, JSON.stringify(machines));
  },

  addMachine(machine) {
    const machines = this.getMachines();
    const newMachine = { ...machine, id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), updatedAt: machine.updatedAt || new Date().toISOString() };
    machines.push(newMachine);
    this.saveMachines(machines);
    this._addAuditLog('machine_add', `添加${machine.deviceType ? this._deviceTypeLabel(machine.deviceType) : ''}机器 ${machine.machineNumber}`, machine.updatedBy);
    if (API.online) { this._syncMachineToServer(newMachine); }
    return machines;
  },

  // Retry API.addMachine up to 2 times on failure (fix silent data loss)
  async _syncMachineToServer(machine, attempt) {
    attempt = attempt || 1;
    try {
      await API.addMachine(machine);
    } catch (e) {
      console.log('Sync machine to server failed (attempt ' + attempt + '):', e.message);
      if (attempt < 2) {
        setTimeout(() => this._syncMachineToServer(machine, attempt + 1), 2000);
      } else {
        console.log('Sync machine to server FAILED after 2 attempts — will merge on next sync');
      }
    }
  },

  updateMachineStatus(machineId, status, reason, updatedBy) {
    const machines = this.getMachines();
    const machine = machines.find(m => m.id === machineId);
    if (!machine) return null;
    machine.status = status;
    if (status === 'online') {
      machine.onlineTime = new Date().toISOString();
      machine.onlineReason = reason || '';
      machine.offlineTime = null;
      machine.offlineReason = '';
    } else {
      machine.offlineTime = new Date().toISOString();
      machine.offlineReason = reason || '';
      machine.onlineTime = null;
      machine.onlineReason = '';
    }
    machine.updatedBy = updatedBy;
    machine.updatedAt = new Date().toISOString();
    this.saveMachines(machines);
    this._addAuditLog('machine_status', `机器 ${machine.machineNumber} ${status === 'online' ? '上线' : '下线'}`, updatedBy);
    return machines;
  },

  getOnlineMachineCount() {
    const machines = this.getMachines();
    // For each unique machine number, find the most recent record by timestamp
    const latestByMachine = {};
    for (const m of machines) {
      const existing = latestByMachine[m.machineNumber];
      if (!existing) { latestByMachine[m.machineNumber] = m; continue; }
      // Compare by updatedAt first, then id (timestamp-based) as tiebreaker
      const mTime = m.updatedAt ? new Date(m.updatedAt).getTime() : 0;
      const eTime = existing.updatedAt ? new Date(existing.updatedAt).getTime() : 0;
      if (mTime > eTime) { latestByMachine[m.machineNumber] = m; }
      else if (mTime === eTime && m.id > existing.id) { latestByMachine[m.machineNumber] = m; }
    }
    // Count only machines whose latest record is 'online'
    return Object.values(latestByMachine).filter(m => m.status === 'online').length;
  },

  _deviceTypeLabel(type) {
    const map = {
      glove: '纯手套设备',
      dexterous: '灵巧手设备',
      gripper: '夹爪设备',
    };
    return map[type] || type;
  },

  // Returns the inventory items consumed by one online machine of given deviceType
  getDeviceInventoryMap(deviceType) {
    switch (deviceType) {
      case 'glove':
        return { left_glove: 1, right_glove: 1 };
      case 'dexterous':
        return { left_glove: 1, right_glove: 1, left_dexterous_hand: 1, right_dexterous_hand: 1 };
      case 'gripper':
        return { gripper: 2 };
      default:
        return {};
    }
  },

  // ========== Equipment Type Config ==========
  _defaultEquipmentConfig() {
    return [
      { id: 'glove', name: '纯手套设备', icon: '🧤', consumes: [{ inventoryType: 'left_glove', handType: 'left', quantity: 1 }, { inventoryType: 'right_glove', handType: 'right', quantity: 1 }], createdAt: new Date().toISOString() },
      { id: 'dexterous', name: '灵巧手设备', icon: '🤖', consumes: [{ inventoryType: 'left_glove', handType: 'left', quantity: 1 }, { inventoryType: 'right_glove', handType: 'right', quantity: 1 }, { inventoryType: 'left_dexterous_hand', handType: 'left', quantity: 1 }, { inventoryType: 'right_dexterous_hand', handType: 'right', quantity: 1 }], createdAt: new Date().toISOString() },
      { id: 'gripper', name: '夹爪设备', icon: '🔧', consumes: [{ inventoryType: 'gripper', handType: null, quantity: 2 }], createdAt: new Date().toISOString() },
    ];
  },

  _defaultInventoryConfig() {
    return [
      { id: 'left_glove', name: '左手手套', icon: '🧤', hasLeftRight: false, createdAt: new Date().toISOString() },
      { id: 'right_glove', name: '右手手套', icon: '🧤', hasLeftRight: false, createdAt: new Date().toISOString() },
      { id: 'left_dexterous_hand', name: '左手灵巧手', icon: '🤖', hasLeftRight: false, createdAt: new Date().toISOString() },
      { id: 'right_dexterous_hand', name: '右手灵巧手', icon: '🤖', hasLeftRight: false, createdAt: new Date().toISOString() },
      { id: 'gripper', name: '夹爪', icon: '🔧', hasLeftRight: false, createdAt: new Date().toISOString() },
    ];
  },

  getEquipmentConfig() {
    const data = localStorage.getItem('gms_equipment_config');
    if (!data) { const d = this._defaultEquipmentConfig(); this.saveEquipmentConfig(d); return d; }
    return JSON.parse(data);
  },

  saveEquipmentConfig(config) {
    localStorage.setItem('gms_equipment_config', JSON.stringify(config));
    if (API.online) { API.saveEquipmentConfig(config).catch(() => {}); }
  },

  getInventoryConfig() {
    const data = localStorage.getItem('gms_inventory_config');
    if (!data) { const d = this._defaultInventoryConfig(); this.saveInventoryConfig(d); return d; }
    return JSON.parse(data);
  },

  saveInventoryConfig(config) {
    localStorage.setItem('gms_inventory_config', JSON.stringify(config));
    if (API.online) { API.saveInventoryConfig(config).catch(() => {}); }
  },

  getEquipmentTypeById(id) {
    const config = this.getEquipmentConfig();
    return config.find(e => e.id === id) || null;
  },

  getInventoryTypeById(id) {
    const config = this.getInventoryConfig();
    return config.find(e => e.id === id) || null;
  },

  getDeviceConsumptionMap(equipmentTypeId) {
    const eq = this.getEquipmentTypeById(equipmentTypeId);
    if (!eq) return this.getDeviceInventoryMap(equipmentTypeId); // fallback to old hardcoded
    const map = {};
    eq.consumes.forEach(c => {
      map[c.inventoryType] = (map[c.inventoryType] || 0) + c.quantity;
    });
    return map;
  },

  // Undo support
  _undoStack: [],

  _generatePairId() {
    return 'pair-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  },

  pushUndo(action, data) {
    this._undoStack.push({ action, data, expiresAt: Date.now() + 120000 });
    if (this._undoStack.length > 20) this._undoStack.shift();
  },

  popUndo() {
    while (this._undoStack.length > 0) {
      const entry = this._undoStack.pop();
      if (entry.expiresAt > Date.now()) return { ...entry.data, type: entry.action };
    }
    return null;
  },

  // ========== Transactions ==========
  getTransactions() {
    const data = localStorage.getItem(this.KEYS.TRANSACTIONS);
    return data ? JSON.parse(data) : [];
  },

  saveTransactions(transactions) {
    // Cap at 10000 most recent to keep localStorage fast & under limits
    if (transactions.length > 10000) {
      transactions = transactions.slice(0, 10000);
    }
    localStorage.setItem(this.KEYS.TRANSACTIONS, JSON.stringify(transactions));
  },

  addTransaction(tx) {
    const transactions = this.getTransactions();
    const record = {
      ...tx,
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      timestamp: new Date().toISOString(),
    };
    transactions.unshift(record);
    this.saveTransactions(transactions);
    this._addAuditLog('transaction', `${this._txSummary(record)}`, tx.updatedBy);
    if (API.online) { API.addTransaction(record).catch(() => {}); }
    return record;
  },

  _txSummary(tx) {
    let typeLabel;
    if (tx.equipmentType === 'glove') {
      typeLabel = tx.handType === 'left' ? '左手手套' : '右手手套';
    } else if (tx.equipmentType === 'left_dexterous_hand') {
      typeLabel = '左手灵巧手';
    } else if (tx.equipmentType === 'right_dexterous_hand') {
      typeLabel = '右手灵巧手';
    } else if (tx.equipmentType === 'dexterous_hand') {
      typeLabel = '灵巧手';
    } else if (tx.equipmentType === 'gripper') {
      typeLabel = '夹爪';
    } else {
      typeLabel = this._typeLabel(tx.equipmentType);
    }
    const dir = tx.direction === 'in' ? '入库' : '出库';
    return `${typeLabel} ${dir} ${tx.quantity}个`;
  },

  // ========== Audit Log ==========
  getAuditLog() {
    const data = localStorage.getItem(this.KEYS.AUDIT_LOG);
    return data ? JSON.parse(data) : [];
  },

  _addAuditLog(action, detail, user) {
    const logs = this.getAuditLog();
    logs.unshift({
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      action,
      detail,
      user: user || '系统',
      timestamp: new Date().toISOString(),
    });
    if (logs.length > 1000) logs.length = 1000;
    localStorage.setItem(this.KEYS.AUDIT_LOG, JSON.stringify(logs));
  },

  // ========== Settings ==========
  getSettings() {
    const data = localStorage.getItem(this.KEYS.SETTINGS);
    return data ? JSON.parse(data) : { darkMode: false, lowStockThreshold: 10, language: 'zh', dashboardCards: ['totalGloves', 'totalDexterous', 'left_glove', 'right_glove', 'left_dexterous_hand', 'right_dexterous_hand', 'gripper', 'onlineMachines', 'todayTransactions'] };
  },

  saveSettings(settings) {
    localStorage.setItem(this.KEYS.SETTINGS, JSON.stringify(settings));
    if (API.online) { API.saveSettings(settings).catch(() => {}); }
  },

  // ========== Backup & Restore ==========
  exportAllData() {
    const invConfig = this.getInventoryConfig();
    const data = {
      version: '2.0',
      exportedAt: new Date().toISOString(),
      left_glove: this.getInventory('left_glove'),
      right_glove: this.getInventory('right_glove'),
      left_dexterous_hand: this.getInventory('left_dexterous_hand'),
      right_dexterous_hand: this.getInventory('right_dexterous_hand'),
      gripper: this.getInventory('gripper'),
      machines: this.getMachines(),
      transactions: this.getTransactions(),
      auditLog: this.getAuditLog(),
      settings: this.getSettings(),
      snRegistry: this.getSNRegistry(),
      inventoryConfig: invConfig,
      equipmentConfig: JSON.parse(localStorage.getItem('gms_equipment_config') || 'null'),
      users: JSON.parse(localStorage.getItem('gms_users') || 'null'),
    };
    // Include custom inventory type quantities
    invConfig.forEach(c => {
      if (c.hasLeftRight) {
        data[c.id + '_left'] = this.getInventory(c.id + '_left');
        data[c.id + '_right'] = this.getInventory(c.id + '_right');
      } else {
        data[c.id] = this.getInventory(c.id);
      }
    });
    return JSON.stringify(data, null, 2);
  },

  importAllData(jsonStr) {
    try {
      const data = JSON.parse(jsonStr);
      // Accept both old and new format files
      // Standard inventory keys
      const inventoryKeys = [
        [this.KEYS.LEFT_GLOVE, 'left_glove'],
        [this.KEYS.RIGHT_GLOVE, 'right_glove'],
        [this.KEYS.LEFT_DEXTEROUS_HAND, 'left_dexterous_hand'],
        [this.KEYS.RIGHT_DEXTEROUS_HAND, 'right_dexterous_hand'],
        [this.KEYS.GRIPPER, 'gripper'],
      ];
      inventoryKeys.forEach(([key, field]) => {
        localStorage.setItem(key, JSON.stringify(data[field] || { quantity: 0, updatedAt: null, updatedBy: '' }));
      });
      // Custom inventory types from config
      if (data.inventoryConfig && Array.isArray(data.inventoryConfig)) {
        localStorage.setItem('gms_inventory_config', JSON.stringify(data.inventoryConfig));
        data.inventoryConfig.forEach(c => {
          if (c.hasLeftRight) {
            const lk = this._inventoryKey(c.id + '_left');
            const rk = this._inventoryKey(c.id + '_right');
            localStorage.setItem(lk, JSON.stringify(data[c.id + '_left'] || { quantity: 0, updatedAt: null, updatedBy: '' }));
            localStorage.setItem(rk, JSON.stringify(data[c.id + '_right'] || { quantity: 0, updatedAt: null, updatedBy: '' }));
          } else {
            const k = this._inventoryKey(c.id);
            localStorage.setItem(k, JSON.stringify(data[c.id] || { quantity: 0, updatedAt: null, updatedBy: '' }));
          }
        });
      }
      // Equipment config
      if (data.equipmentConfig) localStorage.setItem('gms_equipment_config', JSON.stringify(data.equipmentConfig));
      // Main data stores
      localStorage.setItem(this.KEYS.MACHINES, JSON.stringify(data.machines || []));
      // Accept transactions as array or object map
      const txs = Array.isArray(data.transactions) ? data.transactions : (data.transactions ? Object.values(data.transactions) : []);
      localStorage.setItem(this.KEYS.TRANSACTIONS, JSON.stringify(txs));
      localStorage.setItem(this.KEYS.AUDIT_LOG, JSON.stringify(data.auditLog || []));
      localStorage.setItem(this.KEYS.SETTINGS, JSON.stringify(data.settings || {}));
      const sn = Array.isArray(data.snRegistry) ? data.snRegistry : (data.snRegistry ? Object.values(data.snRegistry) : []);
      localStorage.setItem(this.KEYS.SN_REGISTRY, JSON.stringify(sn));
      // Users
      if (data.users) localStorage.setItem('gms_users', JSON.stringify(data.users));
      // Ops data
      if (data.opsOrders) localStorage.setItem('gms_ops_orders', JSON.stringify(data.opsOrders));
      if (data.opsCustomers) localStorage.setItem('gms_ops_customers', JSON.stringify(data.opsCustomers));
      if (data.opsProduction) localStorage.setItem('gms_ops_production', JSON.stringify(data.opsProduction));
      return { success: true };
    } catch (e) {
      return { success: false, message: e.message };
    }
  },

  // ========== Offline Users ==========
  _defaultUsers() {
    return [
      { username: 'admin', passwordHash: 'a87e281f160444e878f006b9e1763212440d2cdb806eafa3b618d806d6750e20', role: 'superadmin', system: 'maintenance' },
    ];
  },

  getUsers() {
    const data = localStorage.getItem('gms_users');
    if (!data) { const d = this._defaultUsers(); this.saveUsers(d); return d; }
    return JSON.parse(data);
  },

  saveUsers(users) {
    localStorage.setItem('gms_users', JSON.stringify(users));
  },

  async clearAllData() {
    // Clear operational data ONLY — preserve: settings, equipment_config, inventory_config, users
    const preserveKeys = [this.KEYS.SETTINGS, 'gms_users', 'gms_inventory_config', 'gms_equipment_config', 'gms_login_history'];
    const clearKeys = [
      ...Object.values(this.KEYS).filter(k => !preserveKeys.includes(k)),
    ];
    // Add custom inventory type keys
    const invConfig = this.getInventoryConfig();
    invConfig.forEach(c => {
      if (c.hasLeftRight) {
        clearKeys.push(this._inventoryKey(c.id + '_left'));
        clearKeys.push(this._inventoryKey(c.id + '_right'));
      } else {
        clearKeys.push(this._inventoryKey(c.id));
      }
    });
    clearKeys.forEach(k => localStorage.removeItem(k));
    localStorage.removeItem('gms_undo_stack');
    localStorage.removeItem('gms_login_token');
    this._undoStack = [];
    this._addAuditLog('clear_all', '清空所有数据', '系统');
    // Clear server data first, then re-sync to confirm
    // Clean up uploaded files associated with SN registry
    if (API.online) {
      const reg = this.getSNRegistry();
      reg.forEach(r => {
        if (r.attachment && r.attachment.startsWith('/uploads/')) {
          API.deleteUpload(r.attachment).catch(() => {});
        }
      });
      const ok = await API.clearAllData();
      if (ok) {
        // Server confirmed clear — re-sync to get authoritative empty state
        await this._syncFromServer();
      }
    }
  },

  // ========== SN Registry ==========
  getSNRegistry() {
    const data = localStorage.getItem(this.KEYS.SN_REGISTRY);
    return data ? JSON.parse(data) : [];
  },
  saveSNRegistry(entries) {
    localStorage.setItem(this.KEYS.SN_REGISTRY, JSON.stringify(entries));
  },
  // 服务端SN注册表为权威数据源：同步时完全替换本地数据
  // 不再保留本地独有SN（旧版merge策略会导致多设备数据不一致）
  replaceSNRegistry(serverEntries) {
    this.saveSNRegistry(serverEntries || []);
  },
  upsertSNRegistry(entry) {
    const entries = this.getSNRegistry();
    const idx = entries.findIndex(e => e.snCode === entry.snCode);
    if (idx >= 0) {
      entries[idx] = { ...entries[idx], ...entry, updatedAt: new Date().toISOString() };
    } else {
      entries.push({ ...entry, updatedAt: new Date().toISOString() });
    }
    this.saveSNRegistry(entries);
    return { success: true };
  },
  getSNByCode(snCode) {
    const entries = this.getSNRegistry();
    return entries.find(e => e.snCode === snCode) || null;
  },

  // Full sync: REPLACE local data with server (used by manual refresh button)
  async _fullSyncFromServer() {
    if (!API.online) return;
    // Inventory: clear all known keys first, then fill from server
    try {
      const knownInvKeys = new Set([
        this.KEYS.LEFT_GLOVE, this.KEYS.RIGHT_GLOVE,
        this.KEYS.LEFT_DEXTEROUS_HAND, this.KEYS.RIGHT_DEXTEROUS_HAND, this.KEYS.GRIPPER,
      ]);
      const invConfig = this.getInventoryConfig();
      invConfig.forEach(c => {
        if (c.hasLeftRight) { knownInvKeys.add(this._inventoryKey(c.id + '_left')); knownInvKeys.add(this._inventoryKey(c.id + '_right')); }
        else { knownInvKeys.add(this._inventoryKey(c.id)); }
      });
      // First set all to 0
      knownInvKeys.forEach(k => localStorage.setItem(k, JSON.stringify({ quantity: 0, updatedAt: null, updatedBy: '' })));
      // Then fill from server
      const inv = await API.getAllInventory();
      if (Array.isArray(inv)) {
        for (const item of inv) {
          if (item.type && item.quantity !== undefined) {
            localStorage.setItem(this._inventoryKey(item.type), JSON.stringify({ quantity: item.quantity, updatedAt: item.updatedAt, updatedBy: item.updatedBy || '' }));
          }
        }
      }
    } catch(e) { console.log('Full sync inv:', e.message); }
    try {
      const m = await API.getMachines();
      if (Array.isArray(m) && m.length > 0) {
        // Merge server + local: keep latest record per machineNumber
        const localMachines = this.getMachines();
        const merged = new Map();
        const collect = (list) => {
          for (const item of list) {
            if (!item || !item.machineNumber) continue;
            const existing = merged.get(item.machineNumber);
            if (!existing) { merged.set(item.machineNumber, item); continue; }
            const mTime = item.updatedAt ? new Date(item.updatedAt).getTime() : 0;
            const eTime = existing.updatedAt ? new Date(existing.updatedAt).getTime() : 0;
            if (mTime > eTime || (mTime === eTime && (item.id || '') > (existing.id || ''))) {
              merged.set(item.machineNumber, item);
            }
          }
        };
        collect(m);
        collect(localMachines);
        this.saveMachines(Array.from(merged.values()));
      } else if (Array.isArray(m)) {
        this.saveMachines(m);
      }
    } catch(e) { console.log('Full sync machines:', e.message); }
    try { const t = await API.getTransactions(); if (Array.isArray(t)) {
      try {
        const deletedIds = JSON.parse(localStorage.getItem('gms_deleted_tx_ids') || '[]');
        const activeDeleted = new Set(deletedIds.filter(e => e.expires > Date.now()).map(e => e.id));
        this.saveTransactions(activeDeleted.size > 0 ? t.filter(tx => !activeDeleted.has(tx.id)) : t);
      } catch { this.saveTransactions(t); }
    } } catch(e) { console.log('Full sync txs:', e.message); }
    try { const a = await API.getAuditLog(); if (Array.isArray(a)) localStorage.setItem(this.KEYS.AUDIT_LOG, JSON.stringify(a)); } catch(e) { console.log('Full sync audit:', e.message); }
    try { const s = await API.getSettings(); if (s && !s.error) this.saveSettings(s); } catch(e) {}
    try { const e = await API.getEquipmentConfig(); if (Array.isArray(e)) localStorage.setItem('gms_equipment_config', JSON.stringify(e)); } catch(e) {}
    try { const i = await API.getInventoryConfig(); if (Array.isArray(i)) localStorage.setItem('gms_inventory_config', JSON.stringify(i)); } catch(e) {}
    try { const r = await API.getSNRegistry(); if (Array.isArray(r)) this.replaceSNRegistry(r); } catch(e) { console.log('Full sync snReg:', e.message); }
  },

  // ========== Server Sync ==========
  async _syncFromServer() {
    if (!API.online || !API.token) return;
    // ONE bulk request instead of 8 separate API calls — dramatically faster
    try {
      const res = await fetch(API.baseURL + '/api/sync', {
        headers: { 'Authorization': 'Bearer ' + API.token }
      });
      if (res.ok) {
        const data = await res.json();
        this._applySync(data);
      }
    } catch(e) { console.log('Sync error:', e.message); }
  },

  // Bulk apply sync data (used by polling fallback — one response, all tables)
  _applySync(data) {
    if (!data) return;
    // Protection: if server returns empty machines (e.g. during restart), don't wipe local data
    const hasData = (data.machines && data.machines.length > 0) || (data.inventory && data.inventory.length > 0);
    if (!hasData) return;
    try {
      if (Array.isArray(data.inventory) && data.inventory.length > 0) {
        // Incremental sync: only update types the server actually returned
        // Do NOT zero-out missing types — avoids UI flash
        data.inventory.forEach(item => {
          if (item.type && item.quantity !== undefined) {
            localStorage.setItem(this._inventoryKey(item.type), JSON.stringify({ quantity: item.quantity, updatedAt: item.updatedAt, updatedBy: item.updatedBy || '' }));
          }
        });
      }
    } catch(e) { console.log('_applySync inv:', e.message); }
    try {
      if (Array.isArray(data.machines) && data.machines.length > 0) {
        // Merge server + local: keep latest record per machineNumber (by updatedAt)
        const localMachines = this.getMachines();
        const merged = new Map();
        const collect = (list) => {
          for (const m of list) {
            if (!m || !m.machineNumber) continue;
            const existing = merged.get(m.machineNumber);
            if (!existing) { merged.set(m.machineNumber, m); continue; }
            const mTime = m.updatedAt ? new Date(m.updatedAt).getTime() : 0;
            const eTime = existing.updatedAt ? new Date(existing.updatedAt).getTime() : 0;
            if (mTime > eTime || (mTime === eTime && (m.id || '') > (existing.id || ''))) {
              merged.set(m.machineNumber, m);
            }
          }
        };
        collect(data.machines);
        collect(localMachines);
        this.saveMachines(Array.from(merged.values()));
      }
    } catch(e) { console.log('_applySync machines:', e.message); }
    try {
      if (Array.isArray(data.transactions) && data.transactions.length > 0) {
        try {
          const deletedIds = JSON.parse(localStorage.getItem('gms_deleted_tx_ids') || '[]');
          const activeDeleted = new Set(deletedIds.filter(e => e.expires > Date.now()).map(e => e.id));
          this.saveTransactions(activeDeleted.size > 0 ? data.transactions.filter(t => !activeDeleted.has(t.id)) : data.transactions);
        } catch { this.saveTransactions(data.transactions); }
      }
    } catch(e) { console.log('_applySync txs:', e.message); }
    try {
      if (Array.isArray(data.snRegistry)) this.replaceSNRegistry(data.snRegistry);
    } catch(e) { console.log('_applySync snReg:', e.message); }
    try {
      if (data.settings && !data.error) this.saveSettings(data.settings);
    } catch(e) {}
    try {
      if (Array.isArray(data.equipmentConfig)) localStorage.setItem('gms_equipment_config', JSON.stringify(data.equipmentConfig));
    } catch(e) {}
    try {
      if (Array.isArray(data.inventoryConfig)) localStorage.setItem('gms_inventory_config', JSON.stringify(data.inventoryConfig));
    } catch(e) {}
    try {
      if (Array.isArray(data.techSupport)) localStorage.setItem('gms_tech_support', JSON.stringify(data.techSupport));
    } catch(e) {}
  },
};

// Run migration on load
Storage._migrate();
// Ensure there's at least one audit log entry to indicate initialization
try {
  if (Storage.getAuditLog().length === 0) {
    Storage._addAuditLog('startup', 'Storage initialized', '系统');
  }
} catch (e) {}
