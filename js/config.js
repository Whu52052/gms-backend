/**
 * Server discovery �?overrides window.location.origin in production
 * Set this to your CloudBase 云托�?service URL when deploying.
 * Leave empty for local development (falls back to same-origin).
 */
// 当前公网地址（留空 = 自动使用当前域名）
window.__GMS_SERVER_URL__ = '';
