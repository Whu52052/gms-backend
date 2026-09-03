# app.js 拆分计划

## Context

app.js 当前 10,306 行、237 个方法，是前端最大的单文件。已有的 UIUtils 模块系统（`js/ui/base.js` + 14 个 `js/ui/*.js` 模块）已覆盖 90 个方法，但 147 个方法仍留在 app.js 中作为 fallback。本计划将剩余方法分 8 个阶段提取到独立模块，最终将 app.js 降至约 3,700 行。

## 模块系统机制

- `js/ui/base.js` 提供 `UIUtils.register(name, factory)` + `UIUtils.init(app, deps)`
- 所有 `js/ui/*.js` 在 `app.js` 之前加载（index.html 第 315-328 行）
- `App.init()` 中调用 `UIUtils.init(this, { Storage, API, GMSStore, StateDefs })`
- 工厂函数通过 `app.xxx = function()` 覆盖 app.js 中的同名 fallback 方法
- 运行时 `this.xxx` 调用总能找到最新版本（模块版优先），故各阶段无硬依赖

## 分阶段实施

### 阶段 1：DEPLOY ADMIN（1,468 行 → 桩 84 行，净减 ~1,384 行）

**新建** `js/ui/deploy-admin.js`

迁移 app.js 第 8839-10306 行全部方法（~28 个），包括：
`_deployAdminClick`, `_showDeployAdmin`, `_hideDeployAdmin`, `_verifyDeployPassword`, `_switchDeployTab`, `_loadDeployConfig`, `_addDeployServer`, `_removeFromList`, `_deployLog`, `_appendDeployLog`, `_watchDeployLogs`, `_deployToServer`, `_quickNuke`, `_saveDbConfig`, `_generateDeployScript`, `_clearDeployLogs`, `_refreshDeployLogs`, `_getSecondaryConfig` 等

数据属性：`_deployAdminClicks`, `_deployClickTimer` 在工厂内 `app._deployAdminClicks = 0`

外部依赖仅 `this.notify`，完全自包含。

**index.html**：新增 `<script src="js/ui/deploy-admin.js?v=1"></script>`

**验证**：连点侧边栏 brand 5 次 / Ctrl+Shift+D 打开部署面板

---

### 阶段 2：SN QR CODES + MACHINE LINKS（393 行 → 桩 57 行，净减 ~336 行）

**新建** `js/ui/sn-qr.js`

迁移 app.js 第 2882-3157 行（12 个方法）：
`_snQRGotoPage`, `_snQRFilter`, `_snQRSearch`, `_snQRClearSearch`, `_snQRInboundFilter`, `_snQRClearInbound`, `_snQRView`, `_snQRCopy`, `_snQRPrintUrl`, `_snQRLoadImage`, `_snQRPrintSingle`, `_snQRPrintAll`

数据属性：`_snQRPage`, `_snQRItems`, `_snQRFilterValue`, `_snQRSearchQuery` 等

**新建** `js/ui/machine-links.js`

迁移 app.js 第 3158-3274 行（3 个方法）：
`renderMachineLinks`, `_machineLinkSetFilter`, `_machineLinkSearchInput`

依赖 `this._buildEffectiveStatusMap`（已在 machines.js）

**index.html**：新增两个 script 标签

**验证**：SN码链接分页/筛选/打印/复制；机器链接筛选/搜索

---

### 阶段 3：USER MANAGEMENT（398 行 → 桩 42 行，净减 ~356 行）

**新建** `js/ui/users.js`

迁移 app.js 第 7321-7718 行（6+ 个方法）：
`showAddUserForm`, `_showEditUser`, `_filterUserTable`, `_resetUserFilters`, `_hasSNDeletePerm`, `_canViewPassword`, `_viewUserPassword`, `deleteUser`, `_fetchUsers` 等

⚠️ **Bug 修复**：`_viewUserPassword` 在第 7554 行和 7681 行重复定义，仅保留 7681 行版本（后者覆盖前者生效）

依赖 `this.notify`/`showModal`/`showConfirm`/`closeModal`/`_formatTime`

**验证**：用户表渲染、筛选、新增/编辑/删除、查看密码、SN 删除权限

---

### 阶段 4：TECH SUPPORT + 关联段落（586 行 → 桩 66 行，净减 ~586 行）

**新建** `js/ui/tech-support.js`

合并迁移多个相关段落：
- DURATION FORMATTER (5667-5679)：`_fmtDuration`
- TECH SUPPORT (5689-6055)：`_updateTechSupportNav`, `renderTechSupport`, `_tsGotoPage`, `_sortTechSupport`, `exportTechSupportXLSX`, `filterTechSupport`, `renderTechSupportDetail`, `doRespondTechSupport`, `doCompleteTechSupport`, `doDeleteTechSupport`
- POPUP MODAL HELPER (6056-6080)：`_showPopupModal`
- 维修结果记忆 (6081-6187)：`_loadRepairResultHistory`, `_saveRepairResultHistory`, `_addRepairResultToHistory`, `_getRepairResultHistory`, `_clearRepairResultHistory`
- `_showLayeredPopup`, `_toggleAllTransferChecks`

数据属性：`_tsPage`, `_tsItems`, `_tsFilter`, `_tsViewMode`, `_tsSortCol`, `_tsSortDir`, `_tsDetailId`, `_repairResultHistory`

⚠️ `_tsBucket` 常量（app.js 第 9 行）需在 tech-support.js 顶部重新定义

**验证**：技术支持列表/详情、响应/完成/删除、XLSX 导出、维修结果记忆、弹窗

---

### 阶段 5：TRANSACTIONS + EXPORT 剩余（合并入现有模块，净减 ~390 行）

**扩展** `js/ui/transactions.js`

追加 7 个未覆盖方法：`_renderPageButtons`, `_restoreFilterValues`, `setPageSize`, `toggleFilterBar`, `toggleTxDateFilter`, `toggleTxDetail`, `toggleTxCard`

同时把该段已覆盖的重复方法体改为桩

**扩展** `js/ui/settings.js`

追加 2 个未覆盖方法：`exportXLSX`, `printTransactions`

同时把该段已覆盖的重复方法体改为桩

**验证**：流水分页/筛选/页大小；XLSX 导出/打印

---

### 阶段 6：AFTER-SALES 剩余 + SN CODES 剩余（合并入现有模块，净减 ~530 行）

**扩展** `js/ui/sn-registry.js`

追加 8 个 after-sales 未覆盖方法：`filterAfterSales`, `_showShipDialog`, `_filterShipItems`, `_selectAllShip`, `_showRepairCompleteDialog`, `_filterRepairItems`, `_selectAllRepair`, `_showAfterSalesTransactions`

追加 1 个 SN CODES 未覆盖方法：`_doRenderSNCodes`

同时把已覆盖的重复方法体改为桩

**验证**：售后列表筛选、发货对话框、维修完成对话框

---

### 阶段 7：MACHINE MANAGEMENT 扩展（2,392 行 → 桩 ~100 行，净减 ~1,900 行）

**扩展** `js/ui/machines.js`（302 行 → ~2,000 行）

追加约 26 个未覆盖方法，包括：
- 表单联动：`_onMachineStatusChange`, `_onOfflineTypeChange`, `_onMachineSnDamageChange`, `_onQtOfflineTypeChange`, `_updateMachineSNFields`, `_onMachineSNInput`, `_onSnDamageChange`, `_onQtSNInput`
- 表单预设：`showMachineFormWithPreset`, `_getTogglePreview`, `_renderMachineSNPairs`
- 快捷操作：`quickMachineOnline`, `quickMachineOffline`, `_showQuickToggleForm`
- 批量/详情：`showBulkMachineImport`, `showOnlineMachineBreakdown`, `showTotalInventoryDetail`
- SN 辅助：`_getAvailableSNs`, `_buildOfflineSNFields`, `_buildSNSelects`
- 附件：`_hasValidAttachment`, `_isImageAttachment`, `_showSNAttachment`
- 导入导出：`_exportAllSNExcel`, `_importLRJSON`, `_quickLRInbound`
- 共享：`_showInfoModal`

⚠️ 高风险，建议分两次提交（先表单+渲染，再附件+导入导出）

**验证**：机器卡片/表格、新增/编辑表单联动、快捷上下线、SN 配对、附件上传、批量导入、Excel 导出

---

### 阶段 8：DASHBOARD + CHARTS + HELPERS（净减 ~1,220 行）

**新建** `js/ui/dashboard.js`

迁移：
- `renderDashboard`, `_renderRecentTransactions`（真正未覆盖的 2 个方法，约 230 行）
- CHARTS 剩余：`_drawInventoryTrendChart`, `_drawMachineStatusChart`, `_drawLineChart`, `_drawPieChart`, `_drawBarChart`

同时把 DASHBOARD 段已被 inventory.js 覆盖的 13 个重复方法体改为桩（这是行数缩减主来源）

**新建** `js/ui/format-helpers.js`

迁移：`_formatTime`, `_relativeTime`, `_cumulativeSum`, `_getHandType`, `_getEquipmentType`, `_isGloveType`, `_snToInvType`, `_snDatalist`

**新建** `js/ui/attachments.js`

迁移：`_showSNAutocomplete`, `_hideSNAutocomplete`, `_readAttachment`, `_attachmentThumb`

**新建** `js/ui/core-helpers.js`

迁移：`refreshCurrentTab`, `refreshCurrentView`, `startAutoRefresh`, `bindKeyboardShortcuts`, `globalSearch`, `showKeyboardHelp`

**保留在 app.js 核心**：`_currentUser`, `_isPrivileged`, `_isSuperAdmin`（高频权限判断，保留自包含）

**验证**：仪表盘卡片/图表、全局搜索、快捷键、SN 自动补全、附件上传、自动刷新

---

## app.js 最终结构（~3,700 行）

保留内容：
1. `_tsBucket` 顶层常量
2. `App` 对象字面量（数据属性）
3. `init()` 初始化入口
4. **AUTH/LOGIN**：`showLogin`, `_showMachineCodeSelect`, `switchSystem`, `showChangePasswordForm`, `_showAuthErrorModal`
5. **CORE**：`applyTheme`, `toggleTheme`, `bindNavigation`, `switchTab`, `_setCookie`, `_getCookie`, `_deleteCookie`, `bindGlobalEvents`, `updateUserDisplay`, `updateHealthDot`, `startHealthCheck`, `initStatusBar`, `refreshSidebarInventory`, `onSidebarDeviceChange`
6. **AUTH HELPERS**：`_currentUser`, `_isPrivileged`, `_isSuperAdmin`
7. 全部已迁移方法的 `console.warn('[App] xxx is a fallback stub')` 桩

## 执行顺序与风险

按风险递增：**1 → 2 → 3 → 4 → 5 → 6 → 7 → 8**

| 阶段 | 净减行数 | 风险 | 回归范围 |
|------|---------|------|---------|
| 1 部署 | ~1,384 | 低 | 仅运维入口 |
| 2 SN QR + 机器链接 | ~336 | 低 | 次要页面 |
| 3 用户管理 | ~356 | 中 | 用户增删改/权限 |
| 4 技术支持 | ~586 | 中 | 工单流程/导出 |
| 5 流水+导出 | ~390 | 低 | 分页/导出 |
| 6 售后+SN | ~530 | 中 | 售后/发货/维修 |
| 7 机器扩展 | ~1,900 | 高 | 核心业务表单 |
| 8 仪表盘+helpers | ~1,220 | 高 | 落地页/全局工具 |

## 每阶段通用步骤

1. 从 app.js 提取方法到目标模块文件（`UIUtils.register` 模式）
2. 在 app.js 中将被提取方法改为 `console.warn` 桩
3. 同时将同段已覆盖的重复方法体也改为桩
4. 更新 index.html：新增 script 标签 / 递增 `?v` 版本号
5. 更新 version.json 对应字段
6. 刷新浏览器测试（无需重启后端）

## 关键注意事项

- **数据属性初始化**：工厂内必须 `app._xxx = initialValue`，确保迁移后属性存在
- **`_tsBucket` 常量**：迁移到 tech-support.js 顶部重新定义
- **`_viewUserPassword` 重复定义**：阶段 3 去重，仅保留 7681 行版本
- **版本号同步**：index.html `?v=N` 与 version.json 需同步递增
- **模块加载顺序无关**：UIUtils.init() 统一初始化，文件加载顺序不影响正确性
