  /**
 * ESLint Configuration — S7 企业安全加固
 *
 * 规则集设计原则：
 *   - 以 eslint:recommended 为基础
 *   - 逐步收紧（warn-first，不阻塞开发）
 *   - Node.js 后端 + 前端 JS 混合项目
 */
module.exports = {
  root: true,
  env: {
    node: true,
    es2022: true,
    browser: true,
  },
  parserOptions: {
    ecmaVersion: 'latest',
    sourceType: 'script',
  },
  // 项目全局变量（由 <script> 标签在浏览器中加载）
  globals: {
    // 核心模块
    App: 'readonly',
    API: 'readonly',
    Storage: 'readonly',
    GMSStore: 'readonly',
    UIUtils: 'readonly',
    StateDefs: 'readonly',
    GMSUtils: 'readonly',
    OpsApp: 'readonly',
    MobileApp: 'readonly',
    DistributedConfig: 'readonly',
    // UI 组件
    Notification: 'readonly',
    Modal: 'readonly',
    Confirm: 'readonly',
    AuditLog: 'readonly',
    // 第三方库（CDN 加载）
    QRCode: 'readonly',
    tesseract: 'readonly',
    Tesseract: 'readonly',
    jspdf: 'readonly',
    jsPDF: 'readonly',
    XLSX: 'readonly',
    // 业务数据（config.js 定义）
    damagedInvTypes: 'readonly',
    transferInvTypes: 'readonly',
    outboundInvTypes: 'readonly',
    inboundInvTypes: 'readonly',
    repairInvTypes: 'readonly',
    // 部署工具
    refreshToken: 'readonly',
    handleAPINotSupported: 'readonly',
    // 通用工具函数
    toast: 'readonly',
    debounce: 'readonly',
    throttle: 'readonly',
    formatTime: 'readonly',
    showModal: 'readonly',
    formatDate: 'readonly',
    escapeHtml: 'readonly',
    sleep: 'readonly',
    // 刷新函数
    refreshMachines: 'readonly',
    refreshSNRegistry: 'readonly',
    refreshInventory: 'readonly',
    refreshTransactions: 'readonly',
    broadcastUpdate: 'readonly',
    // 导出相关
    _doExportTS: 'readonly',
    _doExportXLSX: 'readonly',
    _doExportSNLinks: 'readonly',
    _downloadFile: 'readonly',
    _copyToClipboard: 'readonly',
    // 内部工具
    _formatDate: 'readonly',
    _escapeHtml: 'readonly',
    _syncData: 'readonly',
    _notifyUIUpdate: 'readonly',
    _formatDuration: 'readonly',
    _getStatusLabel: 'readonly',
    _cached: 'readonly',
    _getSnapshot: 'readonly',
    _notifySnapshot: 'readonly',
    // 实时相关
    Realtime: 'readonly',
    // 后端辅助函数（通过依赖注入）
    broadcastChange: 'readonly',
    sendJSON: 'readonly',
    requireAuth: 'readonly',
    checkIpLimit: 'readonly',
    checkUserLimit: 'readonly',
    isLoginBlocked: 'readonly',
    recordLoginFailure: 'readonly',
    clearLoginFailures: 'readonly',
    setCSRFToken: 'readonly',
    getCSRFTokenValue: 'readonly',
    verifyCSRFToken: 'readonly',
    csrfMiddleware: 'readonly',
    _syncInventoryFromSN: 'readonly',
    _insertTransaction: 'readonly',
    // 其他
    handleAddTransaction: 'readonly',
    handleGetCSRFToken: 'readonly',
    handleAuthLogin: 'readonly',
  },
  extends: ['eslint:recommended'],
  rules: {
    // === 安全相关（error 级别）===
    'no-eval': 'error',
    'no-implied-eval': 'error',
    'no-new-func': 'error',
    'no-unsafe-finally': 'error',
    'no-unsafe-negation': 'error',
    'no-throw-literal': 'error',

    // === 代码质量（warn 级别）===
    'no-unused-vars': ['warn', {
      argsIgnorePattern: '^_',
      varsIgnorePattern: '^_',
      caughtErrors: 'none',
    }],
    'no-debugger': 'warn',
    'no-empty': 'warn',
    'no-unreachable': 'warn',
    'no-unsafe-optional-chaining': 'warn',
    'no-case-declarations': 'warn',
    'no-useless-escape': 'warn',
    'no-dupe-keys': 'warn',
    'no-undef': 'warn',

    // === 最佳实践（warn 级别）===
    'curly': ['warn', 'multi-line'],
    'eqeqeq': ['warn', 'smart'],
    'prefer-const': 'warn',

    // === 风格规则（off，不阻塞开发）===
    'no-console': 'off',
    'indent': 'off',
    'quotes': 'off',
    'semi': 'off',
    'comma-dangle': 'off',
    'no-extra-semi': 'off',
    'no-trailing-spaces': 'off',
    'no-irregular-whitespace': 'off',
    'no-multiple-empty-lines': 'off',
    'keyword-spacing': 'off',
    'space-before-function-paren': 'off',
    'object-curly-spacing': 'off',
    'array-bracket-spacing': 'off',
    'prefer-template': 'off',
    'no-else-return': 'off',
    'dot-notation': 'off',
    'no-prototype-builtins': 'off',
  },
  overrides: [
    {
      files: ['js/**/*.js'],
      env: { browser: true },
    },
    {
      files: ['tests/**/*.js'],
      rules: {
        'no-console': 'off',
      },
    },
    {
      files: ['server.js', 'src/**/*.js', 'lib/**/*.js'],
      env: { node: true },
    },
    {
      files: ['sw.js'],
      env: { serviceworker: true },
    },
  ],
};