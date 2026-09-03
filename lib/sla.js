/**
 * lib/sla.js
 * SLA (Service Level Agreement) 引擎 — 纯函数，无副作用
 *
 * 职责：
 *   - computeDeadlines(priority, createdAt, config) → { slaRespondBy, slaResolveBy }
 *   - isBreached(ticket, now) → { breached, reason }
 *   - getDefaultConfig() → 默认 SLA 配置
 *
 * 配置格式（存 settings 表 skey='tech_support_sla_config'）：
 *   {
 *     "P0": { "respondMinutes": 15,  "resolveMinutes": 240 },
 *     "P1": { "respondMinutes": 60,  "resolveMinutes": 480 },
 *     "P2": { "respondMinutes": 240, "resolveMinutes": 1440 },
 *     "P3": { "respondMinutes": 1440,"resolveMinutes": 4320 },
 *     "autoCloseDays": 7
 *   }
 */
'use strict';

const DEFAULT_CONFIG = {
  P0: { respondMinutes: 15,   resolveMinutes: 240  },
  P1: { respondMinutes: 60,   resolveMinutes: 480  },
  P2: { respondMinutes: 240,  resolveMinutes: 1440 },
  P3: { respondMinutes: 1440, resolveMinutes: 4320 },
  autoCloseDays: 7,
};

function getDefaultConfig() {
  // 深拷贝避免外部修改默认配置
  return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
}

/**
 * 根据 priority 和创建时间计算 SLA 截止时间
 * @param {string} priority - 'P0'|'P1'|'P2'|'P3'
 * @param {string|Date} createdAt - 工单创建时间（ISO 字符串或 Date 对象）
 * @param {object} config - SLA 配置（缺省用 DEFAULT_CONFIG）
 * @returns {{slaRespondBy: string, slaResolveBy: string}} ISO 字符串截止时间
 */
function computeDeadlines(priority, createdAt, config) {
  const cfg = config || DEFAULT_CONFIG;
  const level = cfg[priority] || cfg.P2;
  const created = createdAt instanceof Date ? createdAt : new Date(createdAt);
  const respondMs = (level.respondMinutes || 240) * 60 * 1000;
  const resolveMs = (level.resolveMinutes || 1440) * 60 * 1000;
  return {
    slaRespondBy: new Date(created.getTime() + respondMs).toISOString(),
    slaResolveBy: new Date(created.getTime() + resolveMs).toISOString(),
  };
}

/**
 * 判断工单是否 SLA 超时
 * @param {object} ticket - 工单对象，需含 slaRespondBy/slaResolveBy/respondedAt/status
 * @param {Date|string} now - 当前时间（可选，默认 new Date()）
 * @returns {{breached: boolean, reason: string|null}} 是否超时及原因
 */
function isBreached(ticket, now) {
  const t = now ? (now instanceof Date ? now : new Date(now)) : new Date();
  // 仅未关闭工单检查超时（resolved/closed 不再算超时）
  const activeStatuses = ['open', 'assigned', 'in_progress', 'reopened'];
  if (!activeStatuses.includes(ticket.status)) {
    return { breached: false, reason: null };
  }
  // 响应超时：超过 slaRespondBy 且尚未响应
  if (ticket.slaRespondBy && !ticket.respondedAt) {
    if (t.getTime() >= new Date(ticket.slaRespondBy).getTime()) {
      return { breached: true, reason: 'response_overdue' };
    }
  }
  // 解决超时：超过 slaResolveBy
  if (ticket.slaResolveBy) {
    if (t.getTime() >= new Date(ticket.slaResolveBy).getTime()) {
      return { breached: true, reason: 'resolution_overdue' };
    }
  }
  return { breached: false, reason: null };
}

/**
 * 判断工单是否即将超时（warning 阈值，默认提前 10%）
 * @param {object} ticket
 * @param {Date|string} now
 * @param {number} warningRatio - 提前预警比例（0-1，默认 0.1 = 提前 10%）
 * @returns {{warning: boolean, type: string|null}}
 */
function isWarning(ticket, now, warningRatio) {
  const t = now ? (now instanceof Date ? now : new Date(now)) : new Date();
  const ratio = warningRatio !== undefined ? warningRatio : 0.1;
  const activeStatuses = ['open', 'assigned', 'in_progress', 'reopened'];
  if (!activeStatuses.includes(ticket.status)) {
    return { warning: false, type: null };
  }
  if (ticket.slaRespondBy && !ticket.respondedAt) {
    const deadline = new Date(ticket.slaRespondBy).getTime();
    const created = new Date(ticket.submittedAt || ticket.createdAt).getTime();
    const total = deadline - created;
    const warningAt = deadline - total * ratio;
    if (t.getTime() >= warningAt && t.getTime() < deadline) {
      return { warning: true, type: 'response_warning' };
    }
  }
  if (ticket.slaResolveBy) {
    const deadline = new Date(ticket.slaResolveBy).getTime();
    const created = new Date(ticket.submittedAt || ticket.createdAt).getTime();
    const total = deadline - created;
    const warningAt = deadline - total * ratio;
    if (t.getTime() >= warningAt && t.getTime() < deadline) {
      return { warning: true, type: 'resolution_warning' };
    }
  }
  return { warning: false, type: null };
}

module.exports = {
  computeDeadlines,
  isBreached,
  isWarning,
  getDefaultConfig,
  DEFAULT_CONFIG,
};
