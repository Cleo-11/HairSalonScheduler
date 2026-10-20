import type { Interval } from './queue/estimator.js';

export interface HoursRow {
  weekday: number; // 0 = Sunday
  opens: string; // 'HH:MM' or 'HH:MM:SS'
  closes: string;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Calendar date and weekday of an instant in a time zone. */
export function localDate(at: Date, timeZone: string): { date: string; weekday: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
  }).formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return { date: `${get('year')}-${get('month')}-${get('day')}`, weekday: WEEKDAYS.indexOf(get('weekday')) };
}

function offsetMs(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(at);
  const n = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  const asUtc = Date.UTC(n('year'), n('month') - 1, n('day'), n('hour'), n('minute'), n('second'));
  return asUtc - Math.floor(at.getTime() / 1000) * 1000;
}

/** The instant at which the wall clock in `timeZone` shows `date` `time`. */
export function zonedToUtc(date: string, time: string, timeZone: string): Date {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const [hh, mm, ss = 0] = time.split(':').map(Number) as [number, number, number?];
  const guess = Date.UTC(y, m - 1, d, hh, mm, ss);
  let result = guess - offsetMs(new Date(guess), timeZone);
  result = guess - offsetMs(new Date(result), timeZone); // settle DST edges
  return new Date(result);
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export interface OpenState {
  isOpenNow: boolean;
  /** Opening intervals from the start of today through the end of tomorrow, as instants. */
  intervals: Interval[];
  /** When the current open interval ends (null if closed now). */
  closesAt: Date | null;
  /** Next time the salon opens (null if open now or nothing scheduled in the next 7 days). */
  nextOpenAt: Date | null;
  /** End of the last opening interval that starts today (null if no more opening today). */
  todayClosesAt: Date | null;
  isHoliday: boolean;
}

export function openState(now: Date, timeZone: string, hours: HoursRow[], holidays: Set<string>): OpenState {
  const today = localDate(now, timeZone);
  const intervalsFor = (date: string, weekday: number): Interval[] =>
    holidays.has(date)
      ? []
      : hours
          .filter((h) => h.weekday === weekday)
          .map((h) => ({ start: zonedToUtc(date, h.opens, timeZone), end: zonedToUtc(date, h.closes, timeZone) }))
          .sort((a, b) => a.start.getTime() - b.start.getTime());

  const week: Interval[] = [];
  for (let i = 0; i < 8; i++) week.push(...intervalsFor(addDays(today.date, i), (today.weekday + i) % 7));

  const current = week.find((iv) => iv.start <= now && now < iv.end) ?? null;
  const next = week.find((iv) => iv.start > now) ?? null;
  const tomorrowStart = zonedToUtc(addDays(today.date, 1), '00:00', timeZone);
  const tomorrowEnd = zonedToUtc(addDays(today.date, 2), '00:00', timeZone);
  const todayRemaining = week.filter((iv) => iv.start < tomorrowStart && iv.end > now);
  return {
    todayClosesAt: todayRemaining.at(-1)?.end ?? null,
    isOpenNow: current !== null,
    intervals: week.filter((iv) => iv.end > now && iv.start < tomorrowEnd),
    closesAt: current?.end ?? null,
    nextOpenAt: current ? null : (next?.start ?? null),
    isHoliday: holidays.has(today.date),
  };
}
