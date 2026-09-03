/**
 * publish.js — 将 web/dist 构建产物发布到仓库根目录
 *
 * 步骤：
 *   1. 校验 web/dist 存在（先执行 npm run build）
 *   2. 覆盖根目录 index.html / operations.html
 *   3. 同步 assets/：先清理根目录 assets 中不再存在于新产物的旧哈希文件，再拷入新文件
 *   4. 更新根目录 sw.js 的 APP_SHELL 缓存清单与 SW_VERSION（保证 PWA 离线壳与产物一致）
 *
 * 用法：node scripts/publish.js（在 web/ 目录下，或 package.json 的 publish:root）
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const webDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distDir = path.join(webDir, 'dist');
const rootDir = path.resolve(webDir, '..');

function fail(msg) {
  console.error(`[publish] ✗ ${msg}`);
  process.exit(1);
}

// ---------- 1. 校验 ----------
if (!fs.existsSync(path.join(distDir, 'index.html')) || !fs.existsSync(path.join(distDir, 'operations.html'))) {
  fail('web/dist 缺少 index.html/operations.html，请先执行 npm run build');
}

// ---------- 2. 覆盖入口 HTML ----------
for (const f of ['index.html', 'operations.html']) {
  fs.copyFileSync(path.join(distDir, f), path.join(rootDir, f));
  console.log(`[publish] ✓ ${f}`);
}

// ---------- 3. 同步 assets/ ----------
const distAssets = path.join(distDir, 'assets');
const rootAssets = path.join(rootDir, 'assets');
if (!fs.existsSync(distAssets)) fail('web/dist/assets 不存在');
if (!fs.existsSync(rootAssets)) fs.mkdirSync(rootAssets, { recursive: true });

const distFiles = new Set(fs.readdirSync(distAssets));
// 清理旧哈希产物（只清理构建产物类型，避免误删手动放入的资源）
let removed = 0;
for (const f of fs.readdirSync(rootAssets)) {
  if (!distFiles.has(f) && /\.(js|css|map)$/.test(f)) {
    fs.rmSync(path.join(rootAssets, f));
    removed++;
  }
}
for (const f of distFiles) {
  fs.copyFileSync(path.join(distAssets, f), path.join(rootAssets, f));
}
console.log(`[publish] ✓ assets/（新增/覆盖 ${distFiles.size} 个，清理旧文件 ${removed} 个）`);

// ---------- 4. 更新 sw.js 缓存清单 ----------
const swPath = path.join(rootDir, 'sw.js');
if (fs.existsSync(swPath)) {
  let sw = fs.readFileSync(swPath, 'utf8');

  // App Shell = 入口文档 + 固定资源 + 当前构建的全部 assets
  const shell = [
    '/',
    '/index.html',
    '/operations.html',
    '/manifest.json',
    '/icons/icon-192.png',
    '/icons/icon-512.png',
    ...[...distFiles].sort().map(f => `/assets/${f}`),
  ];
  const shellBlock = `const APP_SHELL = [\n${shell.map(u => `  '${u}',`).join('\n')}\n];`;
  if (!/const APP_SHELL = \[[\s\S]*?\];/.test(sw)) fail('sw.js 中未找到 APP_SHELL 数组');
  sw = sw.replace(/const APP_SHELL = \[[\s\S]*?\];/, shellBlock);

  // 版本号带时间戳，强制旧 SW 更新
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
  if (!/const SW_VERSION = '[^']*';/.test(sw)) fail('sw.js 中未找到 SW_VERSION');
  sw = sw.replace(/const SW_VERSION = '[^']*';/, `const SW_VERSION = 'v2.${stamp}';`);

  fs.writeFileSync(swPath, sw);
  console.log(`[publish] ✓ sw.js（APP_SHELL ${shell.length} 项，SW_VERSION=v2.${stamp}）`);
} else {
  console.warn('[publish] ⚠ 未找到根目录 sw.js，跳过缓存清单更新');
}

console.log('[publish] 完成。注意：后端静态文件有内存缓存，上线需重启服务生效。');
