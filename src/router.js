/**
 * Lightweight Router (Phase 2.1 step8) + S3 validation middleware
 *
 * 渐进式收编 server.js 中的 if-chain 路由分发。
 *
 * Design goals:
 *  1. Zero-dependency, zero-framework — plain factory returning a dispatch() fn
 *  2. Preserves strict evaluation order of the original if-chain
 *  3. Supports both static exact-match (Map lookup, O(1)) and regex (linear scan)
 *  4. Auth / body parsing gated per-route, matching original semantics:
 *     - `auth: 'none'`     → no auth gate, handler called without authUser arg
 *     - `auth: 'required'` → server must have verified auth before dispatch
 *     - `body: true`       → server must have parsed body before dispatch
 *  5. dispatch() returns true if a route matched (server should `return`),
 *     false otherwise so the legacy if-chain fallback runs.
 *  6. S3: optional `validate:{body,query}` schema — fails 400 on bad input,
 *     replaces body/query with cleaned value when validation passes.
 *
 * Typical server usage:
 *   const router = createRouter({ sendJSON });
 *   // Phase 2.1 modular routes:
 *   router.register('/api/auth/login', 'POST', auth.handleLogin, { auth:'none', body:true });
 *   router.registerPattern(/^\/api\/users\/([^/]+)$/, 'POST', users.handleUpdateUser, { auth:'required', body:true, params:1 });
 *   // S3: with validation
 *   router.register('/api/auth/login', 'POST', auth.handleLogin, {
 *     auth:'none', body:true,
 *     validate: { body: { username:{type:'string',required:true,max:64,regex:/^[a-zA-Z0-9_-]+/}, password:{type:'string',required:true,min:6,max:128} } }
 *   });
 *   // in request handler, after auth+body parse:
 *   if (router.dispatch(req, res, url, authUser, body)) return;
 *   // ... legacy if-chain for non-migrated routes ...
 */
'use strict';

module.exports = function createRouter(deps = {}) {
  // S3: optional sendJSON injection so router can fail-fast with 400 on validation error.
  // If not provided, validation errors throw (caller should wrap in try/catch).
  const sendJSON = deps.sendJSON;

  // static routes: key = `${METHOD} ${PATHNAME}` → route entry
  const staticRoutes = new Map();
  // pattern routes, insertion order preserved
  const patternRoutes = [];

  function _handlerKey(method, path) {
    return `${method.toUpperCase()} ${path}`;
  }

  /**
   * Register an exact-match route.
   * @param {string} path - exact url.pathname, e.g. '/api/tech-support'
   * @param {string} method - HTTP method, case-insensitive
   * @param {Function} handler - async (req, res, [authUser], [body], [param1,...]) => any
   * @param {object} opts
   * @param {'none'|'required'} opts.auth - whether auth is required
   * @param {boolean} opts.body - whether body is required
   * @param {object} [opts.validate] - S3 validation schema: { body?, query? }
   */
  function register(path, method, handler, opts = {}) {
    const key = _handlerKey(method, path);
    if (staticRoutes.has(key)) {
      throw new Error(`[Router] Duplicate static route: ${key}`);
    }
    staticRoutes.set(key, {
      handler,
      auth: opts.auth || 'none',
      body: !!opts.body,
      validate: opts.validate || null,
    });
  }

  /**
   * Register a regex-pattern route.
   * @param {RegExp} pattern - regex to match url.pathname; capturing groups become params
   * @param {string} method - HTTP method, case-insensitive
   * @param {Function} handler - async (req, res, [authUser], [body], capture1, capture2, ...)
   * @param {object} opts - same as register()
   */
  function registerPattern(pattern, method, handler, opts = {}) {
    if (!(pattern instanceof RegExp)) {
      throw new Error(`[Router] registerPattern expects RegExp, got ${typeof pattern}`);
    }
    patternRoutes.push({
      pattern,
      method: method.toUpperCase(),
      handler,
      auth: opts.auth || 'none',
      body: !!opts.body,
      validate: opts.validate || null,
    });
  }

  /**
   * Try to dispatch a request against registered routes.
   * @returns {boolean} true if matched (handler was invoked), false otherwise
   */
  function dispatch(req, res, url, authUser, body) {
    const method = req.method || 'GET';
    const pathname = url.pathname;

    // ---- 1) Static exact match ----
    const staticKey = `${method} ${pathname}`;
    const sr = staticRoutes.get(staticKey);
    if (sr) {
      _invoke(sr, req, res, url, authUser, body, []);
      return true;
    }

    // ---- 2) Pattern match (insertion order) ----
    for (const pr of patternRoutes) {
      if (pr.method !== method) continue;
      const m = pathname.match(pr.pattern);
      if (m) {
        const captures = m.slice(1);
        _invoke(pr, req, res, url, authUser, body, captures);
        return true;
      }
    }

    return false;
  }

  /**
   * S3: validate body/query against schema; mutate in place if valid.
   * @returns {{ok:boolean, error:?string, body?:object, query?:object}}
   */
  function _runValidation(entry, req, res, url, body) {
    if (!entry.validate) return { ok: true, body, query: null };
    const result = { ok: true, body, query: null };

    if (entry.validate.body) {
      const { validate } = require('../lib/validate');
      const r = validate(body, entry.validate.body);
      if (!r.ok) {
        return { ok: false, error: r.errors[0].msg };
      }
      result.body = r.value;
    }

    if (entry.validate.query) {
      const { validate } = require('../lib/validate');
      // url.query is a URLSearchParams — convert to plain object (string values)
      const queryObj = {};
      if (url.searchParams) {
        for (const [k, v] of url.searchParams.entries()) queryObj[k] = v;
      }
      const r = validate(queryObj, entry.validate.query);
      if (!r.ok) {
        return { ok: false, error: r.errors[0].msg };
      }
      result.query = r.value;
    }

    return result;
  }

  function _invoke(entry, req, res, url, authUser, body, captures) {
    // S3: validation gate (before handler). Mutates body to cleaned value if valid.
    if (entry.validate) {
      const v = _runValidation(entry, req, res, url, body);
      if (!v.ok) {
        const err = v.error || '请求参数无效';
        if (sendJSON) {
          sendJSON(res, { error: err }, 400, req);
        } else {
          // No sendJSON injected — write minimal 400 response
          try {
            if (!res.headersSent) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: err }));
            }
          } catch {}
        }
        return;
      }
      body = v.body;
    }

    // Build argument list matching handler signatures:
    //   Pattern: captures (path params) ALWAYS come before body
    //   (req, res, [authUser], [capture1, capture2, ...], [body])
    const args = [req, res];
    if (entry.auth === 'required') {
      args.push(authUser);
    }
    args.push(...captures);
    if (entry.body) {
      args.push(body);
    }

    // Call handler; any rejection bubbles to server's global unhandledRejection guard
    const result = entry.handler.apply(null, args);
    if (result && typeof result.then === 'function') {
      result.catch(e => {
        console.error('[Router] Unhandled handler error:', e.message);
        try {
          if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: '服务器内部错误' }));
          }
        } catch {}
      });
    }
  }

  function size() {
    return { static: staticRoutes.size, pattern: patternRoutes.length, total: staticRoutes.size + patternRoutes.length };
  }

  return { register, registerPattern, dispatch, size };
};
