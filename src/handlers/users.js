/**
 * src/handlers/users.js
 * User-management domain HTTP handlers — extracted from server.js (Phase 2.1 step2).
 *
 * Same factory / dependency-injection pattern as src/handlers/auth.js:
 * server.js calls createUsersHandlers(deps) AFTER pool is ready, then route
 * dispatch calls users.handleXxx(...). Handler bodies are copied verbatim; the
 * factory scope destructures deps so bare identifiers (pool / tokens /
 * hashPassword / ...) resolve to the injected values.
 *
 * Handlers in this domain (URL → handler):
 *   GET    /api/users                       → handleGetUsers
 *   POST   /api/users                       → handleAddUser
 *   PUT    /api/users/:id                    → handleUpdateUser
 *   DELETE /api/users/:id                    → handleDeleteUser
 *   GET    /api/users/subordinates           → handleGetSubordinates
 *   GET    /api/online-users                → handleGetOnlineUsers
 *   POST   /api/force-logout/:id            → handleForceLogout
 *   POST   /api/users/:id/promote           → handlePromoteUser
 *   POST   /api/users/:id/toggle-status     → handleToggleUserStatus
 *
 * Deps (subset of auth's): pool, tokens, saveTokens, hashPassword,
 * encryptPassword, invalidateUserTokens, sendJSON, broadcastSSE.
 */
'use strict';

const { lookupIpLocation } = require('../../lib/ip-geo');
const { requireAdmin, canManageTarget } = require('./_permissions');

module.exports = function createUsersHandlers(deps) {
  const {
    pool,
    tokens,
    saveTokens,
    hashPassword,
    encryptPassword,
    invalidateUserTokens,
    sendJSON,
    broadcastSSE,
    // IP-to-place-name resolution for profile display
    redisClient,
  } = deps;

  // ==================== USER MANAGEMENT HANDLERS ====================

  async function handleForceLogout(req, res, user, targetUserId) {
    if (!requireAdmin(user, res, sendJSON)) return;
    const [target] = await pool.execute('SELECT id, `system` FROM users WHERE id = ?', [targetUserId]);
    if (target.length === 0) return sendJSON(res, { error: '用户不存在' }, 404);
    if (!canManageTarget(user, target[0])) return sendJSON(res, { error: '只能操作本系统内用户' }, 403);
    await invalidateUserTokens(targetUserId);
    saveTokens();
    broadcastSSE('users_updated', {});
    sendJSON(res, { success: true });
  }

  async function handleGetUsers(req, res, user) {
    if (!requireAdmin(user, res, sendJSON)) return;
    const [allUsers] = await pool.execute('SELECT * FROM users LIMIT 5000');
    // Everyone only sees users in their own system (运营 ↔ 运维 隔离)
    let users = allUsers.filter(u => (u.system || 'maintenance') === user.system);
    if (user.role === 'admin') {
      // Admin only sees their own subordinates (via parentId or createdBy)
      users = users.filter(u => u.id === user.userId || u.parentId === user.userId || u.createdBy === user.userId);
    }
    // Superadmin sees all users within their own system
    const onlineIds = new Set();
    Object.values(tokens).forEach(t => { if (t.expires > Date.now()) onlineIds.add(t.userId); });
    sendJSON(res, users.map(u => ({ id: u.id, username: u.username, displayName: u.displayName || u.username, role: u.role, system: u.system || 'maintenance', status: u.status || 'active', parentId: u.parentId || null, customRole: u.custom_role || null, createdAt: u.createdAt, online: onlineIds.has(u.id) })));
  }

  async function handleAddUser(req, res, user, body) {
    if (!requireAdmin(user, res, sendJSON, '无权限添加用户')) return;
    const { username, password, role, system, displayName } = body;
    if (!username || !password) return sendJSON(res, { error: '请输入用户名和密码' }, 400);
    if (user.role === 'admin' && role === 'admin') return sendJSON(res, { error: '管理员只能创建普通用户' }, 403);
    if (role === 'superadmin') return sendJSON(res, { error: '无法创建超级管理员账户' }, 403);
    if (system && system !== user.system) return sendJSON(res, { error: '只能创建本系统用户' }, 403);
    const [existing] = await pool.execute('SELECT id FROM users WHERE username = ?', [username]);
    if (existing.length > 0) return sendJSON(res, { error: '用户名已存在' }, 400);
    const id = `u-${  Date.now().toString(36)}`;
    const userSystem = system || user.system || 'maintenance';
    // When admin creates a user, set parentId to establish hierarchy
    const parentId = (user.role === 'admin' || user.role === 'superadmin') ? user.userId : null;
    // S6: hashPassword is now async scrypt
    const passwordHash = await hashPassword(password);
    await pool.execute(
      'INSERT INTO users (id, username, passwordHash, encryptedPassword, role, `system`, displayName, createdBy, parentId, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [id, username, passwordHash, encryptPassword(password), role || 'user', userSystem, displayName || username, user.userId, parentId, new Date().toISOString()]
    );
    broadcastSSE('users_updated', {});
    sendJSON(res, { success: true, user: { id, username, displayName: displayName || username, role: role || 'user', system: userSystem, parentId } });
  }

  async function handleDeleteUser(req, res, user, userId) {
    if (!requireAdmin(user, res, sendJSON, '无权限删除用户')) return;
    const [target] = await pool.execute('SELECT * FROM users WHERE id = ?', [userId]);
    if (target.length === 0) return sendJSON(res, { error: '用户不存在' }, 404);
    if (!canManageTarget(user, target[0])) return sendJSON(res, { error: '只能操作本系统内用户' }, 403);
    if (target[0].role === 'superadmin') return sendJSON(res, { error: '无法删除超级管理员' }, 403);
    if (user.role === 'admin' && target[0].role === 'admin') return sendJSON(res, { error: '管理员无法删除其他管理员' }, 403);
    if (user.userId === userId) return sendJSON(res, { error: '无法删除自己' }, 400);
    await pool.execute('DELETE FROM users WHERE id = ?', [userId]);
    await invalidateUserTokens(userId);
    saveTokens();
    broadcastSSE('users_updated', {});
    sendJSON(res, { success: true });
  }

  async function handleUpdateUser(req, res, user, userId, body) {
    const { username, password } = body;
    if (!username || !username.trim()) return sendJSON(res, { error: '用户名不能为空' }, 400);

    const [target] = await pool.execute('SELECT * FROM users WHERE id = ?', [userId]);
    if (target.length === 0) return sendJSON(res, { error: '用户不存在' }, 404);
    const targetUser = target[0];

    const isSelf = user.userId === userId;
    const isAdmin = user.role === 'admin';
    const isSuper = user.role === 'superadmin';

    if (!isSelf && !isAdmin && !isSuper) return sendJSON(res, { error: '无权限修改该账户' }, 403);
    if (!isSelf && !canManageTarget(user, targetUser)) return sendJSON(res, { error: '只能操作本系统内用户' }, 403);
    if (!isSelf && isAdmin && targetUser.role === 'admin') return sendJSON(res, { error: '管理员无法修改其他管理员' }, 403);
    if (!isSelf && isAdmin && targetUser.role === 'superadmin') return sendJSON(res, { error: '无权限修改超级管理员' }, 403);
    // Admin can only modify their own group members (subordinates)
    if (!isSelf && isAdmin && targetUser.role === 'user') {
      if (targetUser.parentId !== user.userId && targetUser.createdBy !== user.userId) {
        return sendJSON(res, { error: '只能修改自己组员的账户' }, 403);
      }
    }
    // Superadmin: same-system only, cannot modify other superadmins
    if (!isSelf && isSuper) {
      if (targetUser.role === 'superadmin') return sendJSON(res, { error: '无法修改其他超级管理员' }, 403);
      if (targetUser.system !== user.system) return sendJSON(res, { error: '只能修改本系统内的用户' }, 403);
    }

    const [dup] = await pool.execute('SELECT id FROM users WHERE username = ? AND id != ?', [username.trim(), userId]);
    if (dup.length > 0) return sendJSON(res, { error: '用户名已存在' }, 400);

    if (password && password.trim()) {
      // S6: hashPassword is now async scrypt
      const passwordHash = await hashPassword(password.trim());
      await pool.execute('UPDATE users SET username = ?, passwordHash = ?, encryptedPassword = ? WHERE id = ?', [username.trim(), passwordHash, encryptPassword(password.trim()), userId]);
    } else {
      await pool.execute('UPDATE users SET username = ? WHERE id = ?', [username.trim(), userId]);
    }

    // Phase 1 RBAC：自定义角色分配（仅 superadmin 可分配；变更后强制重新登录以刷新 token 内权限）
    if ('customRole' in (body || {})) {
      if (user.role !== 'superadmin') return sendJSON(res, { error: '仅超级管理员可分配自定义角色' }, 403);
      const newRole = body.customRole || null;
      if (newRole) {
        const [roleRows] = await pool.execute('SELECT id FROM roles WHERE id = ?', [newRole]);
        if (roleRows.length === 0) return sendJSON(res, { error: `角色 ${newRole} 不存在` }, 400);
      }
      await pool.execute('UPDATE users SET custom_role = ? WHERE id = ?', [newRole, userId]);
      await invalidateUserTokens(userId);
      saveTokens();
    }

    if (isSelf) {
      Object.values(tokens).forEach(t => { if (t.userId === userId) t.username = username.trim(); });
      saveTokens();
    }

    broadcastSSE('users_updated', {});
    sendJSON(res, { success: true, message: '修改成功' });
  }

  function handleGetOnlineUsers(req, res, user) {
    if (!requireAdmin(user, res, sendJSON)) return;
    const online = [], seen = new Set();
    Object.values(tokens).forEach(t => {
      if (t.expires > Date.now() && (t.system || 'maintenance') === (user.system || 'maintenance') && !seen.has(t.userId)) { seen.add(t.userId); online.push({ userId: t.userId, username: t.username, role: t.role }); }
    });
    sendJSON(res, online);
  }

  async function handleGetSubordinates(req, res, user) {
    if (!requireAdmin(user, res, sendJSON)) return;
    const [allUsers] = await pool.execute('SELECT * FROM users WHERE (parentId = ? OR createdBy = ?) AND `system` = ?', [user.userId, user.userId, user.system]);
    const onlineIds = new Set();
    Object.values(tokens).forEach(t => { if (t.expires > Date.now()) onlineIds.add(t.userId); });
    sendJSON(res, allUsers.map(u => ({ id: u.id, username: u.username, role: u.role, system: u.system || 'maintenance', parentId: u.parentId || null, createdAt: u.createdAt, online: onlineIds.has(u.id) })));
  }

  async function handlePromoteUser(req, res, user, userId) {
    // Only superadmin can promote users to admin
    if (user.role !== 'superadmin') return sendJSON(res, { error: '仅超级管理员可执行晋升操作' }, 403);
    const [target] = await pool.execute('SELECT * FROM users WHERE id = ?', [userId]);
    if (target.length === 0) return sendJSON(res, { error: '用户不存在' }, 404);
    if (target[0].system !== user.system) return sendJSON(res, { error: '只能操作本系统内用户' }, 403);
    if (target[0].role === 'superadmin') return sendJSON(res, { error: '无法修改超级管理员角色' }, 403);
    if (target[0].role === 'admin') {
      // Demote to user
      await pool.execute('UPDATE users SET role = ? WHERE id = ?', ['user', userId]);
      broadcastSSE('users_updated', {});
      return sendJSON(res, { success: true, message: '已降级为普通用户', newRole: 'user' });
    }
    // Promote to admin
    await pool.execute('UPDATE users SET role = ? WHERE id = ?', ['admin', userId]);
    broadcastSSE('users_updated', {});
    sendJSON(res, { success: true, message: '已晋升为管理员', newRole: 'admin' });
  }

  async function handleToggleUserStatus(req, res, authUser, userId) {
    if (authUser.role !== 'admin' && authUser.role !== 'superadmin') return sendJSON(res, { error: '仅管理员可执行此操作' }, 403);
    const [target] = await pool.execute('SELECT * FROM users WHERE id = ?', [userId]);
    if (target.length === 0) return sendJSON(res, { error: '用户不存在' }, 404);
    if (target[0].system !== authUser.system) return sendJSON(res, { error: '只能操作本系统内用户' }, 403);
    if (target[0].role === 'superadmin') return sendJSON(res, { error: '无法禁用超级管理员' }, 403);
    if (authUser.role === 'admin' && target[0].role === 'admin') return sendJSON(res, { error: '管理员无法禁用其他管理员' }, 403);
    const currentStatus = target[0].status || 'active';
    const newStatus = currentStatus === 'disabled' ? 'active' : 'disabled';
    await pool.execute('UPDATE users SET status = ? WHERE id = ?', [newStatus, userId]);
    // If disabled, invalidate all their tokens (force logout)
    if (newStatus === 'disabled') {
      await invalidateUserTokens(userId);
      saveTokens();
    }
    broadcastSSE('users_updated', {});
    sendJSON(res, { success: true, status: newStatus, message: newStatus === 'disabled' ? '已禁用' : '已启用' });
  }

  // ==================== PROFILE / PERSONAL CENTER ====================

  async function handleGetMyProfile(req, res, user) {
    const [rows] = await pool.execute(
      'SELECT id, username, displayName, role, `system`, status, email, phone, department, createdAt, updatedAt, lastLoginAt, lastIp FROM users WHERE id = ?',
      [user.userId]
    );
    if (rows.length === 0) return sendJSON(res, { error: '用户不存在' }, 404);
    const u = rows[0];
    // Resolve the raw IP to a Chinese place-name (e.g. "中国 北京市 北京市").
    // lookupIpLocation uses Redis + in-memory caching so repeated profile views
    // never trigger a second network round-trip.
    const lastIpLocation = u.lastIp ? await lookupIpLocation(u.lastIp, redisClient) : '';
    sendJSON(res, {
      id: u.id,
      username: u.username,
      displayName: u.displayName || u.username,
      role: u.role,
      system: u.system || 'maintenance',
      status: u.status || 'active',
      email: u.email || '',
      phone: u.phone || '',
      department: u.department || '',
      createdAt: u.createdAt,
      lastLogin: u.lastLoginAt,
      lastIp: u.lastIp || '',
      lastIpLocation,
    });
  }

  async function handleUpdateMyProfile(req, res, user, body) {
    const updates = [];
    const values = [];
    const allowed = ['displayName', 'email', 'phone', 'department'];
    for (const k of allowed) {
      if (body && k in body) { updates.push(`${k} = ?`); values.push(body[k]); }
    }
    if (updates.length === 0) return sendJSON(res, { error: '无字段可更新' }, 400);
    updates.push('updatedAt = ?');
    values.push(new Date().toISOString());
    values.push(user.userId);
    await pool.execute(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`, values);
    broadcastSSE('users_updated', {});
    sendJSON(res, { success: true });
  }

  async function handleGetMyActivity(req, res, user) {
    // Personal audit trail — recent actions for this user only.
    // audit_log table stores JSON in `data` MEDIUMTEXT — extract user-relevant entries.
    const url = new URL(req.url, 'http://localhost');
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '100', 10) || 100, 500);
    const fetchLimit = limit * 5;
    const [rows] = await pool.execute(
      `SELECT id, data FROM audit_log ORDER BY id DESC LIMIT ${fetchLimit}`
    );
    const items = [];
    for (const r of rows) {
      let d;
      try { d = typeof r.data === 'string' ? JSON.parse(r.data) : r.data; } catch { continue; }
      if (!d || !d.user) continue;
      if (d.user !== user.username) continue;
      items.push({
        id: r.id,
        action: d.action || 'unknown',
        detail: d.detail || d.message || d.note || '',
        ip: d.ip || '',
        time: d.timestamp || d.time || d.createdAt || r.id,
        user: d.user,
      });
      if (items.length >= limit) break;
    }
    sendJSON(res, { items, count: items.length });
  }

  return {
    handleForceLogout,
    handleGetUsers,
    handleAddUser,
    handleDeleteUser,
    handleUpdateUser,
    handleGetOnlineUsers,
    handleGetSubordinates,
    handlePromoteUser,
    handleToggleUserStatus,
    handleGetMyProfile,
    handleUpdateMyProfile,
    handleGetMyActivity,
  };
};
