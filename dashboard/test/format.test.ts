import { describe, expect, it } from 'vitest';
import { count, cronToText, discount, money, relativeTime } from '../src/format.js';

describe('money', () => {
  it('reads minor units, not major ones', () => {
    // 5000 halalas is 50 riyals, not 5000.
    expect(money('5000', 'SAR')).toMatch(/50\.00/);
    expect(money(1, 'SAR')).toMatch(/0\.01/);
  });

  it('formats an unfamiliar but well-formed currency code', () => {
    // Intl handles any three-letter code; it just prefixes the code itself.
    expect(money(12345, 'XYZ')).toContain('123.45');
  });

  it('falls back rather than throwing on a malformed code', () => {
    expect(money(12345, 'nonsense')).toBe('123.45 nonsense');
  });

  it('says so rather than guessing when the value is not a number', () => {
    expect(money('not a number', 'SAR')).toBe('—');
  });
});

describe('relativeTime', () => {
  const now = new Date('2026-09-21T12:00:00.000Z');

  it('describes the recent past', () => {
    expect(relativeTime('2026-09-21T11:57:00.000Z', now)).toMatch(/3 minutes ago/);
    expect(relativeTime('2026-09-21T09:00:00.000Z', now)).toMatch(/3 hours ago/);
    expect(relativeTime('2026-09-18T12:00:00.000Z', now)).toMatch(/3 days ago/);
  });

  it('describes the near future, for an expiry', () => {
    expect(relativeTime('2026-09-21T12:10:00.000Z', now)).toMatch(/in 10 minutes/);
  });

  it('collapses the last few seconds', () => {
    expect(relativeTime('2026-09-21T11:59:58.000Z', now)).toBe('just now');
  });

  it('does not invent a time from nonsense', () => {
    expect(relativeTime('whenever', now)).toBe('—');
  });
});

describe('cronToText', () => {
  it('describes the shapes this engine uses', () => {
    expect(cronToText('*/5 * * * *')).toBe('every 5 minutes');
    expect(cronToText('0 * * * *')).toBe('hourly, on the hour');
    expect(cronToText('0 0 * * *')).toBe('daily at midnight');
    expect(cronToText('30 6 * * *')).toBe('daily at 06:30');
    expect(cronToText('0 */4 * * *')).toBe('every 4 hours');
  });

  it('shows an unfamiliar cron as itself rather than describing it wrongly', () => {
    expect(cronToText('15 3 * * 1-5')).toBe('15 3 * * 1-5');
  });
});

describe('count', () => {
  it('distinguishes zero from missing', () => {
    expect(count(0)).toBe('0');
    expect(count(undefined)).toBe('—');
  });
});

describe('discount', () => {
  it('reads a percent as basis points and a fixed amount as minor units', () => {
    expect(discount({ type: 'percent', value: 1000 }, 'SAR')).toBe('10%');
    expect(discount({ type: 'percent', value: 1250 }, 'SAR')).toBe('12.5%');
    expect(discount({ type: 'fixed', value: 2000 }, 'SAR')).toMatch(/20\.00/);
  });

  it('adds the cap and the minimum when the code has them', () => {
    const text = discount({ type: 'percent', value: 1000, maxDiscount: 5000, minSubtotal: 50000 }, 'SAR');
    expect(text).toMatch(/^10%, up to .*50\.00.*, min subtotal .*500\.00/);
  });
});
