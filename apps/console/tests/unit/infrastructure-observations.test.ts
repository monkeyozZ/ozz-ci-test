import { describe, expect, it } from 'vitest';
import {
  bytesLabel,
  cpuLabel,
  credentialExpiryLabel,
  sampleFreshness,
  usagePercent,
} from '../../src/components/infrastructure/format';

describe('基础设施观察值的呈现', () => {
  it('缺失、无效和真实零值始终可区分', () => {
    for (const value of [null, undefined, Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      expect(bytesLabel(value)).toBe('未知');
      expect(cpuLabel(value)).toBe('未知');
      expect(usagePercent(value, 10)).toBeNull();
    }
    expect(bytesLabel(0)).toBe('0 B');
    expect(cpuLabel(0)).toBe('0 核');
    expect(cpuLabel(0.000002)).toBe('< 0.01 mCPU');
    expect(cpuLabel(0.0002)).toBe('0.2 mCPU');
    expect(cpuLabel(0.5)).toBe('500 mCPU');
    expect(cpuLabel(2)).toBe('2 核');
    expect(usagePercent(0, 2)).toBe(0);
    expect(usagePercent(0, null)).toBeNull();
    expect(usagePercent(1, 0)).toBeNull();
    expect(bytesLabel(8 * 1024 ** 3)).toBe('8 GiB');
    expect(usagePercent(3, 2)).toBe(150);
  });

  it('历史采样和不可确认的时间不能被当作当前值', () => {
    const now = Date.parse('2026-10-25T04:00:00.000Z');
    expect(sampleFreshness('2026-10-25T03:59:30.000Z', now)).toBe('fresh');
    expect(sampleFreshness('2026-10-25T03:50:00.000Z', now)).toBe('stale');
    expect(sampleFreshness('2026-10-25T03:58:29.000Z', now)).toBe('stale');
    expect(sampleFreshness('2026-10-25T05:00:00.000Z', now)).toBe('unknown');
    expect(sampleFreshness(null, now)).toBe('unknown');
    expect(sampleFreshness('not-a-date', now)).toBe('unknown');
  });
  it('到期日期保留年份，下一年的同日不会被误读为已经过期', () => {
    expect(credentialExpiryLabel('2027-10-25T04:00:00.000Z')).toContain('2027');
    expect(credentialExpiryLabel(null)).toContain('未知');
  });
});
