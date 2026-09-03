#!/usr/bin/env node
/**
 * 手套断联监控模块
 *
 * 功能：
 * 1. 监控采集器日志中的手套连接状态
 * 2. 检测手套断联事件（wuji_glove_l / wuji_glove_r）
 * 3. 自动向 GMS 运维系统提交技术支持工单
 *
 * 监控方式：
 * - 方式1: 监控采集器健康检查端点
 * - 方式2: 监控 Docker 日志
 * - 方式3: 检查手套 IP 连通性
 */

const { exec } = require('child_process');
const { promisify } = require('util');
const http = require('http');

const execAsync = promisify(exec);

class GloveConnectionMonitor {
  constructor(options = {}) {
    this.machineNumber = options.machineNumber;
    this.gmsBackend = options.gmsBackend || 'http://10.5.51.216:8765';
    this.checkInterval = options.checkInterval || 10000; // 10秒检查一次
    this.containerName = options.containerName || 'importer-staging';

    // 手套 IP 配置
    // 注意：灵巧手是 192.168.1.110:7447 / 192.168.1.111:7447
    //       手套是 192.168.1.100:50001 (左) / 192.168.1.101:50001 (右)
    this.gloveIPs = {
      left: '192.168.1.100:50001',   // 左手手套
      right: '192.168.1.101:50001',  // 右手手套
    };

    // 状态跟踪
    this.gloveStatus = {
      left: { connected: true, lastCheck: null, failCount: 0 },
      right: { connected: true, lastCheck: null, failCount: 0 },
    };

    // 工单提交状态（防止重复提交）
    this.submittedTickets = new Map(); // hand → ticketId

    this.monitoring = false;
    this.checkTimer = null;
  }

  // ==================== HTTP 请求辅助函数 ====================
  async httpRequest(url, options = {}) {
    return new Promise((resolve, reject) => {
      const urlObj = new URL(url);
      const reqOptions = {
        hostname: urlObj.hostname,
        port: urlObj.port || 80,
        path: urlObj.pathname,
        method: options.method || 'GET',
        headers: options.headers || {},
        timeout: 5000,
      };

      const req = http.request(reqOptions, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try {
              resolve({ statusCode: res.statusCode, body: JSON.parse(data) });
            } catch {
              resolve({ statusCode: res.statusCode, body: data });
            }
          } else {
            reject(new Error(`HTTP ${res.statusCode}`));
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

  // ==================== 检测手套连接状态 ====================
  async checkGloveConnection(hand) {
    const ip = this.gloveIPs[hand];
    if (!ip) return null;

    const [host, port] = ip.split(':');

    try {
      // 方法1: 使用 nc (netcat) 检测端口连通性
      const { stdout } = await execAsync(`timeout 2 nc -zv ${host} ${port} 2>&1`, {
        timeout: 3000
      });

      return {
        hand,
        connected: stdout.includes('succeeded') || stdout.includes('open'),
        method: 'netcat',
        ip,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      // nc 失败，尝试 telnet
      try {
        await execAsync(`timeout 2 bash -c "echo > /dev/tcp/${host}/${port}" 2>&1`, {
          timeout: 3000
        });
        return {
          hand,
          connected: true,
          method: 'tcp',
          ip,
          timestamp: new Date().toISOString(),
        };
      } catch {
        return {
          hand,
          connected: false,
          method: 'tcp',
          ip,
          error: error.message,
          timestamp: new Date().toISOString(),
        };
      }
    }
  }

  // ==================== 从 Docker 日志检测断联 ====================
  async checkDockerLogs() {
    try {
      const { stdout } = await execAsync(
        `docker logs --tail 100 ${this.containerName} 2>&1 | grep -i "glove\|hand\|disconnect\|connect" | tail -20`,
        { timeout: 5000 }
      );

      const issues = {
        left: false,
        right: false,
      };

      // 解析日志查找断联关键词
      const lines = stdout.split('\n');
      for (const line of lines) {
        if (/(wuji_glove_l|left.*glove|左手).*disconnect|error|fail|timeout/i.test(line)) {
          issues.left = true;
        }
        if (/(wuji_glove_r|right.*glove|右手).*disconnect|error|fail|timeout/i.test(line)) {
          issues.right = true;
        }
      }

      return issues;
    } catch (error) {
      console.error('[Glove Monitor] 读取 Docker 日志失败:', error.message);
      return null;
    }
  }

  // ==================== 提交技术支持工单 ====================
  async submitTechSupport(hand, reason) {
    if (!this.machineNumber) {
      console.error('[Glove Monitor] 机器编号未设置，无法提交工单');
      return null;
    }

    // 检查是否已提交过工单（防止重复）
    if (this.submittedTickets.has(hand)) {
      const ticketId = this.submittedTickets.get(hand);
      console.log(`[Glove Monitor] ${hand}手工单已存在: ${ticketId}`);
      return ticketId;
    }

    const payload = {
      machineNumber: this.machineNumber,
      issueType: '手套断联',
      faultType: `${hand === 'left' ? '左' : '右'}手手套连接异常`,
      description: reason || `检测到${hand === 'left' ? '左' : '右'}手手套断联，请检查：\n1. 手套设备电源\n2. 网络连接（IP: ${this.gloveIPs[hand]}）\n3. USB连接线\n4. 手套驱动程序`,
      priority: 'P1', // 高优先级
      severity: 'S2', // 严重
      category: 'hardware',
      submitterName: 'HeartbeatAgent',
      submitterId: 'system-auto',
      urgency: 'high',
      autoSubmitted: true, // 标记为自动提交
    };

    try {
      const url = `${this.gmsBackend}/api/tech-support`;
      const response = await this.httpRequest(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      if (response.body && response.body.success) {
        const ticketId = response.body.id;
        console.log(`[Glove Monitor] ✅ 已自动提交技术支持工单: ${ticketId}`);
        console.log(`   机器: ${this.machineNumber}`);
        console.log(`   问题: ${hand === 'left' ? '左' : '右'}手手套断联`);

        // 记录已提交的工单
        this.submittedTickets.set(hand, ticketId);

        return ticketId;
      } else {
        console.error('[Glove Monitor] ❌ 提交工单失败:', response.body);
        return null;
      }
    } catch (error) {
      console.error('[Glove Monitor] ❌ 提交工单请求失败:', error.message);
      return null;
    }
  }

  // ==================== 检查循环 ====================
  async performCheck() {
    console.log('[Glove Monitor] 执行检查...');

    // 方法1: 直接检测手套 IP 连通性
    for (const hand of ['left', 'right']) {
      const result = await this.checkGloveConnection(hand);

      if (result) {
        const status = this.gloveStatus[hand];
        status.lastCheck = result.timestamp;

        if (!result.connected) {
          status.failCount++;
          console.warn(`[Glove Monitor] ⚠️  ${hand}手手套断联 (${status.failCount}次)`);

          // 连续3次失败才提交工单（避免误报）
          if (status.failCount >= 3 && status.connected) {
            status.connected = false;
            console.error(`[Glove Monitor] ❌ ${hand}手手套确认断联，自动提交工单...`);
            await this.submitTechSupport(hand, `手套IP ${result.ip} 连接失败（连续${status.failCount}次）`);
          }
        } else {
          // 恢复连接
          if (!status.connected) {
            console.log(`[Glove Monitor] ✅ ${hand}手手套已恢复连接`);
            status.connected = true;

            // 清除已提交的工单记录（允许下次断联重新提交）
            this.submittedTickets.delete(hand);
          }
          status.failCount = 0;
        }
      }
    }

    // 方法2: 检查 Docker 日志中的错误
    const logIssues = await this.checkDockerLogs();
    if (logIssues) {
      for (const [hand, hasIssue] of Object.entries(logIssues)) {
        if (hasIssue && this.gloveStatus[hand].connected) {
          console.warn(`[Glove Monitor] ⚠️  Docker日志检测到${hand}手异常`);
        }
      }
    }
  }

  // ==================== 启动监控 ====================
  async startMonitoring() {
    if (this.monitoring) {
      console.warn('[Glove Monitor] 监控已在运行');
      return;
    }

    console.log('[Glove Monitor] 启动手套断联监控...');
    console.log(`  机器编号: ${this.machineNumber}`);
    console.log(`  检查间隔: ${this.checkInterval / 1000}秒`);
    console.log(`  左手IP: ${this.gloveIPs.left}`);
    console.log(`  右手IP: ${this.gloveIPs.right}`);
    console.log('');

    this.monitoring = true;

    const checkLoop = async () => {
      if (!this.monitoring) return;

      await this.performCheck();

      // 下一次检查
      this.checkTimer = setTimeout(checkLoop, this.checkInterval);
    };

    // 开始第一次检查
    checkLoop();
  }

  // ==================== 停止监控 ====================
  stopMonitoring() {
    if (this.checkTimer) {
      clearTimeout(this.checkTimer);
      this.checkTimer = null;
    }
    this.monitoring = false;
    console.log('[Glove Monitor] 监控已停止');
  }

  // ==================== 获取状态 ====================
  getStatus() {
    return {
      monitoring: this.monitoring,
      gloveStatus: this.gloveStatus,
      submittedTickets: Array.from(this.submittedTickets.entries()).map(([hand, ticketId]) => ({
        hand,
        ticketId,
      })),
    };
  }
}

module.exports = GloveConnectionMonitor;

// ==================== 独立运行测试 ====================
if (require.main === module) {
  const monitor = new GloveConnectionMonitor({
    machineNumber: 'we-105',
    gmsBackend: 'http://10.5.51.216:8765',
    checkInterval: 10000,
    containerName: 'importer-staging',
  });

  monitor.startMonitoring();

  // 优雅退出
  process.on('SIGINT', () => {
    console.log('\n正在退出...');
    monitor.stopMonitoring();
    process.exit(0);
  });
}
