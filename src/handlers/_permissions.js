/**
 * src/handlers/_permissions.js
 * Shared permission-check helpers — consolidates the repeated
 * `if (user.role !== 'admin' && user.role !== 'superadmin')` pattern
 * found across all handler files.
 *
 * Usage:
 *   const { requireAdmin, requireSuperadmin, canManageUser } = require('./_permissions');
 *   if (!requireAdmin(user, res, sendJSON)) return;
 */
'use strict';

/**
 * Check if user is admin or superadmin.
 * Returns true if authorized; otherwise sends 403 and returns false.
 */
function requireAdmin(user, res, sendJSON, errorMsg) {
  if (user.role !== 'admin' && user.role !== 'superadmin') {
    sendJSON(res, { error: errorMsg || '无权限' }, 403);
    return false;
  }
  return true;
}

/**
 * Check if user is superadmin.
 * Returns true if authorized; otherwise sends 403 and returns false.
 */
function requireSuperadmin(user, res, sendJSON, errorMsg) {
  if (user.role !== 'superadmin') {
    sendJSON(res, { error: errorMsg || '仅超级管理员可执行此操作' }, 403);
    return false;
  }
  return true;
}

/**
 * Check if the acting user can manage the target user (same-system rule).
 * Returns true if allowed; otherwise sends 403 and returns false.
 */
function canManageTarget(user, target) {
  return target && (target.system || 'maintenance') === (user.system || 'maintenance');
}

/**
 * Full admin check: must be admin/superadmin AND (if target provided) same-system.
 */
function requireAdminForTarget(user, res, sendJSON, target, errorMsg) {
  if (!requireAdmin(user, res, sendJSON, errorMsg)) return false;
  if (target && !canManageTarget(user, target)) {
    sendJSON(res, { error: '只能操作本系统内用户' }, 403);
    return false;
  }
  return true;
}

/**
 * Check if user is admin or superadmin (boolean, no response sent).
 * Used as a quick write-permission guard in factory-pattern handlers.
 */
/**
 * Tech-support responder check:
 *   maintenance system users OR operations admins OR superadmin.
 */
function requireTechResponder(user, res, sendJSON, errorMsg) {
  var ok = (user.system === 'maintenance') ||
           (user.system === 'operations' && user.role === 'admin') ||
           user.role === 'superadmin';
  if (!ok) {
    sendJSON(res, { error: errorMsg || '仅运维人员或运营管理员可执行此操作' }, 403);
    return false;
  }
  return true;
}

/**
 * Tech-support admin check (delete):
 *   (maintenance admin/superadmin) OR (operations admin) OR superadmin.
 */
function requireTechAdmin(user, res, sendJSON, errorMsg) {
  var ok = (user.system === 'maintenance' && (user.role === 'admin' || user.role === 'superadmin')) ||
           (user.system === 'operations' && user.role === 'admin') ||
           user.role === 'superadmin';
  if (!ok) {
    sendJSON(res, { error: errorMsg || '仅运维系统或运营系统管理员可执行此操作' }, 403);
    return false;
  }
  return true;
}

function canWrite(user) {
  return user.role === 'admin' || user.role === 'superadmin';
}

module.exports = {
  requireAdmin,
  requireSuperadmin,
  canManageTarget,
  requireAdminForTarget,
  requireTechResponder,
  requireTechAdmin,
  canWrite,
};
