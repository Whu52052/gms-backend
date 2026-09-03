// HTTP 层：移植自 js/api.js
// - 请求自动带 credentials: 'same-origin'（HttpOnly gms_token cookie 认证）
// - 非 GET 请求注入 X-CSRF-Token；CSRF 403 自动重新获取令牌并重试一次
// - 401 触发全局认证错误事件（gms_auth_error），由上层弹出重新登录提示

export class ApiError extends Error {
  status: number;
  data: any;
  constructor(message: string, status: number, data?: any) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

let csrfToken: string | null = null;
let csrfRefreshTimer: ReturnType<typeof setTimeout> | null = null;
let authErrorHandled = false;

export function getCsrfToken() {
  return csrfToken;
}

function withTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  const onAbort = () => ctrl.abort();
  if (signal) {
    if (signal.aborted) ctrl.abort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  ctrl.signal.addEventListener('abort', () => clearTimeout(timer), { once: true });
  return ctrl.signal;
}

async function rawFetch(url: string, options: RequestInit = {}, timeoutMs = 15000): Promise<Response> {
  const opts: RequestInit = { credentials: 'same-origin', ...options, signal: withTimeout(options.signal ?? undefined, timeoutMs) };
  return fetch(url, opts);
}

function injectCsrf(options: RequestInit, token: string | null): RequestInit {
  const method = (options.method || 'GET').toUpperCase();
  if (token && method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
    return { ...options, headers: { ...(options.headers as Record<string, string> || {}), 'X-CSRF-Token': token } };
  }
  return options;
}

async function isCsrfReject(resp: Response | null): Promise<boolean> {
  if (!resp || resp.status !== 403) return false;
  try {
    const data = await resp.clone().json();
    return !!(data && typeof data.error === 'string' && data.error.indexOf('CSRF') >= 0);
  } catch {
    return false;
  }
}

/** 从 /api/csrf-token 获取 CSRF 令牌（内存保存，55 分钟自动续期） */
export async function fetchCsrfToken(): Promise<void> {
  try {
    const res = await rawFetch('/api/csrf-token', { method: 'GET' }, 5000);
    if (res.ok) {
      const data = await res.json();
      if (data.csrfToken) {
        csrfToken = data.csrfToken;
        if (csrfRefreshTimer) clearTimeout(csrfRefreshTimer);
        csrfRefreshTimer = setTimeout(() => fetchCsrfToken(), 55 * 60 * 1000);
      }
    }
  } catch (e) {
    console.warn('[http] Failed to fetch CSRF token:', (e as Error).message);
  }
}

export function clearCsrfToken() {
  csrfToken = null;
  if (csrfRefreshTimer) {
    clearTimeout(csrfRefreshTimer);
    csrfRefreshTimer = null;
  }
}

/** 触发全局认证错误（30 秒内去重） */
export function emitAuthError() {
  if (authErrorHandled) return;
  authErrorHandled = true;
  window.dispatchEvent(new CustomEvent('gms_auth_error', { detail: { reason: 'token_expired' } }));
  setTimeout(() => { authErrorHandled = false; }, 30000);
}

/**
 * 通用 JSON 请求。失败时抛出 ApiError（401 同时触发认证错误事件）。
 * silent 模式下 401 不派发 gms_auth_error —— 供登录前的探测类请求使用（会话校验/登录本身），
 * 避免首次打开页面时因无有效 cookie 误弹“登录状态已过期”。
 */
export async function http<T = any>(method: string, path: string, body?: any, timeoutMs = 15000, silent = false): Promise<T> {
  const options: RequestInit = { method };
  if (body !== undefined) {
    options.headers = { 'Content-Type': 'application/json' };
    options.body = JSON.stringify(body);
  }
  let res = await rawFetch(path, injectCsrf(options, csrfToken), timeoutMs);
  // CSRF 403 自动恢复：重新获取令牌后重试一次
  if (await isCsrfReject(res)) {
    await fetchCsrfToken();
    if (csrfToken) res = await rawFetch(path, injectCsrf(options, csrfToken), timeoutMs);
  }
  if (res.status === 401) {
    if (!silent) emitAuthError();
    throw new ApiError('登录状态已过期', 401);
  }
  let data: any = null;
  try {
    data = await res.json();
  } catch { /* 无 JSON 响应体 */ }
  if (!res.ok) {
    throw new ApiError(data?.error || data?.message || `请求失败（${res.status}）`, res.status, data);
  }
  return data as T;
}

export const get = <T = any>(path: string, timeoutMs?: number, silent?: boolean) => http<T>('GET', path, undefined, timeoutMs, silent);
export const post = <T = any>(path: string, body?: any, timeoutMs?: number, silent?: boolean) => http<T>('POST', path, body, timeoutMs, silent);
export const put = <T = any>(path: string, body?: any, timeoutMs?: number) => http<T>('PUT', path, body, timeoutMs);
export const del = <T = any>(path: string, timeoutMs?: number) => http<T>('DELETE', path, undefined, timeoutMs);

/** 服务器健康检查（2 次重试） */
export async function checkServer(): Promise<boolean> {
  for (let i = 0; i < 2; i++) {
    try {
      const res = await rawFetch('/api/health', {}, 3000);
      if (res.ok) return true;
    } catch { /* retry */ }
    if (i < 1) await new Promise(r => setTimeout(r, 500));
  }
  return false;
}
