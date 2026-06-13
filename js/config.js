/**
 * Server discovery �?overrides window.location.origin in production
 * Set this to your CloudBase 云托�?service URL when deploying.
 * Leave empty for local development (falls back to same-origin).
 */
// 部署时改为你的 Render 域名，例如 'https://xxx.onrender.com'
// 留空则自动使用同源地址（推荐 Render 部署时留空）
window.__GMS_SERVER_URL__ = '';
