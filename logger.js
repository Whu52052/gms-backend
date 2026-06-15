/**
 * ===================================================================
 *  Yunwei Structured Logger — 结构化 JSON 日志系统
 *
 *  功能:
 *    - JSON 格式输出 (便于 ELK/Loki 采集)
 *    - 日志级别: DEBUG/INFO/WARN/ERROR/FATAL
 *    - 自动轮转 (按日期 + 大小)
 *    - 请求追踪 (requestId 贯穿整个请求生命周期)
 *    - 性能监控 (慢请求自动告警)
 *    - 审计日志分离存储
 * ===================================================================
 */

const fs = require('fs');
const path = require('path');

const LOG_DIR = process.env.LOG_DIR || path.join(__dirname, 'logs');
const LOG_LEVELS = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3, FATAL: 4 };
const LOG_LEVEL = LOG_LEVELS[process.env.LOG_LEVEL || 'INFO'] || 1;
const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB 轮转
const MAX_FILES = 10;                      // 保留最近10个日志文件

// 确保日志目录存在
try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch {}

// ==================== LOG ROTATION ====================
let currentLogFile = '';
let currentLogSize = 0;
let logStream = null;

function _getLogFile(type) {
  const date = new Date().toISOString().slice(0, 10);
  return path.join(LOG_DIR, `yunwei-${type}-${date}.log`);
}

function _rotateIfNeeded(type) {
  const targetFile = _getLogFile(type);
  if (targetFile !== currentLogFile || currentLogSize > MAX_FILE_SIZE) {
    if (logStream) { logStream.end(); logStream = null; }

    // 清理旧文件
    try {
      const files = fs.readdirSync(LOG_DIR)
        .filter(f => f.startsWith(`yunwei-${type}-`))
        .sort()
        .reverse();
      for (let i = MAX_FILES; i < files.length; i++) {
        fs.unlinkSync(path.join(LOG_DIR, files[i]));
      }
    } catch {}

    currentLogFile = targetFile;
    currentLogSize = 0;
    try {
      currentLogSize = fs.statSync(currentLogFile).size;
    } catch {}
    logStream = fs.createWriteStream(currentLogFile, { flags: 'a' });
  }
}

// ==================== REQUEST ID ====================
const { AsyncLocalStorage } = require('async_hooks');
const requestContext = new AsyncLocalStorage();

/** 为每个请求生成唯一 ID */
function generateRequestId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}-${process.env.pm_id || '0'}`;
}

/** 获取当前请求 ID */
function getRequestId() {
  const ctx = requestContext.getStore();
  return ctx?.requestId || 'background';
}

/** 运行带 requestId 的上下文 */
function runWithRequestId(requestId, fn) {
  return requestContext.run({ requestId }, fn);
}

// ==================== CORE LOGGING ====================
function _log(level, message, meta = {}) {
  if (LOG_LEVELS[level] < LOG_LEVEL) return;

  const timestamp = new Date().toISOString();
  const workerId = process.env.pm_id || '0';
  const requestId = getRequestId();

  const entry = {
    ts: timestamp,
    level,
    worker: workerId,
    reqId: requestId,
    msg: message,
    ...meta,
  };

  // 控制台输出
  const colorMap = { DEBUG: '\x1b[90m', INFO: '\x1b[36m', WARN: '\x1b[33m', ERROR: '\x1b[31m', FATAL: '\x1b[35m' };
  const prefix = `${timestamp} [${workerId}] [${requestId.slice(0, 8)}] ${level.padEnd(5)}`;
  console.log(`${colorMap[level] || ''}${prefix}\x1b[0m ${message}`);

  // 文件输出
  const type = level === 'ERROR' || level === 'FATAL' ? 'error' : 'app';
  _rotateIfNeeded(type);
  if (logStream) {
    const line = JSON.stringify(entry) + '\n';
    logStream.write(line);
    currentLogSize += line.length;
  }

  // Fatal: 写入 error log 后退出
  if (level === 'FATAL') {
    if (logStream) logStream.end();
    process.nextTick(() => process.exit(1));
  }
}

const logger = {
  debug: (msg, meta) => _log('DEBUG', msg, meta),
  info: (msg, meta) => _log('INFO', msg, meta),
  warn: (msg, meta) => _log('WARN', msg, meta),
  error: (msg, meta) => _log('ERROR', msg, meta),
  fatal: (msg, meta) => _log('FATAL', msg, meta),
};

// ==================== HTTP REQUEST LOGGER ====================
/**
 * Express/HTTP 请求日志中间件
 * 自动记录: 请求开始/结束、耗时、状态码、慢请求告警
 */
function requestLogger(req, res, startTime) {
  const method = req.method;
  const url = req.url;
  const userAgent = (req.headers['user-agent'] || '').slice(0, 100);
  const ip = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown';

  return {
    start: () => {
      logger.info(`${method} ${url}`, { type: 'request_start', method, url, ip, ua: userAgent });
    },
    end: (statusCode, bodySize) => {
      const duration = Date.now() - startTime;
      const level = duration > 3000 ? 'WARN' : duration > 5000 ? 'ERROR' : 'INFO';
      _log(level, `${method} ${url} → ${statusCode} (${duration}ms)`, {
        type: 'request_end', method, url, status: statusCode,
        duration, bodySize, ip,
      });

      // 慢请求告警 (>3秒)
      if (duration > 3000) {
        _log('WARN', `SLOW REQUEST: ${method} ${url} took ${duration}ms`, {
          type: 'slow_request', method, url, duration, status: statusCode,
        });
      }
    },
  };
}

// ==================== AUDIT LOG ====================
/**
 * 审计日志 (独立存储, 不可删除)
 * 记录所有敏感操作: 登录/登出/增删改/导出
 */
async function auditLog(action, user, detail = {}) {
  const entry = {
    ts: new Date().toISOString(),
    action,                  // 'login' | 'logout' | 'create' | 'update' | 'delete' | 'export'
    userId: user?.userId || 'system',
    username: user?.username || 'system',
    ip: detail.ip || 'unknown',
    resource: detail.resource || '',
    resourceId: detail.resourceId || '',
    changes: detail.changes || null,
    result: detail.result || 'success',
  };

  const type = 'audit';
  _rotateIfNeeded(type);
  if (logStream) {
    const line = JSON.stringify(entry) + '\n';
    logStream.write(line);
    currentLogSize += line.length;
  }

  // 同时写入独立的审计日志文件
  try {
    const auditFile = _getLogFile('audit');
    fs.appendFileSync(auditFile, JSON.stringify(entry) + '\n');
  } catch {}
}

// ==================== PERFORMANCE PROFILER ====================
/**
 * 性能分析装饰器
 * 自动记录函数执行时间
 */
function profile(name, fn) {
  return async function (...args) {
    const start = Date.now();
    try {
      return await fn.apply(this, args);
    } finally {
      const duration = Date.now() - start;
      if (duration > 1000) {
        logger.warn(`SLOW FUNC: ${name} took ${duration}ms`, {
          type: 'slow_function', func: name, duration,
        });
      }
    }
  };
}

// ==================== FLUSH & SHUTDOWN ====================
function flush() {
  return new Promise((resolve) => {
    if (logStream) logStream.end(resolve);
    else resolve();
  });
}

module.exports = {
  logger,
  requestLogger,
  auditLog,
  profile,
  generateRequestId,
  getRequestId,
  runWithRequestId,
  flush,
  LOG_DIR,
};
