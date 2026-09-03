#!/usr/bin/env node
/**
 * 设备检测请求轮询模块
 *
 * 客户端定期轮询后端，检查是否有设备检测请求
 * 如果有请求，执行检测并上报结果
 */

const http = require('http');
const https = require('https');

class DeviceCheckPoller {
  constructor(options = {}) {
    this.backendUrl = options.backendUrl;
    this.machineNumber = options.machineNumber;
    this.deviceDetector = options.deviceDetector;
    this.pollInterval = options.pollInterval || 10000; // 10秒
    this.polling = false;
    this.pollTimer = null;
  }

  // ==================== HTTP 请求辅助函数 ====================
  async httpRequest(url, options = {}) {
    return new Promise((resolve, reject) => {
      const urlObj = new URL(url);
      const isHttps = urlObj.protocol === 'https:';
      const client = isHttps ? https : http;

      const requestOptions = {
        hostname: urlObj.hostname,
        port: urlObj.port || (isHttps ? 443 : 80),
        path: urlObj.pathname + urlObj.search,
        method: options.method || 'GET',
        headers: {
          'Content-Type': 'application/json',
          ...options.headers,
        },
        timeout: options.timeout || 5000,
      };

      const req = client.request(requestOptions, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const result = JSON.parse(data);
            resolve({ statusCode: res.statusCode, data: result });
          } catch (e) {
            resolve({ statusCode: res.statusCode, data });
          }
        });
      });

      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Request timeout'));
      });

      if (options.body) {
        req.write(typeof options.body === 'string' ? options.body : JSON.stringify(options.body));
      }
      req.end();
    });
  }

  // ==================== 轮询检测请求 ====================
  async poll() {
    try {
      // 1. 向后端查询是否有检测请求
      const pollUrl = `${this.backendUrl}/api/poll-check/${this.machineNumber}`;
      const response = await this.httpRequest(pollUrl);

      if (response.statusCode !== 200) {
        console.error('[Device Check Poller] 轮询失败:', response.statusCode);
        return;
      }

      const { requestId } = response.data;

      if (!requestId) {
        // 没有待处理的检测请求
        return;
      }

      console.log(`[Device Check Poller] 收到检测请求: ${requestId}`);

      // 2. 执行设备检测
      console.log('[Device Check Poller] 开始执行设备检测...');
      const detectionResult = await this.deviceDetector.detectAll();

      // 3. 上报检测结果
      const submitUrl = `${this.backendUrl}/api/check-requests/${requestId}/result`;
      const submitResponse = await this.httpRequest(submitUrl, {
        method: 'POST',
        body: detectionResult,
      });

      if (submitResponse.statusCode === 200) {
        console.log(`[Device Check Poller] ✅ 检测结果已上报: 请求ID ${requestId}`);
      } else {
        console.error(`[Device Check Poller] ❌ 上报失败: ${submitResponse.statusCode}`);
      }

    } catch (error) {
      console.error('[Device Check Poller] 轮询错误:', error.message);
    }
  }

  // ==================== 启动轮询 ====================
  start() {
    if (this.polling) {
      console.warn('[Device Check Poller] 已在运行');
      return;
    }

    this.polling = true;
    console.log(`[Device Check Poller] 启动轮询: 间隔 ${this.pollInterval}ms`);

    // 立即执行一次
    this.poll();

    // 定时轮询
    this.pollTimer = setInterval(() => {
      this.poll();
    }, this.pollInterval);
  }

  // ==================== 停止轮询 ====================
  stop() {
    if (!this.polling) {
      return;
    }

    this.polling = false;

    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }

    console.log('[Device Check Poller] 轮询已停止');
  }
}

module.exports = DeviceCheckPoller;
