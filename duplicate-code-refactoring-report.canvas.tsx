import { Divider, Grid, H1, H2, H3, Stack, Stat, Table, Text } from 'qoder/canvas';

const phaseData = [
  ['阶段 1', 'CSS 共享样式合并', '~60 行', '3', 'css/status-pages.css + 3 HTML'],
  ['阶段 2', 'JS 工具函数提取', '~60 行', '3', 'js/status-pages-common.js (新建)'],
  ['阶段 3', '前端 JS 去重', '~65 行', '5', 'state.js / adapter.js / ws-client.js / app.js / mobile-redirect.js'],
  ['阶段 4', '后端权限检查统一', '~34 行', '5', '_permissions.js + storage-locations / replacement / solutions / tech-support'],
  ['阶段 5', '语法验证 + 单元测试', '—', '—', '13 文件 node --check + 12 测试文件'],
];

const beforeAfter = [
  ['JavaScript', '~13.5%', '3.80%', '达标'],
  ['CSS', '~8%', '2.51%', '达标'],
  ['Markup (HTML)', '~22%', '19.48%', '结构重复'],
  ['总计 (tokens)', '~12%', '9.88%', '达标 (<10%)'],
];

const newFiles = [
  ['新建', 'js/status-pages-common.js', '共享 escapeHtml / formatTime / showToast / fetchData'],
  ['新建', 'js/mobile-redirect.js', '统一移动端检测重定向逻辑'],
];

const modifiedFiles = [
  ['修改', 'css/status-pages.css', '新增 ~145 行共享样式类'],
  ['修改', 'location-status.html', '删除内联 CSS/JS，引用共享资源'],
  ['修改', 'machine-status.html', '删除内联 CSS/JS，引用共享资源'],
  ['修改', 'sn-status.html', '删除内联 CSS/JS，引用共享资源'],
  ['修改', 'js/store/state.js', 'mergeMachineLists → GMSUtils.mergeMachines'],
  ['修改', 'js/store/adapter.js', '内联合并 → GMSUtils.mergeMachines'],
  ['修改', 'js/ws-client.js', '硬编码事件列表 → GMSUtils.ALL_SYNC_EVENTS'],
  ['修改', 'app.js (根目录)', 'Cookie 函数 → GMSUtils 委托'],
  ['修改', 'index.html', '内联脚本 → js/mobile-redirect.js'],
  ['修改', 'operations.html', '内联脚本 → js/mobile-redirect.js'],
  ['修改', 'src/handlers/_permissions.js', '新增 canWrite / requireTechResponder / requireTechAdmin'],
  ['修改', 'src/handlers/storage-locations.js', '内联权限检查 → requireAdmin()'],
  ['修改', 'src/handlers/replacement.js', '_canWrite → canWrite() 委托'],
  ['修改', 'src/handlers/solutions.js', '_canWrite → canWrite() 委托'],
  ['修改', 'src/handlers/tech-support.js', '复杂权限检查 → requireTechResponder/Admin'],
];

export default function DuplicateCodeRefactoringReport() {
  return (
    <Stack gap={20}>
      <H1>重复代码重构 — 完成报告</H1>
      <Text tone="secondary">GMS 灵巧手手套管理系统 · 8 类重复模式 · 20+ 文件 · 5 阶段重构</Text>

      <Divider />

      <H2>成果概览</H2>
      <Grid columns={4} gap={12}>
        <Stat value="9.88%" label="总重复率 (tokens)" tone="success" />
        <Stat value="3.80%" label="JS 重复率" tone="success" />
        <Stat value="2.51%" label="CSS 重复率" tone="success" />
        <Stat value="17" label="受影响文件" />
      </Grid>

      <Divider />

      <H2>重构阶段</H2>
      <Table
        headers={['阶段', '内容', '消除重复', '文件数', '关键文件']}
        rows={phaseData}
      />

      <Divider />

      <H2>重复率对比</H2>
      <Table
        headers={['类型', '重构前', '重构后', '状态']}
        rows={beforeAfter}
      />

      <Divider />

      <H2>变更文件清单</H2>
      <H3>新建文件 (2)</H3>
      <Table
        headers={['操作', '文件', '说明']}
        rows={newFiles}
      />

      <H3>修改文件 (15)</H3>
      <Table
        headers={['操作', '文件', '说明']}
        rows={modifiedFiles}
      />

      <Divider />

      <H2>验证结果</H2>
      <Grid columns={3} gap={12}>
        <Stat value="13/13" label="语法检查通过" tone="success" />
        <Stat value="12/12" label="单元测试通过" tone="success" />
        <Stat value="<10%" label="目标达成" tone="success" />
      </Grid>

      <Text tone="secondary" size="small">
        测量工具: jscpd · 排除: node_modules, 根目录遗留 app.js · 测量时间: 2026-08-21
      </Text>
    </Stack>
  );
}
