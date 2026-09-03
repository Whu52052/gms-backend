// 运营端本地数据纯函数单测
import { describe, expect, it } from 'vitest';
import { catColor, fmtDuration } from './opsLocalData';

describe('fmtDuration', () => {
  it('空值', () => {
    expect(fmtDuration(null)).toBe('-');
    expect(fmtDuration(undefined)).toBe('-');
  });
  it('小于 1 分钟', () => {
    expect(fmtDuration(30)).toBe('<1分钟');
  });
  it('分钟级', () => {
    expect(fmtDuration(300)).toBe('5分钟');
  });
  it('小时级', () => {
    expect(fmtDuration(3600)).toBe('1小时');
    expect(fmtDuration(5400)).toBe('1时30分');
  });
});

describe('catColor', () => {
  it('同分类颜色稳定', () => {
    expect(catColor('硬件')).toBe(catColor('硬件'));
  });
  it('返回合法颜色值', () => {
    expect(catColor('任意分类')).toMatch(/^#[0-9a-f]{6}$/);
    expect(catColor(undefined)).toMatch(/^#[0-9a-f]{6}$/);
  });
});
