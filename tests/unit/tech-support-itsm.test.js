/**
 * tests/unit/tech-support-itsm.test.js
 * Phase A 单元测试：ITSM 状态机兼容层 + 默认值 + 分类推断
 *
 * 覆盖：
 * 1. _legacyStatus 映射：6 个新状态 → 4 个旧状态
 * 2. ITSM_DEFAULTS 完整性
 * 3. _inferCategory：按 faultType 推断分类
 * 4. STATUS_LEGACY_MAP 完整性
 * 5. 状态机校验（合法/非法转换路径）— Phase C 将扩展
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');

const createTechSupportHandlers = require('../../src/handlers/tech-support');

// 最小 mock deps（仅需 pool 占位以让工厂函数构造）
const mockDeps = {
  pool: {}, sendJSON: () => {}, _cached: () => Promise.resolve([]),
  readJSONById: () => null, deleteJSON: () => {}, saveMachine: () => {},
  saveTechSupport: () => {}, _syncInventoryFromSN: () => {},
  broadcastChange: () => {}, realtime: {}, feishu: {}, fmtDuration: () => '',
};

const handlers = createTechSupportHandlers(mockDeps);

// ============================================================
// 1. _legacyStatus 映射
// ============================================================
test('_legacyStatus: 新枚举正确映射到旧枚举', () => {
  assert.strictEqual(handlers._legacyStatus('open'), 'pending');
  assert.strictEqual(handlers._legacyStatus('assigned'), 'pending');
  assert.strictEqual(handlers._legacyStatus('in_progress'), 'responded');
  assert.strictEqual(handlers._legacyStatus('reopened'), 'responded');
  assert.strictEqual(handlers._legacyStatus('resolved'), 'completed');
  assert.strictEqual(handlers._legacyStatus('closed'), 'completed');
});

test('_legacyStatus: 未知状态原样返回', () => {
  assert.strictEqual(handlers._legacyStatus('unknown'), 'unknown');
  assert.strictEqual(handlers._legacyStatus(''), '');
  assert.strictEqual(handlers._legacyStatus('custom_state'), 'custom_state');
});

test('_legacyStatus: 旧状态字符串原样返回（已是旧枚举）', () => {
  assert.strictEqual(handlers._legacyStatus('pending'), 'pending');
  assert.strictEqual(handlers._legacyStatus('responded'), 'responded');
  assert.strictEqual(handlers._legacyStatus('completed'), 'completed');
});

// ============================================================
// 2. STATUS_LEGACY_MAP 完整性
// ============================================================
test('STATUS_LEGACY_MAP: 包含所有 6 个新枚举状态', () => {
  const keys = Object.keys(handlers.STATUS_LEGACY_MAP);
  assert.ok(keys.includes('open'), '应包含 open');
  assert.ok(keys.includes('assigned'), '应包含 assigned');
  assert.ok(keys.includes('in_progress'), '应包含 in_progress');
  assert.ok(keys.includes('reopened'), '应包含 reopened');
  assert.ok(keys.includes('resolved'), '应包含 resolved');
  assert.ok(keys.includes('closed'), '应包含 closed');
  assert.strictEqual(keys.length, 6, '应有 6 个映射');
});

test('STATUS_LEGACY_MAP: 所有值都是合法旧枚举', () => {
  const validLegacy = ['pending', 'responded', 'completed'];
  Object.values(handlers.STATUS_LEGACY_MAP).forEach(v => {
    assert.ok(validLegacy.includes(v), `值 ${v} 应是合法旧枚举`);
  });
});

// ============================================================
// 3. ITSM_DEFAULTS 完整性
// ============================================================
test('ITSM_DEFAULTS: 包含所有必需字段且默认值正确', () => {
  const d = handlers.ITSM_DEFAULTS;
  assert.strictEqual(d.priority, 'P2', '默认优先级 P2');
  assert.strictEqual(d.severity, 'S3', '默认严重度 S3');
  assert.strictEqual(d.category, 'hardware', '默认分类 hardware');
  assert.strictEqual(d.assigneeId, null, 'assigneeId 默认 null');
  assert.strictEqual(d.assigneeName, null, 'assigneeName 默认 null');
  assert.strictEqual(d.dueDate, null, 'dueDate 默认 null');
  assert.strictEqual(d.slaRespondBy, null, 'slaRespondBy 默认 null');
  assert.strictEqual(d.slaResolveBy, null, 'slaResolveBy 默认 null');
  assert.strictEqual(d.slaBreached, false, 'slaBreached 默认 false');
  assert.strictEqual(d.reopenedCount, 0, 'reopenedCount 默认 0');
  assert.deepStrictEqual(d.attachedFileIds, [], 'attachedFileIds 默认空数组');
  assert.strictEqual(d.resolutionNote, '', 'resolutionNote 默认空字符串');
  assert.strictEqual(d.kbTag, null, 'kbTag 默认 null');
  assert.deepStrictEqual(d.tags, [], 'tags 默认空数组');
});

// ============================================================
// 4. _inferCategory 分类推断
// ============================================================
test('_inferCategory: 软件类故障识别', () => {
  assert.strictEqual(handlers._inferCategory('软件闪退'), 'software');
  assert.strictEqual(handlers._inferCategory('无法启动'), 'software');
  assert.strictEqual(handlers._inferCategory('连接失败'), 'software');
  assert.strictEqual(handlers._inferCategory('数据异常'), 'software');
  assert.strictEqual(handlers._inferCategory('程序崩溃'), 'software');
});

test('_inferCategory: 网络类故障识别', () => {
  assert.strictEqual(handlers._inferCategory('网络断开'), 'network');
  assert.strictEqual(handlers._inferCategory('掉线'), 'network');
  assert.strictEqual(handlers._inferCategory('延迟高'), 'network');
});

test('_inferCategory: 操作咨询类识别', () => {
  assert.strictEqual(handlers._inferCategory('操作咨询'), 'operation');
  assert.strictEqual(handlers._inferCategory('使用培训'), 'operation');
});

test('_inferCategory: 硬件类故障识别', () => {
  assert.strictEqual(handlers._inferCategory('硬件损坏'), 'hardware');
  assert.strictEqual(handlers._inferCategory('设备故障'), 'hardware');
  assert.strictEqual(handlers._inferCategory('手套坏了'), 'hardware');
});

test('_inferCategory: 空值与其他默认 hardware', () => {
  assert.strictEqual(handlers._inferCategory(''), 'hardware');
  assert.strictEqual(handlers._inferCategory(null), 'hardware');
  assert.strictEqual(handlers._inferCategory(undefined), 'hardware');
  assert.strictEqual(handlers._inferCategory('其他问题'), 'other');
});

// ============================================================
// 5. 工厂函数构造完整性
// ============================================================
test('createTechSupportHandlers: 返回所有 handler 函数 + 兼容层', () => {
  const h = createTechSupportHandlers(mockDeps);
  assert.strictEqual(typeof h.handleGetTechSupportList, 'function');
  assert.strictEqual(typeof h.handleGetTechSupportDetail, 'function');
  assert.strictEqual(typeof h.handleGetRepairResults, 'function');
  assert.strictEqual(typeof h.handleSubmitTechSupport, 'function');
  assert.strictEqual(typeof h.handleRespondTechSupport, 'function');
  assert.strictEqual(typeof h.handleCompleteTechSupport, 'function');
  assert.strictEqual(typeof h.handleDeleteTechSupport, 'function');
  assert.strictEqual(typeof h.handleExportTechSupportXLSX, 'function');
  // ITSM 兼容层
  assert.strictEqual(typeof h._legacyStatus, 'function');
  assert.strictEqual(typeof h._inferCategory, 'function');
  assert.ok(h.ITSM_DEFAULTS, 'ITSM_DEFAULTS 应存在');
  assert.ok(h.STATUS_LEGACY_MAP, 'STATUS_LEGACY_MAP 应存在');
});

test('createTechSupportHandlers: 缺少 saveTechSupport 仍可构造（向后兼容）', () => {
  // 不传 saveTechSupport 时工厂仍应能构造（仅运行时调用会报错）
  const minimalDeps = { ...mockDeps, saveTechSupport: undefined };
  const h = createTechSupportHandlers(minimalDeps);
  assert.strictEqual(typeof h.handleSubmitTechSupport, 'function');
});
