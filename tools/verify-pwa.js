#!/usr/bin/env node
/**
 * tools/verify-pwa.js
 * PWA 配置验证脚本
 *
 * 检查项：
 *   1. manifest.json 格式和必填字段
 *   2. sw.js 是否存在且语法正确
 *   3. 图标文件是否存在
 *   4. HTML 是否引用了 manifest
 *   5. HTML 是否注册了 service worker
 *
 * 用法：node tools/verify-pwa.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;

function ok(msg) { console.log(`  ✅ ${msg}`); pass++; }
function err(msg) { console.log(`  ❌ ${msg}`); fail++; }
function info(msg) { console.log(`  ℹ️  ${msg}`); }

console.log('🔍 PWA 配置验证\n');

// ===== 1. manifest.json =====
console.log('1. Manifest 检查');
const manifestPath = path.join(ROOT, 'manifest.json');
if (!fs.existsSync(manifestPath)) {
  err('manifest.json 不存在');
} else {
  try {
    const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    ok('manifest.json 存在且 JSON 格式正确');

    const required = ['name', 'short_name', 'start_url', 'display', 'icons', 'theme_color'];
    required.forEach(field => {
      if (m[field]) ok(`  ${field}: ${typeof m[field] === 'object' ? '[...]' : m[field]}`);
      else err(`  缺少必填字段: ${field}`);
    });

    if (m.display === 'standalone') ok('  display=standalone (PWA 模式)');
    else err(`  display 应为 "standalone"，当前: "${m.display}"`);

    if (m.icons && m.icons.length >= 2) ok(`  图标数量: ${m.icons.length}`);
    else err('  至少需要 2 个图标 (192+512)');

    if (m.icons && m.icons.some(i => i.purpose?.includes('maskable'))) {
      ok('  包含 maskable 图标');
    } else err('  缺少 maskable 图标');
  } catch (e) {
    err(`manifest.json 解析失败: ${e.message}`);
  }
}

// ===== 2. Service Worker =====
console.log('\n2. Service Worker 检查');
const swPath = path.join(ROOT, 'sw.js');
if (!fs.existsSync(swPath)) {
  err('sw.js 不存在');
} else {
  ok('sw.js 存在');
  const swContent = fs.readFileSync(swPath, 'utf8');
  const features = [
    ['install', 'install 事件'],
    ['activate', 'activate 事件'],
    ['fetch', 'fetch 事件（缓存策略）'],
    ['push', 'push 事件（推送通知）'],
    ['notificationclick', '通知点击处理'],
    ['sync', '后台同步'],
  ];
  features.forEach(([kw, desc]) => {
    if (swContent.includes(kw)) ok(`  ${desc}`);
    else err(`  缺少 ${desc}`);
  });
}

// ===== 3. 图标文件 =====
console.log('\n3. 图标文件检查');
const icons = ['icon-192.png', 'icon-512.png', 'maskable-192.png', 'maskable-512.png'];
icons.forEach(name => {
  const p = path.join(ROOT, 'icons', name);
  if (fs.existsSync(p)) {
    const size = fs.statSync(p).size;
    if (size > 100) ok(`  icons/${name} (${size} bytes)`);
    else err(`  icons/${name} 文件过小 (${size} bytes)`);
  } else err(`  icons/${name} 不存在`);
});

// ===== 4. HTML 引用 manifest =====
console.log('\n4. HTML 集成检查');
['index.html', 'operations.html'].forEach(htmlFile => {
  const p = path.join(ROOT, htmlFile);
  if (!fs.existsSync(p)) { info(`${htmlFile} 不存在，跳过`); return; }
  const content = fs.readFileSync(p, 'utf8');

  if (content.includes('rel="manifest"')) ok(`  ${htmlFile}: 引用了 manifest`);
  else err(`  ${htmlFile}: 缺少 <link rel="manifest">`);

  if (content.includes('theme-color')) ok(`  ${htmlFile}: 设置了 theme-color`);
  else err(`  ${htmlFile}: 缺少 <meta name="theme-color">`);

  if (content.includes('serviceWorker.register')) ok(`  ${htmlFile}: 注册了 service worker`);
  else err(`  ${htmlFile}: 缺少 service worker 注册代码`);

  if (content.includes('apple-mobile-web-app-capable')) ok(`  ${htmlFile}: iOS PWA 支持`);
  else err(`  ${htmlFile}: 缺少 apple-mobile-web-app-capable`);
});

// ===== 5. 后端推送配置 =====
console.log('\n5. 后端推送检查');
const envPath = path.join(ROOT, '.env');
if (fs.existsSync(envPath)) {
  const env = fs.readFileSync(envPath, 'utf8');
  if (env.includes('VAPID_PUBLIC_KEY')) ok('.env: VAPID_PUBLIC_KEY 已配置');
  else err('.env: 缺少 VAPID_PUBLIC_KEY');
  if (env.includes('VAPID_PRIVATE_KEY')) ok('.env: VAPID_PRIVATE_KEY 已配置');
  else err('.env: 缺少 VAPID_PRIVATE_KEY');
}

const pushHandlerPath = path.join(ROOT, 'src', 'handlers', 'push.js');
if (fs.existsSync(pushHandlerPath)) ok('src/handlers/push.js 存在');
else err('src/handlers/push.js 不存在');

const serverPath = path.join(ROOT, 'server.js');
if (fs.existsSync(serverPath)) {
  const server = fs.readFileSync(serverPath, 'utf8');
  if (server.includes("createPushHandlers")) ok('server.js: 已注册 push handlers');
  else err('server.js: 未注册 push handlers');
  if (server.includes('/api/vapid-public-key')) ok('server.js: 已注册 /api/vapid-public-key 路由');
  else err('server.js: 未注册推送路由');
}

// ===== 6. 扫码模块（桌面端已迁移至 React，扫码实现位于 web/ 源码） =====
console.log('\n6. 扫码模块检查');
const scannerPath = path.join(ROOT, 'web', 'src', 'maintenance', 'modules', 'sn-qr', 'SNQRCodesPage.tsx');
if (fs.existsSync(scannerPath)) {
  ok('web/src/maintenance/modules/sn-qr/SNQRCodesPage.tsx 存在');
} else err('web/src/maintenance/modules/sn-qr/SNQRCodesPage.tsx 不存在');

// ===== 汇总 =====
console.log('\n' + '═'.repeat(50));
console.log(`  结果: ${pass} 通过, ${fail} 失败`);
if (fail === 0) {
  console.log('  ✅ PWA 配置完整，可以打包 APK');
  console.log('');
  console.log('  下一步：');
  console.log('    方案A（推荐）: 访问 https://www.pwabuilder.com/');
  console.log(`    方案B: 运行 ./tools/build-apk.sh`);
} else {
  console.log('  ❌ 有配置问题，请修复后再打包');
  process.exit(1);
}
console.log('═'.repeat(50));
