import { describe, expect, it } from 'vitest';
import { localDate, openState, zonedToUtc } from '../../src/hours.js';
import { maskPhone, normalizeIndianMobile } from '../../src/phone.js';

const TZ = 'Asia/Kolkata';
const daily = (opens: string, closes: string) => Array.from({ length: 7 }, (_, weekday) => ({ weekday, opens, closes }));

describe('time zones', () => {
  it('converts IST wall time to UTC', () => {
    expect(zonedToUtc('2026-09-29', '10:00', TZ).toISOString()).toBe('2026-09-29T04:30:00.000Z');
  });
  it('handles DST zones', () => {
    // 2026-03-29 is the UK spring-forward day; 12:00 BST = 11:00 UTC.
    expect(zonedToUtc('2026-03-29', '12:00', 'Europe/London').toISOString()).toBe('2026-03-29T11:00:00.000Z');
  });
  it('gives the local date and weekday', () => {
    // 20:00 UTC on Tue 29 Sep is 01:30 Wed 30 Sep in India.
    expect(localDate(new Date('2026-09-29T20:00:00Z'), TZ)).toEqual({ date: '2026-09-30', weekday: 3 });
  });
});

describe('openState', () => {
  const noon = new Date('2026-09-29T06:30:00Z'); // 12:00 IST Tuesday

  it('is open during hours, with today\'s closing time', () => {
    const s = openState(noon, TZ, daily('10:00', '21:00'), new Set());
    expect(s.isOpenNow).toBe(true);
    expect(s.closesAt!.toISOString()).toBe('2026-09-29T15:30:00.000Z');
    expect(s.todayClosesAt).toEqual(s.closesAt);
    expect(s.nextOpenAt).toBeNull();
  });

  it('is closed before opening and knows when it opens', () => {
    const early = new Date('2026-09-29T02:30:00Z'); // 08:00 IST
    const s = openState(early, TZ, daily('10:00', '21:00'), new Set());
    expect(s.isOpenNow).toBe(false);
    expect(s.nextOpenAt!.toISOString()).toBe('2026-09-29T04:30:00.000Z');
    expect(s.todayClosesAt!.toISOString()).toBe('2026-09-29T15:30:00.000Z');
  });

  it('models a midday break as two intervals', () => {
    const hours = [...daily('10:00', '11:30'), ...daily('13:00', '21:00')];
    const s = openState(noon, TZ, hours, new Set());
    expect(s.isOpenNow).toBe(false);
    expect(s.nextOpenAt!.toISOString()).toBe('2026-09-29T07:30:00.000Z');
    expect(s.todayClosesAt!.toISOString()).toBe('2026-09-29T15:30:00.000Z');
  });

  it('is closed on a holiday and reopens the next day', () => {
    const s = openState(noon, TZ, daily('10:00', '21:00'), new Set(['2026-09-29']));
    expect(s.isOpenNow).toBe(false);
    expect(s.isHoliday).toBe(true);
    expect(s.todayClosesAt).toBeNull();
    expect(s.nextOpenAt!.toISOString()).toBe('2026-09-30T04:30:00.000Z');
  });

  it('is closed on a weekday with no hours', () => {
    const hours = daily('10:00', '21:00').filter((h) => h.weekday !== 2); // Tuesdays off
    expect(openState(noon, TZ, hours, new Set()).isOpenNow).toBe(false);
  });
});

describe('phone numbers', () => {
  it.each([
    ['9876543210', '+919876543210'],
    ['98765 43210', '+919876543210'],
    ['+91 98765-43210', '+919876543210'],
    ['919876543210', '+919876543210'],
    ['09876543210', '+919876543210'],
  ])('normalises %s', (input, out) => expect(normalizeIndianMobile(input)).toBe(out));

  it.each(['12345', '5876543210', '+14155550100', 'abcdefghij', '98765432101'])('rejects %s', (input) =>
    expect(normalizeIndianMobile(input)).toBeNull(),
  );

  it('masks for staff screens', () => expect(maskPhone('+919876543210')).toBe('+91 ••••• •3210'));
});
