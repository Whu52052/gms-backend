// 格式化函数单测（移植自 js/ui/format-helpers.js 的纯函数）
import { describe, expect, it } from 'vitest';
import {
  cumulativeSum, equipmentLabel, formatTime, getEquipmentType, getHandType,
  isGloveType, naturalCompare, relativeTime, snToInvType,
} from './format';

describe('formatTime', () => {
  it('空值返回 -', () => {
    expect(formatTime(null)).toBe('-');
    expect(formatTime(undefined)).toBe('-');
    expect(formatTime('')).toBe('-');
  });
  it('无效时间返回 -', () => {
    expect(formatTime('not-a-date')).toBe('-');
  });
  it('格式化为 yyyy-MM-dd HH:mm:ss', () => {
    const d = new Date(2025, 0, 5, 9, 8, 7);
    expect(formatTime(d.getTime())).toBe('2025-01-05 09:08:07');
  });
});

describe('relativeTime', () => {
  it('一分钟内显示刚刚', () => {
    expect(relativeTime(Date.now() - 30 * 1000)).toBe('刚刚');
  });
  it('分钟级', () => {
    expect(relativeTime(Date.now() - 5 * 60 * 1000)).toBe('5分钟前');
  });
  it('小时级', () => {
    expect(relativeTime(Date.now() - 3 * 3600 * 1000)).toBe('3小时前');
  });
  it('天级', () => {
    expect(relativeTime(Date.now() - 2 * 86400 * 1000)).toBe('2天前');
  });
});

describe('库存类型拆解', () => {
  it('getHandType', () => {
    expect(getHandType('left_glove')).toBe('left');
    expect(getHandType('right_dexterous_hand')).toBe('right');
    expect(getHandType('gripper_left')).toBe('left');
    expect(getHandType('gripper_right')).toBe('right');
    expect(getHandType('gripper')).toBeNull();
  });
  it('getEquipmentType', () => {
    expect(getEquipmentType('left_glove')).toBe('glove');
    expect(getEquipmentType('right_dexterous_hand')).toBe('dexterous_hand');
    expect(getEquipmentType('gripper_left')).toBe('gripper_left');
  });
  it('isGloveType', () => {
    expect(isGloveType('left_glove')).toBe(true);
    expect(isGloveType('gripper_left')).toBe(true);
    expect(isGloveType('gripper')).toBe(false);
  });
  it('snToInvType', () => {
    expect(snToInvType('glove', 'left')).toBe('left_glove');
    expect(snToInvType('glove', 'right')).toBe('right_glove');
    expect(snToInvType('dexterous_hand', 'left')).toBe('left_dexterous_hand');
    expect(snToInvType('gripper', 'right')).toBe('gripper_right');
    expect(snToInvType('gripper')).toBe('gripper');
    expect(snToInvType()).toBe('left_glove');
  });
  it('equipmentLabel', () => {
    expect(equipmentLabel('glove', 'left')).toBe('左手手套');
    expect(equipmentLabel('dexterous_hand', 'right')).toBe('右手灵巧手');
    expect(equipmentLabel('dexterous_hand')).toBe('灵巧手');
    expect(equipmentLabel('gripper')).toBe('夹爪(Pika)');
    expect(equipmentLabel()).toBe('-');
  });
});

describe('cumulativeSum', () => {
  it('累计求和', () => {
    expect(cumulativeSum([1, 2, 3])).toEqual([1, 3, 6]);
    expect(cumulativeSum([])).toEqual([]);
  });
});

describe('naturalCompare', () => {
  it('同前缀按数字排序', () => {
    expect(['W10', 'W2', 'W1'].sort(naturalCompare)).toEqual(['W1', 'W2', 'W10']);
  });
  it('纯数字按数值排序', () => {
    expect(naturalCompare('9', '10')).toBeLessThan(0);
  });
});
