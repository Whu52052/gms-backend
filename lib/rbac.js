/**
 * lib/rbac.js
 * RBAC 权限引擎（Phase 1 企业级基座）
 *
 * 权限模型：模块(module) × 动作(action) 二维权限点 + 仓库范围(warehouseScope)。
 *  - 内置角色（user/admin/superadmin）用静态映射表解析，保持与历史硬编码检查语义一致
 *  - 自定义角色存 roles 表（data JSON），createRbacEngine 持进程内缓存，保存角色时失效
 *  - can(user, module, action, ctx) 为异步函数：内置角色同步短路，自定义角色查缓存/DB
 *
 * 用法（server.js startup 内）：
 *   const rbac = createRbacEngine({ pool });
 *   if (await rbac.can(user, 'inventory', 'adjust', { warehouseId })) { ... }
 */
'use strict';

// ==================== 权限点注册表 ====================
// 新模块接入：在此登记模块与动作，前端权限矩阵与后端校验共用同一份语义。
const PERMISSION_MODULES = {
  inventory:        { label: '库存管理', actions: ['view', 'adjust', 'transfer'] },
  inventory_config: { label: '品类配置', actions: ['view', 'manage'] },
  warehouses:       { label: '仓库管理', actions: ['view', 'manage'] },
  sn_registry:      { label: 'SN管理', actions: ['view', 'manage'] },
  machines:         { label: '机器管理', actions: ['view', 'manage'] },
  transactions:     { label: '库存流水', actions: ['view'] },
  stocktakes:       { label: '库存盘点', actions: ['view', 'manage'] },
  tech_support:     { label: '技术支持', actions: ['submit', 'respond', 'manage'] },
  users:            { label: '用户管理', actions: ['view', 'manage'] },
  roles:            { label: '角色权限', actions: ['view', 'manage'] },
  reports:          { label: '报表导出', actions: ['view', 'export'] },
};

// ==================== 内置角色权限映射 ====================
// 语义与 Phase 1 之前各 handler 的硬编码检查保持一致：
//  - superadmin：全部权限
//  - admin：业务管理权限（库存/SN/机器/盘点/品类），无角色管理权
//  - user：只读库存/SN/机器 + 提交技术支持
// 注意：内置角色的行为仍由各 handler 原有的 requireAdmin/requireSuperadmin 把关，
// 此表主要用于前端权限矩阵展示与自定义角色创建时的对照基线。
const BUILTIN_ROLES = {
  superadmin: {
    id: 'superadmin', name: '超级管理员', isBuiltIn: true,
    warehouseScope: 'all',
    permissions: Object.fromEntries(
      Object.keys(PERMISSION_MODULES).map(m => [m, Object.fromEntries(PERMISSION_MODULES[m].actions.map(a => [a, true]))])
    ),
  },
  admin: {
    id: 'admin', name: '管理员', isBuiltIn: true,
    warehouseScope: 'all',
    permissions: {
      inventory: { view: true, adjust: true, transfer: true },
      inventory_config: { view: true, manage: true },
      warehouses: { view: true, manage: true },
      sn_registry: { view: true, manage: true },
      machines: { view: true, manage: true },
      transactions: { view: true },
      stocktakes: { view: true, manage: true },
      tech_support: { submit: false, respond: true, manage: true },
      users: { view: true, manage: true },
      roles: { view: true, manage: false },
      reports: { view: true, export: true },
    },
  },
  user: {
    id: 'user', name: '普通用户', isBuiltIn: true,
    warehouseScope: 'all',
    permissions: {
      inventory: { view: true, adjust: false, transfer: false },
      inventory_config: { view: true, manage: false },
      warehouses: { view: true, manage: false },
      sn_registry: { view: true, manage: false },
      machines: { view: true, manage: false },
      transactions: { view: false },
      stocktakes: { view: false, manage: false },
      tech_support: { submit: true, respond: false, manage: false },
      users: { view: false, manage: false },
      roles: { view: false, manage: false },
      reports: { view: false, export: false },
    },
  },
};

// ==================== 工厂 ====================
module.exports = {
  PERMISSION_MODULES,
  BUILTIN_ROLES,

  /**
   * @param {{pool: object}} deps
   * @returns {{can, getRole, listRoles, invalidateCache}} rbac engine
   */
  createRbacEngine({ pool }) {
    // roleId → role object 缓存（自定义角色）；启动后首次访问懒加载
    const _roleCache = new Map();

    async function _loadRole(roleId) {
      if (_roleCache.has(roleId)) return _roleCache.get(roleId);
      try {
        const [rows] = await pool.execute('SELECT id, data FROM roles WHERE id = ?', [roleId]);
        if (rows.length === 0) { _roleCache.set(roleId, null); return null; }
        let d;
        try { d = JSON.parse(rows[0].data); } catch { d = null; }
        const role = d ? { ...d, id: rows[0].id } : null;
        _roleCache.set(roleId, role);
        return role;
      } catch (e) {
        console.error('[RBAC] load role failed:', roleId, e.message);
        return null;
      }
    }

    function invalidateCache() { _roleCache.clear(); }

    /**
     * 解析用户的角色定义：customRole（自定义）优先，否则按内置 role 字段映射。
     * @returns {Promise<object|null>} role def with permissions + warehouseScope
     */
    async function getRole(user) {
      if (!user) return null;
      // token payload 用 snake_case（custom_role，DB 行直接展开），前端用 camelCase —— 两者都接受
      const customRoleId = user.customRole || user.custom_role;
      if (customRoleId) {
        const r = await _loadRole(customRoleId);
        if (r) return r;
        // 自定义角色被删后按内置角色降级，避免用户彻底失权
      }
      return BUILTIN_ROLES[user.role] || BUILTIN_ROLES.user;
    }

    /**
     * 权限检查。
     * @param {object} user authUser（token payload，含 role / customRole）
     * @param {string} module PERMISSION_MODULES 键
     * @param {string} action 该模块的动作
     * @param {{warehouseId?: string}} [ctx] 仓库上下文（仓库范围校验）
     * @returns {Promise<boolean>}
     */
    async function can(user, module, action, ctx) {
      const role = await getRole(user);
      if (!role) return false;
      // superadmin 短路（内置超管永远全权）
      if (user.role === 'superadmin' && !(user.customRole || user.custom_role)) return true;
      const perms = (role.permissions || {})[module];
      if (!perms || !perms[action]) return false;
      // 仓库范围：'all' 或显式包含
      if (ctx && ctx.warehouseId) {
        const scope = role.warehouseScope || 'all';
        if (scope !== 'all' && !(Array.isArray(scope) && scope.includes(ctx.warehouseId))) return false;
      }
      return true;
    }

    /** 列出所有角色：内置 + DB 自定义（含引用计数） */
    async function listRoles() {
      const [rows] = await pool.execute('SELECT id, data FROM roles');
      const custom = rows.map(r => {
        try { return { ...JSON.parse(r.data), id: r.id }; } catch { return { id: r.id, name: r.id, permissions: {} }; }
      });
      // 引用计数（哪些自定义角色正被用户使用）
      const [usage] = await pool.execute('SELECT custom_role, COUNT(*) as c FROM users WHERE custom_role IS NOT NULL GROUP BY custom_role');
      const usageMap = Object.fromEntries(usage.map(u => [u.custom_role, u.c]));
      for (const r of custom) r.userCount = usageMap[r.id] || 0;
      return [...Object.values(BUILTIN_ROLES), ...custom];
    }

    return { can, getRole, listRoles, invalidateCache };
  },
};
