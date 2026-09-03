#!/bin/bash
# ============================================================
# GMS APK 自动构建脚本
# 使用 Bubblewrap CLI 将 PWA 打包为 Android APK (TWA 模式)
#
# 使用方式：
#   chmod +x tools/build-apk.sh
#   ./tools/build-apk.sh
#
# 前置条件：
#   - GMS 服务器已部署在 HTTPS 域名下
#   - manifest.json 和 sw.js 已可访问
#   - 本脚本会自动安装 JDK 11 和 Android SDK
# ============================================================

set -e

# ===== 配置 =====
APP_NAME="GMS 手套管理系统"
APP_SHORT_NAME="GMS"
APP_ID="com.gms.twa"                          # Android Package ID
APP_URL="${GMS_URL:-https://gms.example.com}"  # 改成你的 HTTPS 部署地址
APP_THEME_COLOR="#3b82f6"
APP_BACKGROUND_COLOR="#ffffff"
START_URL="/"
ICON_512_URL="${APP_URL}/icons/icon-512.png"
MASKABLE_ICON_URL="${APP_URL}/icons/maskable-512.png"

# 工作目录
WORK_DIR="$(dirname "$0")/../.apk-build"
JDK_DIR="$HOME/.local/share/jdk-11"
ANDROID_SDK_DIR="$HOME/.local/share/android-sdk"

echo "================================================"
echo "  GMS APK 构建脚本"
echo "  应用名称: $APP_NAME"
echo "  应用 URL: $APP_URL"
echo "  Package:  $APP_ID"
echo "================================================"
echo ""

# ===== Step 1: 检查/安装 JDK 11 =====
if [ -f "$JDK_DIR/bin/java" ]; then
  echo "✅ JDK 11 已安装"
else
  echo "📦 下载 JDK 11 (Temurin)..."
  mkdir -p "$JDK_DIR"
  JDK_URL="https://github.com/adoptium/temurin11-binaries/releases/download/jdk-11.0.24%2B8/OpenJDK11U-jdk_x64_linux_hotspot_11.0.24_8.tar.gz"
  curl -L -o /tmp/jdk11.tar.gz "$JDK_URL"
  tar -xzf /tmp/jdk11.tar.gz -C "$JDK_DIR" --strip-components=1
  rm /tmp/jdk11.tar.gz
  echo "✅ JDK 11 安装完成"
fi

export JAVA_HOME="$JDK_DIR"
export PATH="$JAVA_HOME/bin:$PATH"
echo "   JAVA_HOME=$JAVA_HOME"
java -version 2>&1 | head -1

# ===== Step 2: 检查/安装 Android SDK =====
if [ -f "$ANDROID_SDK_DIR/cmdline-tools/latest/bin/sdkmanager" ]; then
  echo "✅ Android SDK 已安装"
else
  echo "📦 下载 Android SDK Command-line Tools..."
  mkdir -p "$ANDROID_SDK_DIR/cmdline-tools"
  SDK_URL="https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip"
  curl -L -o /tmp/sdk-tools.zip "$SDK_URL"
  cd /tmp && unzip -q sdk-tools.zip -d "$ANDROID_SDK_DIR/cmdline-tools"
  mv "$ANDROID_SDK_DIR/cmdline-tools/cmdline-tools" "$ANDROID_SDK_DIR/cmdline-tools/latest"
  rm sdk-tools.zip
  echo "✅ Android SDK Tools 安装完成"
fi

export ANDROID_HOME="$ANDROID_SDK_DIR"
export PATH="$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools:$PATH"

echo "📦 安装 Android Platform 33 和 Build-Tools..."
yes | sdkmanager --licenses > /dev/null 2>&1 || true
sdkmanager "platforms;android-33" "build-tools;33.0.2" "platform-tools" > /dev/null 2>&1
echo "✅ Android SDK 组件安装完成"

# ===== Step 3: 安装 Bubblewrap CLI =====
echo "📦 安装 Bubblewrap CLI..."
npm install -g @bubblewrap/cli > /dev/null 2>&1
echo "✅ Bubblewrap CLI 安装完成"

# ===== Step 4: 初始化 TWA 项目 =====
mkdir -p "$WORK_DIR"
cd "$WORK_DIR"

if [ ! -f "twamanifest.json" ]; then
  echo "🔧 初始化 TWA 项目..."
  bubblewrap init \
    --manifest="$APP_URL/manifest.json" \
    --directory=. \
    --applicationName="$APP_NAME" \
    --applicationId="$APP_ID" \
    --host="$APP_URL" \
    --startUrl="$START_URL" \
    --themeColor="$APP_THEME_COLOR" \
    --navigationColor="$APP_THEME_COLOR" \
    --backgroundColor="$APP_BACKGROUND_COLOR" \
    --icon192="$APP_URL/icons/icon-192.png" \
    --icon512="$ICON_512_URL" \
    --maskableIcon512="$MASKABLE_ICON_URL" \
    --no-interactive \
    2>&1 || {
      echo ""
      echo "❌ Bubblewrap init 失败，尝试手动模式..."
      echo "   请运行: bubblewrap init --manifest=$APP_URL/manifest.json"
      exit 1
    }
fi

# ===== Step 5: 构建 APK =====
echo ""
echo "🔨 构建 APK (debug)..."
bubblewrap build --debug 2>&1 || {
  echo "❌ 构建失败"
  echo "   常见问题:"
  echo "   1. 网络问题：Gradle 首次下载依赖较慢"
  echo "   2. 确认 $APP_URL/manifest.json 可访问"
  echo "   3. 确认 $APP_URL/sw.js 可访问"
  exit 1
}

# ===== Step 6: 输出结果 =====
APK_FILE=$(find . -name "*.apk" -path "*/debug/*" | head -1)
if [ -z "$APK_FILE" ]; then
  APK_FILE=$(find . -name "*.apk" | head -1)
fi

echo ""
echo "================================================"
echo "  ✅ APK 构建成功！"
echo "================================================"
if [ -n "$APK_FILE" ]; then
  echo "  APK 路径: $WORK_DIR/$APK_FILE"
  echo "  APK 大小: $(du -h "$APK_FILE" | cut -f1)"
  echo ""
  echo "  安装方法:"
  echo "    adb install $APK_FILE"
  echo "    或复制到手机点击安装"
fi
echo ""
echo "  📝 发布 Release 版本（需要签名密钥）:"
echo "    bubblewrap build --release"
echo ""
echo "  📝 Digital Asset Links (关联网站):"
echo "    将 .well-known/assetlinks.json 部署到 $APP_URL"
echo "    文件路径: $WORK_DIR/app/src/main/assets/assetlinks.json"
echo "================================================"
