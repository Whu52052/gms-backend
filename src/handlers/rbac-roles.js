/**
 * src/handlers/rbac-roles.js
 * 角色权限管理域（Phase 1 企业级基座）
 *
 * Handlers in this domain (URL → handler):
 *   GET    /api/permissions          → handleGetPermissions （权限点注册表，admin+）
 *   GET    /api/roles                → handleGetRoles       （admin+，含引用计数）
 *   POST   /api/roles                → handleCreateRole     （superadmin）
 *   PUT    /api/roles/:id            → handleUpdateRole     （superadmin）
 *   DELETE /api/roles/:id            → handleDeleteRole     （superadmin，内置/在用不可删）
 *
 * 角色定义（roles 表 data JSON）：
 *   { id, name, system, permissions: {module: {action: bool}},
 *     warehouseScope: 'all' | ['main', ...], isBuiltIn: false, createdBy, createdAt }
 *
 * Deps: pool, sendJSON, rbac, broadcastChange, invalidateUserTokens
 */
'use strict';

const { PERMISSION_MODULES } = require('../../lib/rbac');

module.exports = function createRoleHandlers(deps) {
  const { pool, sendJSON, rbac, broadcastChange, invalidateUserTokens } = deps;

  // 权限矩阵合法性校验：未知模块/动作一律剔除
  function _sanitizePermissions(raw) {
    const out = {};
    if (!raw || typeof raw !== 'object') return out;
    for (const [mod, actions] of Object.entries(raw)) {
      if (!PERMISSION_MODULES[mod] || !actions || typeof actions !== 'object') continue;
      out[mod] = {};
      for (const a of PERMISSION_MODULES[mod].actions) {
        out[mod][a] = !!(actions[a] === true || actions[a] === 'true');
      }
    }
    return out;
  }

  function _sanitizeScope(raw) {
    if (raw === 'all' || !raw) return 'all';
    if (Array.isArray(raw)) {
      const list = raw.map(String).filter(Boolean);
      return list.length ? list : 'all';
    }
    return 'all';
  }

  async function handleGetPermissions(req, res, user) {
    if (user.role !== 'admin' && user.role !== 'superadmin') return sendJSON(res, { error: '无权限查看' }, 403);
    sendJSON(res, PERMISSION_MODULES);
  }

  async function handleGetRoles(req, res, user) {
    if (user.role !== 'admin' && user.role !== 'superadmin') return sendJSON(res, { error: '无权限查看' }, 403);
    sendJSON(res, await rbac.listRoles());
  }

  async function handleCreateRole(req, res, user, body) {
    if (user.role !== 'superadmin') return sendJSON(res, { error: '仅超级管理员可创建角色' }, 403);
    const { id, name, system, permissions, warehouseScope } = body || {};
    const roleId = String(id || '').trim();
    if (!roleId || !name) return sendJSON(res, { error: '请填写角色ID和名称' }, 400);
    if (!/^[a-zA-Z0-9_-]{1,32}$/.test(roleId)) return sendJSON(res, { error: '角色ID只能包含字母、数字、下划线和短横线（最长32字符）' }, 400);
    const [dup] = await pool.execute('SELECT id FROM roles WHERE id = ?', [roleId]);
    if (dup.length > 0) return sendJSON(res, { error: `角色ID ${roleId} 已存在` }, 400);
    const perms = _sanitizePermissions(permissions);
    if (Object.keys(perms).length === 0) return sendJSON(res, { error: '请至少勾选一项权限' }, 400);
    const now = new Date().toISOString();
    const role = {
      id: roleId, name, system: system || user.system || 'maintenance',
      permissions: perms, warehouseScope: _sanitizeScope(warehouseScope),
      isBuiltIn: false, createdBy: user.username, createdAt: now,
    };
    await pool.execute('INSERT INTO roles (id, name, `system`, is_built_in, data) VALUES (?, ?, ?, 0, ?)',
      [roleId, name, role.system, JSON.stringify(role)]);
    rbac.invalidateCache();
    broadcastChange('roles', [], { id: roleId });
    sendJSON(res, { success: true, role });
  }

  async function handleUpdateRole(req, res, user, roleId, body) {
    if (user.role !== 'superadmin') return sendJSON(res, { error: '仅超级管理员可修改角色' }, 403);
    const [rows] = await pool.execute('SELECT * FROM roles WHERE id = ?', [roleId]);
    if (rows.length === 0) return sendJSON(res, { error: '角色不存在' }, 404);
    let old;
    try { old = JSON.parse(rows[0].data); } catch { old = {}; }
    const { name, permissions, warehouseScope } = body || {};
    const perms = permissions !== undefined ? _sanitizePermissions(permissions) : (old.permissions || {});
    if (Object.keys(perms).length === 0) return sendJSON(res, { error: '请至少勾选一项权限' }, 400);
    const role = {
      ...old, id: roleId,
      name: name || old.name || roleId,
      permissions: perms,
      warehouseScope: warehouseScope !== undefined ? _sanitizeScope(warehouseScope) : (old.warehouseScope || 'all'),
      updatedAt: new Date().toISOString(),
    };
    await pool.execute('UPDATE roles SET name = ?, `system` = ?, data = ? WHERE id = ?',
      [role.name, rows[0].system || role.system, JSON.stringify(role), roleId]);
    rbac.invalidateCache();
    // 权限变更立即生效：踢掉使用该角色的用户 token，强制重新登录拿新权限
    const [users] = await pool.execute('SELECT id FROM users WHERE custom_role = ?', [roleId]);
    for (const u of users) { try { await invalidateUserTokens(u.id); } catch {} }
    broadcastChange('roles', ['users'], { id: roleId });
    sendJSON(res, { success: true, role });
  }

  async function handleDeleteRole(req, res, user, roleId) {
    if (user.role !== 'superadmin') return sendJSON(res, { error: '仅超级管理员可删除角色' }, 403);
    const [rows] = await pool.execute('SELECT * FROM roles WHERE id = ?', [roleId]);
    if (rows.length === 0) return sendJSON(res, { error: '角色不存在' }, 404);
    const [inUse] = await pool.execute('SELECT COUNT(*) as c FROM users WHERE custom_role = ?', [roleId]);
    if (inUse[0].c > 0) return sendJSON(res, { error: `该角色正在被 ${inUse[0].c} 个用户使用，请先解除分配` }, 400);
    await pool.execute('DELETE FROM roles WHERE id = ?', [roleId]);
    rbac.invalidateCache();
    broadcastChange('roles', [], { id: roleId });
    sendJSON(res, { success: true });
  }

  return { handleGetPermissions, handleGetRoles, handleCreateRole, handleUpdateRole, handleDeleteRole };
};
