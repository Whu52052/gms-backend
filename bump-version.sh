#!/bin/bash
# 自动升级版本号脚本 — 每次更新代码后运行

cd "$(dirname "$0")"

# 读取当前版本
APP=$(grep -oP 'js/app\.js\?v=\K\d+' index.html)
OPS=$(grep -oP 'js/operations\.js\?v=\K\d+' operations.html)
API=$(grep -oP 'js/api\.js\?v=\K\d+' index.html)
WS=$(grep -oP 'js/ws-client\.js\?v=\K\d+' index.html)

# 升级版本
NEW_APP=$((APP + 1))
NEW_OPS=$((OPS + 1))

# 替换版本号
sed -i "s/app\.js?v=$APP/app\.js?v=$NEW_APP/" index.html
sed -i "s/operations\.js?v=$OPS/operations\.js?v=$NEW_OPS/" operations.html
# API 同 WS 版本跟随 app 版本
sed -i "s/api\.js?v=$API/api\.js?v=$NEW_APP/" index.html operations.html 2>/dev/null
sed -i "s/ws-client\.js?v=$WS/ws-client\.js?v=$NEW_APP/" index.html operations.html 2>/dev/null

echo "✅ 版本号升级: app v$APP→v$NEW_APP, operations v$OPS→v$NEW_OPS"
