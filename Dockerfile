FROM node:20-alpine

# dumb-init for proper SIGTERM → graceful shutdown
RUN apk add --no-cache dumb-init

WORKDIR /app

# Install dependencies (mysql2 is pure JS, no native build tools needed)
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy application
COPY server.js ./
COPY index.html operations.html ./
COPY css/ ./css/
COPY js/ ./js/

# Uploads directory (may be mounted via CFS for persistence)
RUN mkdir -p /app/uploads

EXPOSE 8765
ENV PORT=8765
ENV TZ=Asia/Shanghai

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "server.js"]
