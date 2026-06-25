#!/usr/bin/env node
/**
 * GMS Service Watcher - 崩溃自动恢复监控守护进程
 *
 * 功能：
 * 1. 24小时监控MySQL连接池状态
 * 2. 监控服务是否可访问（健康检查 + 登录接口测试）
 * 3. 连接池耗尽检测与自动恢复
 * 4. 分级告警与自动恢复策略
 * 5. 进程级自动重启（配合PM2）
 *
 * 使用方法：
 *   node watcher.js
 *   或配合PM2: pm2 start watcher.js --name gms-watcher
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

// ==================== 配置 ====================
const CONFIG = {
  checkInterval: 15000,
  healthCheckTimeout: 8000,
  loginTestTimeout: 10000,

  targets: process.env.WATCHER_TARGETS
    ? process.env.WATCHER_TARGETS.split(',').map(s => s.trim())
    : ['http://127.0.0.1:8765', 'http://127.0.0.1:8766', 'http://127.0.0.1:8767'],

  testUsername: process.env.WATCHER_TEST_USER || 'admin',
  testPassword: process.env.WATCHER_TEST_PASS || '',

  poolUsageWarning: 75,
  poolUsageCritical: 90,
  poolUsageRestartThreshold: 95,

  maxConsecutiveFailures: 3,
  restartCooldown: 60000,

  logDir: process.env.WATCHER_LOG_DIR || path.join(__dirname, 'logs'),
  logRetentionDays: 7,

  pm2AppNames: process.env.WATCHER_PM2_APPS
    ? process.env.WATCHER_PM2_APPS.split(',').map(s => s.trim())
    : ['yunwei-1', 'yunwei-2', 'yunwei-3'],

  enableAutoRestart: process.env.WATCHER_AUTO_RESTART !== 'false',
  enableMysqlCheck: process.env.WATCHER_MYSQL_CHECK !== 'false',

  mysqlHost: process.env.DB_HOST || process.env.MYSQL_HOST || '127.0.0.1',
  mysqlPort: parseInt(process.env.DB_PORT || process.env.MYSQL_PORT || '3306'),
  mysqlUser: process.env.DB_USER || process.env.MYSQL_USER || 'root',
  mysqlPassword: process.env.DB_PASSWORD || process.env.MYSQL_PASSWORD || '',
  mysqlDatabase: process.env.DB_NAME || process.env.MYSQL_DATABASE || 'gms',
};

// ==================== 日志系统 ====================
function ensureLogDir() {
  if (!fs.existsSync(CONFIG.logDir)) {
    fs.mkdirSync(CONFIG.logDir, { recursive: true });
  }
}

function getLogFile() {
  const date = new Date().toISOString().slice(0, 10);
  return path.join(CONFIG.logDir, `watcher-${date}.log`);
}

function log(level, message, data) {
  const timestamp = new Date().toISOString();
  const prefix = `[${timestamp}] [${level.toUpperCase()}]`;
  const line = data ? `${prefix} ${message} ${JSON.stringify(data)}` : `${prefix} ${message}`;

  console.log(line);

  try {
    ensureLogDir();
    fs.appendFileSync(getLogFile(), line + '\n');
  } catch (e) {
    // ignore log write errors
  }
}

function rotateLogs() {
  try {
    ensureLogDir();
    const files = fs.readdirSync(CONFIG.logDir)
      .filter(f => f.startsWith('watcher-') && f.endsWith('.log'));

    const cutoff = Date.now() - CONFIG.logRetentionDays * 24 * 60 * 60 * 1000;

    files.forEach(f => {
      const match = f.match(/watcher-(\d{4}-\d{2}-\d{2})\.log/);
      if (match) {
        const fileDate = new Date(match[1]).getTime();
        if (fileDate < cutoff) {
          fs.unlinkSync(path.join(CONFIG.logDir, f));
          log('info', `Rotated old log file: ${f}`);
        }
      }
    });
  } catch (e) {
    log('warn', `Log rotation failed: ${e.message}`);
  }
}

// ==================== HTTP 请求工具 ====================
function httpRequest(url, options = {}) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const lib = urlObj.protocol === 'https:' ? https : http;

    const reqOptions = {
      hostname: urlObj.hostname,
      port: urlObj.port,
      path: urlObj.pathname + urlObj.search,
      method: options.method || 'GET',
      timeout: options.timeout || CONFIG.healthCheckTimeout,
      headers: options.headers || {},
    };

    const req = lib.request(reqOptions, (res) => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        try {
          const json = body ? JSON.parse(body) : {};
          resolve({ status: res.statusCode, body: json, rawBody: body });
        } catch (e) {
          resolve({ status: res.statusCode, body: null, rawBody: body });
        }
      });
    });

    req.on('error', (err) => reject(err));
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });

    if (options.body) {
      const bodyStr = JSON.stringify(options.body);
      req.setHeader('Content-Type', 'application/json');
      req.setHeader('Content-Length', Buffer.byteLength(bodyStr));
      req.write(bodyStr);
    }

    req.end();
  });
}

// ==================== MySQL 直接检测 ====================
let mysqlLib = null;
function loadMysqlLib() {
  if (mysqlLib) return mysqlLib;
  try {
    mysqlLib = require('mysql2/promise');
    return mysqlLib;
  } catch (e) {
    log('warn', `mysql2 not available, skipping direct MySQL checks: ${e.message}`);
    return null;
  }
}

async function checkMysqlDirect() {
  if (!CONFIG.enableMysqlCheck) return { available: true, skipped: true };

  const mysql = loadMysqlLib();
  if (!mysql) return { available: true, skipped: true };

  let conn = null;
  try {
    const startTime = Date.now();
    conn = await mysql.createConnection({
      host: CONFIG.mysqlHost,
      port: CONFIG.mysqlPort,
      user: CONFIG.mysqlUser,
      password: CONFIG.mysqlPassword,
      database: CONFIG.mysqlDatabase,
      connectTimeout: 10000,
    });

    const [rows] = await conn.execute('SELECT 1 as test');
    const latency = Date.now() - startTime;

    let poolInfo = null;
    try {
      const [procRows] = await conn.execute(
        "SELECT COUNT(*) as active FROM information_schema.processlist WHERE db = ?",
        [CONFIG.mysqlDatabase]
      );
      poolInfo = { activeConnections: procRows[0].active };
    } catch {}

    return { available: true, latency, poolInfo };
  } catch (e) {
    return { available: false, error: e.message };
  } finally {
    if (conn) { try { await conn.end(); } catch {} }
  }
}

// ==================== 服务健康检查 ====================
async function checkServiceHealth(target) {
  const startTime = Date.now();
  try {
    const res = await httpRequest(`${target}/api/health`, {
      timeout: CONFIG.healthCheckTimeout,
    });
    const latency = Date.now() - startTime;

    if (res.status !== 200) {
      return {
        target,
        healthy: false,
        reason: `HTTP status ${res.status}`,
        latency,
      };
    }

    const body = res.body;
    const poolUsage = body?.database?.connectionLimit
      ? (body.database.activeConnections / body.database.connectionLimit) * 100
      : 0;

    return {
      target,
      healthy: body?.status === 'ok',
      status: body?.status,
      latency,
      uptime: body?.uptime,
      database: body?.database,
      poolUsagePercent: poolUsage,
      memory: body?.memory,
    };
  } catch (e) {
    return {
      target,
      healthy: false,
      reason: e.message,
      latency: Date.now() - startTime,
    };
  }
}

// ==================== 登录接口测试 ====================
async function checkLoginEndpoint(target) {
  if (!CONFIG.testPassword) {
    return { target, ok: true, skipped: true, reason: 'No test password configured' };
  }

  const startTime = Date.now();
  try {
    const res = await httpRequest(`${target}/api/auth/login`, {
      method: 'POST',
      timeout: CONFIG.loginTestTimeout,
      body: { username: CONFIG.testUsername, password: CONFIG.testPassword },
    });
    const latency = Date.now() - startTime;

    if (res.status === 200 && res.body?.token) {
      return { target, ok: true, latency, userId: res.body.user?.id };
    }

    if (res.status === 401) {
      return { target, ok: true, latency, note: 'Invalid credentials (expected), endpoint responding' };
    }

    return {
      target,
      ok: false,
      latency,
      status: res.status,
      error: res.body?.error || `HTTP ${res.status}`,
    };
  } catch (e) {
    return { target, ok: false, latency: Date.now() - startTime, error: e.message };
  }
}

// ==================== 自动恢复：PM2重启 ====================
const restartState = {
  lastRestartTime: 0,
  restartCount: 0,
  consecutiveRestarts: 0,
};

async function restartPm2Apps(reason) {
  if (!CONFIG.enableAutoRestart) {
    log('warn', `Auto-restart disabled, would restart for: ${reason}`);
    return { executed: false, reason: 'disabled' };
  }

  const now = Date.now();
  if (now - restartState.lastRestartTime < CONFIG.restartCooldown) {
    log('warn', `Restart cooldown active, skipping restart for: ${reason}`);
    return { executed: false, reason: 'cooldown' };
  }

  restartState.lastRestartTime = now;
  restartState.restartCount++;
  restartState.consecutiveRestarts++;

  log('warn', `Initiating PM2 restart: ${reason}`, {
    restartCount: restartState.restartCount,
    consecutiveRestarts: restartState.consecutiveRestarts,
    apps: CONFIG.pm2AppNames,
  });

  try {
    const results = [];
    for (const appName of CONFIG.pm2AppNames) {
      try {
        await new Promise((resolve, reject) => {
          exec(`pm2 restart ${appName}`, { timeout: 30000 }, (err, stdout, stderr) => {
            if (err) reject(err);
            else resolve({ stdout, stderr });
          });
        });
        results.push({ app: appName, success: true });
        log('info', `Restarted PM2 app: ${appName}`);
      } catch (e) {
        results.push({ app: appName, success: false, error: e.message });
        log('error', `Failed to restart PM2 app ${appName}: ${e.message}`);
      }
    }

    log('info', 'PM2 restart sequence completed', { results });
    return { executed: true, results };
  } catch (e) {
    log('error', `PM2 restart failed: ${e.message}`);
    return { executed: false, error: e.message };
  }
}

function resetConsecutiveRestarts() {
  if (restartState.consecutiveRestarts > 0) {
    log('info', `Service recovered, reset consecutive restart counter (was: ${restartState.consecutiveRestarts})`);
    restartState.consecutiveRestarts = 0;
  }
}

// ==================== 告警系统 ====================
const alertState = {
  lastAlertByKey: {},
  alertSuppressionMs: 5 * 60 * 1000,
};

function shouldAlert(key) {
  const now = Date.now();
  const last = alertState.lastAlertByKey[key] || 0;
  if (now - last < alertState.alertSuppressionMs) return false;
  alertState.lastAlertByKey[key] = now;
  return true;
}

function sendAlert(level, message, data) {
  const key = `${level}:${message}`;
  if (!shouldAlert(key)) return;

  log(`alert_${level}`, message, data);

  // TODO: 可扩展：接入飞书/钉钉/企业微信/邮件告警
  // 目前写入告警日志，可由外部日志系统采集
  try {
    ensureLogDir();
    const alertLog = path.join(CONFIG.logDir, 'alerts.log');
    const line = `[${new Date().toISOString()}] [${level.toUpperCase()}] ${message} ${data ? JSON.stringify(data) : ''}\n`;
    fs.appendFileSync(alertLog, line);
  } catch {}
}

// ==================== 主监控循环 ====================
const targetStates = {};

CONFIG.targets.forEach(t => {
  targetStates[t] = {
    consecutiveFailures: 0,
    lastSuccess: 0,
    lastFailure: null,
    poolWarningTriggered: false,
    poolCriticalTriggered: false,
  };
});

async function runCheckCycle() {
  log('debug', 'Starting check cycle');

  // 1. MySQL直连检测
  const mysqlCheck = await checkMysqlDirect();
  if (!mysqlCheck.available && !mysqlCheck.skipped) {
    log('error', `MySQL direct check FAILED: ${mysqlCheck.error}`);
    sendAlert('critical', 'MySQL数据库连接失败', mysqlCheck);
  } else if (mysqlCheck.available && !mysqlCheck.skipped) {
    log('debug', `MySQL direct check OK (${mysqlCheck.latency}ms)`, mysqlCheck.poolInfo);
  }

  // 2. 逐个检测目标服务
  const results = [];
  let allHealthy = true;
  let anyCritical = false;

  for (const target of CONFIG.targets) {
    const state = targetStates[target];

    // 2a. 健康检查
    const health = await checkServiceHealth(target);
    log('debug', `Health check ${target}: ${health.healthy ? 'OK' : 'FAIL'}`, {
      latency: health.latency,
      poolUsage: health.poolUsagePercent?.toFixed(1) + '%',
    });

    // 2b. 登录接口测试
    const login = await checkLoginEndpoint(target);
    if (login.ok && !login.skipped) {
      log('debug', `Login check ${target}: OK (${login.latency}ms)`);
    } else if (!login.ok) {
      log('warn', `Login check ${target}: FAIL - ${login.error}`);
    }

    // 2c. 状态评估
    const serviceHealthy = health.healthy && login.ok;

    if (serviceHealthy) {
      state.consecutiveFailures = 0;
      state.lastSuccess = Date.now();
      state.lastFailure = null;
      state.poolWarningTriggered = false;
      state.poolCriticalTriggered = false;
    } else {
      allHealthy = false;
      state.consecutiveFailures++;
      state.lastFailure = health.reason || login.error || 'unknown';
      log('warn', `Target ${target} unhealthy (consecutive: ${state.consecutiveFailures}): ${state.lastFailure}`);

      if (state.consecutiveFailures >= CONFIG.maxConsecutiveFailures) {
        anyCritical = true;
        sendAlert('critical', `服务连续失败 ${state.consecutiveFailures} 次: ${target}`, {
          reason: state.lastFailure,
          consecutiveFailures: state.consecutiveFailures,
        });
      }
    }

    // 2d. 连接池使用率告警
    if (health.poolUsagePercent !== undefined) {
      const usage = health.poolUsagePercent;

      if (usage >= CONFIG.poolUsageRestartThreshold && !state.poolCriticalTriggered) {
        state.poolCriticalTriggered = true;
        log('error', `Pool usage CRITICAL on ${target}: ${usage.toFixed(1)}%`, health.database);
        sendAlert('critical', `MySQL连接池使用率超过${CONFIG.poolUsageRestartThreshold}%: ${target}`, {
          usage: usage.toFixed(1) + '%',
          database: health.database,
        });
      } else if (usage >= CONFIG.poolUsageCritical && !state.poolCriticalTriggered) {
        state.poolCriticalTriggered = true;
        log('warn', `Pool usage critical on ${target}: ${usage.toFixed(1)}%`, health.database);
        sendAlert('warning', `MySQL连接池使用率超过${CONFIG.poolUsageCritical}%: ${target}`, {
          usage: usage.toFixed(1) + '%',
          database: health.database,
        });
      } else if (usage >= CONFIG.poolUsageWarning && !state.poolWarningTriggered) {
        state.poolWarningTriggered = true;
        log('warn', `Pool usage warning on ${target}: ${usage.toFixed(1)}%`, health.database);
        sendAlert('warning', `MySQL连接池使用率超过${CONFIG.poolUsageWarning}%: ${target}`, {
          usage: usage.toFixed(1) + '%',
          database: health.database,
        });
      }
    }

    results.push({ target, health, login, healthy: serviceHealthy });
  }

  // 3. 全局恢复决策
  if (allHealthy) {
    resetConsecutiveRestarts();
    log('debug', 'All targets healthy');
  } else if (anyCritical) {
    const criticalTargets = Object.entries(targetStates)
      .filter(([_, s]) => s.consecutiveFailures >= CONFIG.maxConsecutiveFailures)
      .map(([t, _]) => t);

    if (criticalTargets.length > 0) {
      log('error', `Critical failure detected, triggering restart for ${criticalTargets.length} targets`, {
        criticalTargets,
      });
      await restartPm2Apps(`Critical failure on: ${criticalTargets.join(', ')}`);
    }
  }

  // 4. 连接池严重超限时也尝试重启
  const poolCriticalTargets = Object.entries(targetStates)
    .filter(([t, s]) => s.poolCriticalTriggered)
    .map(([t, _]) => t);

  if (poolCriticalTargets.length >= CONFIG.targets.length) {
    log('warn', 'All targets have critical pool usage, triggering restart');
    await restartPm2Apps(`All targets pool usage critical`);
  }

  log('debug', 'Check cycle completed', {
    total: results.length,
    healthy: results.filter(r => r.healthy).length,
    unhealthy: results.filter(r => !r.healthy).length,
  });
}

// ==================== 启动 ====================
function printBanner() {
  console.log('');
  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║       GMS Service Watcher v1.0                  ║');
  console.log('║       崩溃自动恢复 / 连接池监控 / 24h守护        ║');
  console.log('╚══════════════════════════════════════════════════╝');
  console.log('');
  log('info', 'Watcher starting up', {
    targets: CONFIG.targets,
    checkInterval: CONFIG.checkInterval + 'ms',
    autoRestart: CONFIG.enableAutoRestart,
    mysqlCheck: CONFIG.enableMysqlCheck,
    pm2Apps: CONFIG.pm2AppNames,
    logDir: CONFIG.logDir,
  });
}

function start() {
  printBanner();
  rotateLogs();

  setInterval(runCheckCycle, CONFIG.checkInterval);
  runCheckCycle().catch(e => log('error', `Initial check failed: ${e.message}`));

  setInterval(rotateLogs, 60 * 60 * 1000);

  process.on('uncaughtException', (err) => {
    log('error', `Uncaught exception: ${err.message}`, { stack: err.stack });
  });

  process.on('unhandledRejection', (reason) => {
    log('error', `Unhandled rejection: ${reason}`);
  });

  log('info', 'Watcher is running. Press Ctrl+C to stop.');
}

if (require.main === module) {
  start();
}

module.exports = {
  CONFIG,
  checkServiceHealth,
  checkLoginEndpoint,
  checkMysqlDirect,
  restartPm2Apps,
  runCheckCycle,
};
