# Machine Heartbeat Agent - Lightweight Docker Container
FROM node:20-alpine

WORKDIR /app

# 额外系统工具：
# - android-tools：adb，用于 Quest 头显检测（序列号/电量/温度）
# - docker-cli：docker exec importer-staging 读取 /exchange/machine.jsonc 识别手套 SN
# - v4l-utils：v4l2-ctl，用于摄像头设备检测（Linux）
# - ffmpeg：用于摄像头帧率监控
RUN apk add --no-cache android-tools docker-cli v4l-utils ffmpeg

# 零第三方 npm 依赖（原生 net/http/child_process），直接拷贝全部模块
COPY package.json ./
COPY *.js ./

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=15s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/health', (r) => process.exit(r.statusCode === 200 ? 0 : 1))"

EXPOSE 3000

CMD ["node", "heartbeat-agent.js"]
