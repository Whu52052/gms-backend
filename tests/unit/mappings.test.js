/**
 * Unit tests for lib/mappings.js — pure data-transformation helpers.
 * Run: node --test tests/unit/mappings.test.js
 */
const { test, describe } = require('node:test');
const assert = require('node:assert');
const { fmtDuration, getStatusLabel, snToInvType, invTypeToSNFields } = require('../../lib/mappings');

describe('fmtDuration', () => {
  test('null/undefined → "-"', () => {
    assert.strictEqual(fmtDuration(null), '-');
    assert.strictEqual(fmtDuration(undefined), '-');
  });

  test('< 60s → "<1分钟"', () => {
    assert.strictEqual(fmtDuration(0), '<1分钟');
    assert.strictEqual(fmtDuration(30), '<1分钟');
    assert.strictEqual(fmtDuration(59), '<1分钟');
  });

  test('60s-3599s → "X分钟"', () => {
    assert.strictEqual(fmtDuration(60), '1分钟');
    assert.strictEqual(fmtDuration(90), '2分钟');
    assert.strictEqual(fmtDuration(600), '10分钟');
  });

  test('3600s+ → "X时Y分" or "X小时"', () => {
    assert.strictEqual(fmtDuration(3600), '1小时');
    assert.strictEqual(fmtDuration(3700), '1时2分');
    assert.strictEqual(fmtDuration(7200), '2小时');
  });

  test('rounds fractional seconds', () => {
    assert.strictEqual(fmtDuration(59.9), '<1分钟');
    assert.strictEqual(fmtDuration(60.4), '1分钟');
    assert.strictEqual(fmtDuration(90.6), '2分钟');
  });
});

describe('getStatusLabel', () => {
  test('known statuses → Chinese labels', () => {
    assert.strictEqual(getStatusLabel('available'), '库存可用');
    assert.strictEqual(getStatusLabel('in_use'), '使用中');
    assert.strictEqual(getStatusLabel('damaged'), '已损坏');
    assert.strictEqual(getStatusLabel('in_repair'), '售后维修中');
    assert.strictEqual(getStatusLabel('transferred'), '已转出');
    assert.strictEqual(getStatusLabel('repaired'), '已修复');
    assert.strictEqual(getStatusLabel('shipped'), '发货维修中');
    assert.strictEqual(getStatusLabel('scrapped'), '已报废');
  });

  test('unknown status → returns input unchanged', () => {
    assert.strictEqual(getStatusLabel('unknown'), 'unknown');
    assert.strictEqual(getStatusLabel('custom_state'), 'custom_state');
  });
});

describe('snToInvType', () => {
  test('glove + left/right → left_glove/right_glove', () => {
    assert.strictEqual(snToInvType('glove', 'left'), 'left_glove');
    assert.strictEqual(snToInvType('glove', 'right'), 'right_glove');
  });

  test('dexterous_hand + left/right → left_dexterous_hand/right_dexterous_hand', () => {
    assert.strictEqual(snToInvType('dexterous_hand', 'left'), 'left_dexterous_hand');
    assert.strictEqual(snToInvType('dexterous_hand', 'right'), 'right_dexterous_hand');
  });

  test('glove without valid handType → null', () => {
    assert.strictEqual(snToInvType('glove', null), null);
    assert.strictEqual(snToInvType('glove', ''), null);
    assert.strictEqual(snToInvType('glove', 'middle'), null);
  });

  test('dexterous_hand without valid handType → null', () => {
    assert.strictEqual(snToInvType('dexterous_hand', null), null);
  });

  test('custom equipmentType with handType → equipmentType_handType', () => {
    assert.strictEqual(snToInvType('custom', 'left'), 'custom_left');
    assert.strictEqual(snToInvType('pika', 'right'), 'pika_right');
  });

  test('equipmentType without handType → equipmentType', () => {
    assert.strictEqual(snToInvType('gripper', null), 'gripper');
    assert.strictEqual(snToInvType('pika', ''), 'pika');
  });

  test('null/empty inputs → null', () => {
    assert.strictEqual(snToInvType(null, null), null);
    assert.strictEqual(snToInvType('', ''), null);
  });
});

describe('invTypeToSNFields', () => {
  test('standard inventory types → [equipmentType, handType]', () => {
    assert.deepStrictEqual(invTypeToSNFields('left_glove'), ['glove', 'left']);
    assert.deepStrictEqual(invTypeToSNFields('right_glove'), ['glove', 'right']);
    assert.deepStrictEqual(invTypeToSNFields('left_dexterous_hand'), ['dexterous_hand', 'left']);
    assert.deepStrictEqual(invTypeToSNFields('right_dexterous_hand'), ['dexterous_hand', 'right']);
  });

  test('custom type with _left/_right suffix → split correctly', () => {
    assert.deepStrictEqual(invTypeToSNFields('my_custom_left'), ['my_custom', 'left']);
    assert.deepStrictEqual(invTypeToSNFields('pika_right'), ['pika', 'right']);
  });

  test('type without hand suffix → [type, ""]', () => {
    assert.deepStrictEqual(invTypeToSNFields('gripper'), ['gripper', '']);
    assert.deepStrictEqual(invTypeToSNFields('simple'), ['simple', '']);
  });

  test('round-trip: snToInvType → invTypeToSNFields', () => {
    const pairs = [
      ['glove', 'left'], ['glove', 'right'],
      ['dexterous_hand', 'left'], ['dexterous_hand', 'right'],
    ];
    for (const [eq, hand] of pairs) {
      const invType = snToInvType(eq, hand);
      const [eq2, hand2] = invTypeToSNFields(invType);
      assert.strictEqual(eq2, eq);
      assert.strictEqual(hand2, hand);
    }
  });
});
