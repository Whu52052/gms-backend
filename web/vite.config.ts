import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

// 双入口：桌面运维端 (index) + 运营端 (operations)
// 构建产物输出到 web/dist，由 scripts/publish.js 拷贝到仓库根目录
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@common': resolve(__dirname, 'src/common'),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:3000', changeOrigin: true },
      '/uploads': { target: 'http://localhost:3000', changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    emptyOutDir: true,
    chunkSizeWarningLimit: 2000,
    rollupOptions: {
      input: {
        index: resolve(__dirname, 'index.html'),
        operations: resolve(__dirname, 'operations.html'),
      },
      output: {
        manualChunks: {
          react: ['react', 'react-dom', 'react-router-dom'],
          antd: ['antd', '@ant-design/icons'],
          charts: ['echarts', 'echarts-for-react'],
        },
      },
    },
  },
});
