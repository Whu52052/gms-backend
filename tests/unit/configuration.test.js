'use strict';

const test = require('node:test');
const assert = require('node:assert');
const createConfigurationHandlers = require('../../src/handlers/configuration');

function setup() {
  const calls = { sql: [], events: [], responses: [], cached: [] };
  const conn = {
    beginTransaction: async () => { calls.began = true; }, commit: async () => { calls.committed = true; },
    rollback: async () => { calls.rolledBack = true; }, release: () => { calls.released = true; },
    execute: async (sql, params) => { calls.sql.push({ sql, params }); },
  };
  const handlers = createConfigurationHandlers({
    pool: { getConnection: async () => conn }, sendJSON: (res, body, status = 200) => calls.responses.push({ body, status }),
    _cached: async (key, fn) => { calls.cached.push(key); return fn(); }, readJSONArray: async table => [{ id: table }],
    deleteJSON: async (table, id) => { calls.deleted = { table, id }; }, broadcastSSE: event => calls.events.push(event),
  });
  return { handlers, calls };
}

test('configuration: 读取配置使用对应缓存和表', async () => {
  const { handlers, calls } = setup(); await handlers.handleGetEquipmentConfig({}, {});
  assert.deepStrictEqual(calls.cached, ['equipment_config']);
  assert.deepStrictEqual(calls.responses[0].body, [{ id: 'equipment_config' }]);
});

test('configuration: 非管理员不能保存配置', async () => {
  const { handlers, calls } = setup(); await handlers.handleSaveInventoryConfig({}, {}, { role: 'user' }, []);
  assert.deepStrictEqual(calls.responses[0], { body: { error: '无权限修改库存配置' }, status: 403 });
  assert.strictEqual(calls.began, undefined);
});

test('configuration: 保存配置在事务提交后广播事件', async () => {
  const { handlers, calls } = setup(); await handlers.handleSaveEquipmentConfig({}, {}, { role: 'admin' }, [{ id: 'glove' }]);
  assert.ok(calls.began && calls.committed && calls.released);
  assert.match(calls.sql[0].sql, /DELETE FROM equipment_config/); assert.match(calls.sql[1].sql, /INSERT INTO equipment_config/);
  assert.deepStrictEqual(calls.events, ['equipment_config_updated']);
});

test('configuration: 删除配置检查权限并广播对应事件', async () => {
  const { handlers, calls } = setup(); await handlers.handleDeleteInventoryConfig({}, {}, { role: 'superadmin' }, 'item-1');
  assert.deepStrictEqual(calls.deleted, { table: 'inventory_config', id: 'item-1' }); assert.deepStrictEqual(calls.events, ['inventory_config_updated']);
});
