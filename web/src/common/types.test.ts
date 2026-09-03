// ITSM 状态归一化单测（与后端 _legacyStatus / 旧版 _tsBucket 对齐）
import { describe, expect, it } from 'vitest';
import { tsBucket } from './types';

describe('tsBucket', () => {
  it('新枚举映射到旧 bucket', () => {
    expect(tsBucket('open')).toBe('pending');
    expect(tsBucket('assigned')).toBe('pending');
    expect(tsBucket('in_progress')).toBe('responded');
    expect(tsBucket('reopened')).toBe('responded');
    expect(tsBucket('resolved')).toBe('completed');
    expect(tsBucket('closed')).toBe('completed');
  });
  it('旧状态原样保留', () => {
    expect(tsBucket('pending')).toBe('pending');
    expect(tsBucket('responded')).toBe('responded');
    expect(tsBucket('completed')).toBe('completed');
  });
  it('未知/空值兜底为 pending', () => {
    expect(tsBucket(undefined)).toBe('pending');
    expect(tsBucket('')).toBe('pending');
    expect(tsBucket('weird-status')).toBe('weird-status');
  });
});
