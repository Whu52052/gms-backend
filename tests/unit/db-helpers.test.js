/**
 * Unit tests for lib/db-helpers.js — DB-layer business logic with mock pool.
 * Run: node --test tests/unit/db-helpers.test.js
 *
 * Uses a mock pool/conn object (no real MySQL connection needed).
 */
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert');
const { getInventoryBreakdowns, insertTransaction } = require('../../lib/db-helpers');

// ==================== Mock Pool Factory ====================
function mockPool(rows) {
  return {
    execute: async (sql, params) => {
      // Return different rows based on the SQL query type
      if (sql.includes('GROUP BY equipmentType, handType, status')) {
        return [rows];
      }
      // INSERT statements return empty result
      return [];
    },
    _inserts: [],
  };
}

// Mock conn that records all INSERT calls
function mockConn() {
  const inserts = [];
  return {
    execute: async (sql, params) => {
      if (sql.startsWith('INSERT INTO transactions')) {
        inserts.push({ sql, params });
      }
      return [];
    },
    _inserts: inserts,
  };
}

describe('getInventoryBreakdowns', () => {
  test('returns empty map for empty sn_registry', async () => {
    const pool = mockPool([]);
    const map = await getInventoryBreakdowns(pool);
    assert.strictEqual(Object.keys(map).length, 0);
  });

  test('aggregates counts by invType and status', async () => {
    const rows = [
      { equipmentType: 'glove', handType: 'left', status: 'available', cnt: 10 },
      { equipmentType: 'glove', handType: 'left', status: 'in_use', cnt: 5 },
      { equipmentType: 'glove', handType: 'right', status: 'damaged', cnt: 2 },
      { equipmentType: 'glove', handType: 'right', status: 'transferred', cnt: 3 },
      { equipmentType: 'dexterous_hand', handType: 'left', status: 'in_repair', cnt: 1 },
    ];
    const pool = mockPool(rows);
    const map = await getInventoryBreakdowns(pool);

    assert.strictEqual(map['left_glove'].available, 10);
    assert.strictEqual(map['left_glove'].inUse, 5);
    assert.strictEqual(map['left_glove'].damaged, 0);
    assert.strictEqual(map['left_glove'].transferred, 0);

    assert.strictEqual(map['right_glove'].damaged, 2);
    assert.strictEqual(map['right_glove'].transferred, 3);
    assert.strictEqual(map['right_glove'].available, 0);

    assert.strictEqual(map['left_dexterous_hand'].inRepair, 1);
  });

  test('all status fields present even when zero', async () => {
    const rows = [
      { equipmentType: 'glove', handType: 'left', status: 'available', cnt: 5 },
    ];
    const pool = mockPool(rows);
    const map = await getInventoryBreakdowns(pool);
    const entry = map['left_glove'];
    assert.ok('available' in entry);
    assert.ok('inUse' in entry);
    assert.ok('damaged' in entry);
    assert.ok('inRepair' in entry);
    assert.ok('transferred' in entry);
    assert.strictEqual(entry.available, 5);
    assert.strictEqual(entry.inUse, 0);
  });

  test('skips rows that produce null invType', async () => {
    // snToInvType returns null when:
    //  - equipmentType is null/empty (no mapping)
    //  - glove/dexterous_hand is given without a valid left/right handType
    // Custom equipmentTypes (e.g. 'gripper', 'pika') pass through as-is per
    // snToInvType's contract, so they are NOT filtered here.
    const rows = [
      { equipmentType: 'glove', handType: 'left', status: 'available', cnt: 5 },
      { equipmentType: null, handType: null, status: 'available', cnt: 99 },
      { equipmentType: 'glove', handType: null, status: 'available', cnt: 50 },
      { equipmentType: '', handType: '', status: 'damaged', cnt: 7 },
    ];
    const pool = mockPool(rows);
    const map = await getInventoryBreakdowns(pool);
    // Only left_glove should appear; the other three produce null invType
    assert.strictEqual(Object.keys(map).length, 1);
    assert.ok(map['left_glove']);
    assert.strictEqual(map['left_glove'].available, 5);
  });
});

describe('insertTransaction', () => {
  test('writes 9 columns with correct field mapping', async () => {
    const conn = mockConn();
    const tx = {
      equipmentType: 'glove',
      handType: 'left',
      direction: 'out',
      quantity: 3,
      updatedBy: 'admin',
      timestamp: '2026-08-03T10:00:00.000Z',
      note: '出库',
      refType: 'outbound',
      refId: 'order-123',
    };
    const id = await insertTransaction(conn, tx);

    assert.ok(id.startsWith('tx-'));
    assert.strictEqual(conn._inserts.length, 1);

    const { sql, params } = conn._inserts[0];
    assert.ok(sql.startsWith('INSERT INTO transactions'));
    assert.ok(sql.includes('ref_type') && sql.includes('ref_id') && sql.includes('inv_type'));
    assert.ok(sql.includes('direction') && sql.includes('quantity') && sql.includes('operator'));
    assert.ok(sql.includes('createdAt'));

    // params: [id, data_json, refType, refId, invType, direction, quantity, operator, createdAt]
    assert.strictEqual(params[0], id);                          // id
    assert.strictEqual(params[2], 'outbound');                  // ref_type
    assert.strictEqual(params[3], 'order-123');                 // ref_id
    assert.strictEqual(params[4], 'left_glove');                // inv_type (from snToInvType)
    assert.strictEqual(params[5], 'out');                       // direction
    assert.strictEqual(params[6], 3);                            // quantity (parseInt)
    assert.strictEqual(params[7], 'admin');                     // operator
    assert.strictEqual(params[8], '2026-08-03T10:00:00.000Z');   // createdAt
  });

  test('generates id when not provided', async () => {
    const conn = mockConn();
    const id = await insertTransaction(conn, { direction: 'in', quantity: 1 });
    assert.ok(id && id.startsWith('tx-'));
    assert.ok(id.length > 10); // should have random suffix
  });

  test('uses provided id when given', async () => {
    const conn = mockConn();
    const id = await insertTransaction(conn, { id: 'custom-id-123', direction: 'in', quantity: 1 });
    assert.strictEqual(id, 'custom-id-123');
  });

  test('quantity parsed as integer', async () => {
    const conn = mockConn();
    await insertTransaction(conn, { quantity: '5', direction: 'in' });
    assert.strictEqual(conn._inserts[0].params[6], 5);
    assert.strictEqual(typeof conn._inserts[0].params[6], 'number');
  });

  test('null quantity → 0', async () => {
    const conn = mockConn();
    await insertTransaction(conn, { direction: 'in' });
    assert.strictEqual(conn._inserts[0].params[6], 0);
  });

  test('falls back to updatedBy for operator when operator not set', async () => {
    const conn = mockConn();
    await insertTransaction(conn, { updatedBy: 'user1', direction: 'in', quantity: 1 });
    assert.strictEqual(conn._inserts[0].params[7], 'user1');
  });

  test('inv_type falls back to equipmentType when handType missing', async () => {
    const conn = mockConn();
    await insertTransaction(conn, { equipmentType: 'gripper', direction: 'in', quantity: 1 });
    // snToInvType('gripper', undefined) → 'gripper' (fallback)
    assert.strictEqual(conn._inserts[0].params[4], 'gripper');
  });

  test('data JSON column includes all tx fields + id', async () => {
    const conn = mockConn();
    const tx = { id: 'test-1', direction: 'in', quantity: 2, note: 'test note', updatedBy: 'admin' };
    await insertTransaction(conn, tx);
    const dataJson = conn._inserts[0].params[1];
    const data = JSON.parse(dataJson);
    assert.strictEqual(data.id, 'test-1');
    assert.strictEqual(data.direction, 'in');
    assert.strictEqual(data.note, 'test note');
  });
});
