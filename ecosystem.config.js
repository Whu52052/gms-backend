// PM2 Ecosystem Configuration — 500并发优化
// 使用方法: pm2 start ecosystem.config.js
module.exports = {
  apps: [{
    name: 'yunwei',
    script: 'server.js',
    instances: 'max',           // 自动使用所有CPU核心
    exec_mode: 'cluster',       // 集群模式
    max_memory_restart: '2G',   // 单进程内存超2G自动重启
    kill_timeout: 10000,        // 优雅关闭超时

    // 环境变量
    env: {
      NODE_ENV: 'production',
      PORT: 8765,
      TZ: 'Asia/Shanghai',
      // 数据库 (由 Docker Compose 注入)
      DB_HOST: process.env.DB_HOST || 'localhost',
      DB_PORT: process.env.DB_PORT || '3306',
      DB_USER: process.env.DB_USER || 'Wuzhenyu',
      DB_PASSWORD: process.env.DB_PASSWORD || 'Wh111852',
      DB_NAME: process.env.DB_NAME || 'gms',
      // Redis
      REDIS_HOST: process.env.REDIS_HOST || 'localhost',
      REDIS_PORT: process.env.REDIS_PORT || '6379',
    },

    // 日志
    error_file: '/var/log/yunwei/error.log',
    out_file: '/var/log/yunwei/out.log',
    log_file: '/var/log/yunwei/combined.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    merge_logs: true,

    // 进程管理
    wait_ready: false,
    listen_timeout: 15000,
    shutdown_with_message: true,
  }]
};
