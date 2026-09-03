# GMS APK 安装包生成指南

本文档介绍两种将 GMS 系统打包成 Android APK 安装包的方法。

---

## 方案对比

| 方案 | 耗时 | 需要工具 | 推荐度 |
|------|------|---------|--------|
| **A. PWABuilder.com（在线）** | ~5分钟 | 仅浏览器 | ⭐⭐⭐⭐⭐ |
| **B. 本地 Bubblewrap 构建** | ~30分钟 | JDK+Android SDK | ⭐⭐⭐ |

---

## 方案 A：PWABuilder.com 在线生成（推荐）

微软提供的免费服务，无需安装任何工具，5分钟出 APK。

### 步骤

1. **部署 PWA 到 HTTPS 服务器**
   ```bash
   # 确保 manifest.json 和 sw.js 在网站根目录可访问
   curl https://你的域名/manifest.json   # 应返回 JSON
   curl https://你的域名/sw.js           # 应返回 JS
   ```

2. **访问 PWABuilder**
   - 打开 https://www.pwabuilder.com/
   - 输入你的 PWA URL：`https://你的域名`
   - 点击 **Start**

3. **评分检查**
   - PWABuilder 会检测 PWA 完整性
   - 确保 Manifest 和 Service Worker 评分都是 ✅

4. **打包 Android**
   - 点击 **Package For Stores** → **Android**
   - 填写：
     - Package ID: `com.gms.twa`
     - App Name: `GMS 手套管理系统`
     - Signing Key: 选"New"（自动生成）
   - 点击 **Generate**

5. **下载 APK**
   - 等待约 1-2 分钟
   - 下载 `.apk` 文件
   - 传到手机安装

### 配置 Digital Asset Links（可选，消除地址栏）

PWABuilder 生成的 TWA 默认会显示浏览器地址栏。要全屏运行：

1. 从 PWABuilder 下载包中找到 `assetlinks.json`
2. 部署到 `https://你的域名/.well-known/assetlinks.json`
3. 重新生成 APK

---

## 方案 B：本地 Bubblewrap 构建

适合需要自定义构建、离线构建的场景。

### 前置要求

- Linux/macOS/WSL2
- ~2GB 磁盘空间（JDK + Android SDK）
- 稳定网络（需下载 ~450MB 工具）

### 一键构建

```bash
# 设置你的 HTTPS 域名
export GMS_URL=https://gms.example.com

# 运行构建脚本
cd /home/we/gms-backend
chmod +x tools/build-apk.sh
./tools/build-apk.sh
```

脚本会自动：
1. 下载并安装 JDK 11
2. 下载并安装 Android SDK
3. 安装 Bubblewrap CLI
4. 初始化 TWA 项目
5. 构建 debug APK

### 手动步骤

如果脚本失败，可手动执行：

```bash
# 1. 安装 JDK 11
mkdir -p ~/.local/share/jdk-11
curl -L -o /tmp/jdk11.tar.gz \
  "https://github.com/adoptium/temurin11-binaries/releases/download/jdk-11.0.24%2B8/OpenJDK11U-jdk_x64_linux_hotspot_11.0.24_8.tar.gz"
tar -xzf /tmp/jdk11.tar.gz -C ~/.local/share/jdk-11 --strip-components=1
export JAVA_HOME=~/.local/share/jdk-11
export PATH=$JAVA_HOME/bin:$PATH

# 2. 安装 Android SDK
mkdir -p ~/.local/share/android-sdk/cmdline-tools
curl -L -o /tmp/sdk.zip \
  "https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip"
cd /tmp && unzip -q sdk.zip -d ~/.local/share/android-sdk/cmdline-tools
mv ~/.local/share/android-sdk/cmdline-tools/cmdline-tools \
   ~/.local/share/android-sdk/cmdline-tools/latest
export ANDROID_HOME=~/.local/share/android-sdk
export PATH=$ANDROID_HOME/cmdline-tools/latest/bin:$PATH
yes | sdkmanager --licenses
sdkmanager "platforms;android-33" "build-tools;33.0.2" "platform-tools"

# 3. 安装 Bubblewrap
npm install -g @bubblewrap/cli

# 4. 初始化 TWA 项目
mkdir -p .apk-build && cd .apk-build
bubblewrap init --manifest=https://你的域名/manifest.json

# 5. 构建 APK
bubblewrap build --debug
```

---

## PWA 配置说明

本仓库已配置好 PWA，包含以下文件：

| 文件 | 作用 |
|------|------|
| `manifest.json` | PWA 应用清单（名称、图标、主题色等） |
| `sw.js` | Service Worker（离线缓存、推送通知） |
| `icons/icon-192.png` | 192x192 图标 |
| `icons/icon-512.png` | 512x512 图标 |
| `icons/maskable-*.png` | 可裁剪图标（适应不同启动器） |

### Service Worker 功能

- **离线缓存**：核心资源（HTML/JS/CSS）预缓存，无网络时可打开
- **推送通知**：接收服务器推送的工单状态变更
- **后台同步**：网络恢复后自动重试失败请求
- **通知点击**：点击通知跳转到对应页面

### 推送通知配置

1. VAPID 密钥已配置在 `.env`：
   ```
   VAPID_PUBLIC_KEY=BLfnz_by_...
   VAPID_PRIVATE_KEY=gk3D5R_r...
   ```

2. 后端路由（已注册）：
   - `GET /api/vapid-public-key` — 获取公钥
   - `POST /api/push/subscribe` — 订阅推送
   - `POST /api/push/test` — 发送测试通知

3. 前端订阅推送：
   ```javascript
   // 在浏览器控制台执行
   await window._subscribePush();
   ```

### 相机扫码

已集成扫码模块 `js/ui/qr-scanner.js`，调用方式：

```javascript
// 打开扫码器
App.openScanner((result) => {
  console.log('扫到内容:', result);
  // 处理扫描结果
});

// 检查是否支持
if (App._scannerSupported()) {
  // 支持扫码
}
```

特性：
- 优先使用原生 `BarcodeDetector` API（Android Chrome 支持）
- 回退到 `jsQR` 库（需额外加载）
- 支持后置摄像头
- 支持闪光灯（如设备支持）
- 扫描成功震动反馈

---

## 构建产物

### Debug APK
- 用于测试
- 自签名，可直接安装
- 命令：`bubblewrap build --debug`

### Release APK / AAB
- 用于发布到应用商店
- 需要签名密钥
- 命令：`bubblewrap build --release`
- 首次会引导创建签名密钥

### AAB（推荐发布格式）
Google Play 现在要求 AAB 格式：
```bash
bubblewrap build --release --aab
```

---

## 常见问题

### Q: TWA 显示地址栏怎么办？
A: 需要部署 Digital Asset Links。在 `https://你的域名/.well-known/assetlinks.json` 部署签名指纹。Bubblewrap 构建后会生成此文件。

### Q: 推送通知不工作？
A: 检查：
1. VAPID 密钥已配置（`.env`）
2. 服务器使用 HTTPS
3. Service Worker 已注册（浏览器控制台应显示 `[PWA] ServiceWorker 注册成功`）
4. 用户已订阅（调用 `window._subscribePush()`）

### Q: APK 体积多大？
A: TWA 方式约 2-5MB（主要是 Chrome WebView 内核复用）。

### Q: iOS 怎么办？
A: iOS 不支持 TWA。但 PWA 可"添加到主屏幕"，效果类似原生应用。manifest.json 已配置 `apple-mobile-web-app-*` 标签。

### Q: 如何更新 APK？
A: 重新部署 PWA 内容 → 用户打开 APP 时自动更新（Service Worker 会检测并应用新版本）。无需重新安装 APK。

---

## 技术架构

```
┌─────────────────────────────────────────┐
│           Android APK (TWA)             │
│  ┌───────────────────────────────────┐  │
│  │   Chrome WebView (Trusted)       │  │
│  │   ┌───────────────────────────┐   │  │
│  │   │   GMS PWA 前端             │   │  │
│  │   │   (HTML + JS + CSS)        │   │  │
│  │   │   - Service Worker 缓存    │   │  │
│  │   │   - Web Push 推送          │   │  │
│  │   │   - getUserMedia 扫码      │   │  │
│  │   └───────────────────────────┘   │  │
│  └───────────────────────────────────┘  │
│              ↑ HTTPS                    │
│  ┌───────────────────────────────────┐  │
│  │   GMS 后端 (Node.js)              │  │
│  │   - /api/vapid-public-key         │  │
│  │   - /api/push/subscribe           │  │
│  │   - Web Push (VAPID)              │  │
│  └───────────────────────────────────┘  │
└─────────────────────────────────────────┘
```
