import { describe, expect, it } from 'vitest';
import {
  type EngineEntry,
  type EngineStylist,
  addMinutes,
  alignToOpen,
  computeAll,
  pickAnyAvailable,
  pickRandomAvailable,
  quoteAll,
  stylistTimeline,
  waitRange,
} from '../../src/queue/estimator.js';

const NOW = new Date('2026-09-29T06:30:00Z');
const at = (min: number) => addMinutes(NOW, min);
const ctx = { now: NOW, bufferMinutes: 5, openIntervals: [] };

const stylist = (id: string, services: Record<string, number>, over: Partial<EngineStylist> = {}): EngineStylist => ({
  id,
  status: 'available',
  breakUntil: null,
  sortOrder: 0,
  serviceMinutes: new Map(Object.entries(services)),
  ...over,
});

let n = 0;
const entry = (stylistId: string, minutes: number, over: Partial<EngineEntry> = {}): EngineEntry => ({
  id: `e${++n}`,
  stylistId,
  status: 'waiting',
  position: n,
  minutes,
  startedAt: null,
  ...over,
});

describe('stylistTimeline', () => {
  it('an idle stylist can start now', () => {
    const t = stylistTimeline(stylist('a', { cut: 30 }), [], ctx);
    expect(t.accepting).toBe(true);
    expect(t.nextFreeAt).toEqual(NOW);
  });

  it('wait = remaining time of the running job + each job ahead + buffers', () => {
    const a = stylist('a', {});
    const running = entry('a', 30, { status: 'in_service', startedAt: at(-10) }); // 20 left
    const w1 = entry('a', 45);
    const w2 = entry('a', 15);
    const t = stylistTimeline(a, [w2, running, w1], ctx);
    const est = new Map(t.estimates.map((e) => [e.entryId, e]));
    expect(est.get(w1.id)!.startAt).toEqual(at(20 + 5));
    expect(est.get(w1.id)!.peopleAhead).toBe(1);
    expect(est.get(w2.id)!.startAt).toEqual(at(25 + 45 + 5));
    expect(est.get(w2.id)!.waitMinutes).toBe(75);
    expect(est.get(w2.id)!.peopleAhead).toBe(2);
    expect(t.nextFreeAt).toEqual(at(75 + 15 + 5));
    expect(t.queueLength).toBe(3);
  });

  it('an overrunning job is assumed to end now, not in the past', () => {
    const running = entry('a', 30, { status: 'in_service', startedAt: at(-45) });
    const w = entry('a', 20);
    const t = stylistTimeline(stylist('a', {}), [running, w], ctx);
    expect(t.estimates.find((e) => e.entryId === w.id)!.startAt).toEqual(at(5));
  });

  it('extensions are part of the running job minutes', () => {
    const running = entry('a', 30 + 10, { status: 'in_service', startedAt: at(0) });
    const w = entry('a', 20);
    const t = stylistTimeline(stylist('a', {}), [running, w], ctx);
    expect(t.estimates.find((e) => e.entryId === w.id)!.startAt).toEqual(at(45));
  });

  it('nothing starts before a break ends', () => {
    const w = entry('a', 20);
    const t = stylistTimeline(stylist('a', {}, { status: 'break', breakUntil: at(15) }), [w], ctx);
    expect(t.estimates[0]!.startAt).toEqual(at(15));
  });

  it('an expired break is ignored', () => {
    const t = stylistTimeline(stylist('a', {}, { status: 'break', breakUntil: at(-5) }), [], ctx);
    expect(t.nextFreeAt).toEqual(NOW);
  });

  it('a stylist who is off gets no estimates and accepts nobody', () => {
    const t = stylistTimeline(stylist('a', {}, { status: 'off' }), [entry('a', 20)], ctx);
    expect(t.accepting).toBe(false);
    expect(t.estimates).toHaveLength(0);
    expect(t.queueLength).toBe(1);
  });

  it('the called customer goes before waiting customers regardless of position', () => {
    const w = entry('a', 20, { position: 1 });
    const c = entry('a', 20, { status: 'called', position: 9 });
    const t = stylistTimeline(stylist('a', {}), [w, c], ctx);
    expect(t.estimates.map((e) => e.entryId)).toEqual([c.id, w.id]);
  });

  it('starts skip gaps in opening hours (lunch closure)', () => {
    const open = [
      { start: at(-120), end: at(30) },
      { start: at(90), end: at(400) },
    ];
    const w1 = entry('a', 25); // 0-25
    const w2 = entry('a', 25); // would start at 30 (closed) -> 90
    const t = stylistTimeline(stylist('a', {}), [w1, w2], { ...ctx, openIntervals: open });
    expect(t.estimates[0]!.startAt).toEqual(NOW);
    expect(t.estimates[1]!.startAt).toEqual(at(90));
  });

  it('only considers entries for this stylist', () => {
    const t = stylistTimeline(stylist('a', {}), [entry('b', 60)], ctx);
    expect(t.queueLength).toBe(0);
  });
});

describe('alignToOpen', () => {
  const ivs = [{ start: at(10), end: at(20) }, { start: at(30), end: at(40) }];
  it('leaves times inside an interval alone', () => expect(alignToOpen(at(15), ivs)).toEqual(at(15)));
  it('moves forward to the next opening', () => {
    expect(alignToOpen(at(0), ivs)).toEqual(at(10));
    expect(alignToOpen(at(25), ivs)).toEqual(at(30));
  });
  it('after the last interval returns the time unchanged', () => expect(alignToOpen(at(50), ivs)).toEqual(at(50)));
  it('no intervals means no constraint', () => expect(alignToOpen(at(5), [])).toEqual(at(5)));
});

describe('quotes and "any available"', () => {
  const a = stylist('a', { cut: 30, colour: 90 }, { sortOrder: 1 });
  const b = stylist('b', { cut: 25 }, { sortOrder: 2 });
  const c = stylist('c', { cut: 40 }, { sortOrder: 3, status: 'off' });

  it('uses each stylist\'s own duration and skips those who do not offer every service or are off', () => {
    const quotes = quoteAll([a, b, c], [], ['cut'], ctx);
    expect(quotes.map((q) => [q.stylistId, q.minutes])).toEqual([['a', 30], ['b', 25]]);
    expect(quoteAll([a, b, c], [], ['cut', 'colour'], ctx).map((q) => q.stylistId)).toEqual(['a']);
  });

  it('multi-service bookings sum their services', () => {
    expect(quoteAll([a], [], ['cut', 'colour'], ctx)[0]!.minutes).toBe(120);
  });

  it('picks the earliest start', () => {
    const entries = [entry('a', 30, { status: 'in_service', startedAt: NOW })];
    const best = pickAnyAvailable([a, b], quoteAll([a, b], entries, ['cut'], ctx));
    expect(best!.stylistId).toBe('b');
  });

  it('breaks ties by earliest finish, then by salon order', () => {
    expect(pickAnyAvailable([a, b], quoteAll([a, b], [], ['cut'], ctx))!.stylistId).toBe('b'); // 25 < 30 min
    const a2 = stylist('a', { cut: 30 }, { sortOrder: 2 });
    const b2 = stylist('b', { cut: 30 }, { sortOrder: 1 });
    expect(pickAnyAvailable([a2, b2], quoteAll([a2, b2], [], ['cut'], ctx))!.stylistId).toBe('b');
  });

  it('returns null when nobody can do it', () => {
    expect(pickAnyAvailable([c], quoteAll([c], [], ['cut'], ctx))).toBeNull();
  });
});

describe('computeAll', () => {
  it('indexes every active entry\'s estimate', () => {
    const a = stylist('a', {});
    const b = stylist('b', {});
    const e1 = entry('a', 30);
    const e2 = entry('b', 30);
    const { byEntry, timelines } = computeAll([a, b], [e1, e2], ctx);
    expect(byEntry.size).toBe(2);
    expect(timelines).toHaveLength(2);
  });
});

describe('waitRange', () => {
  it('is zero when starting now', () => expect(waitRange(0)).toEqual({ low: 0, high: 0 }));
  it('brackets the estimate in 5-minute steps', () => {
    expect(waitRange(40)).toEqual({ low: 30, high: 50 });
    expect(waitRange(3)).toEqual({ low: 0, high: 5 });
    const r = waitRange(47);
    expect(r.low).toBeLessThanOrEqual(47);
    expect(r.high).toBeGreaterThanOrEqual(47);
  });
});

describe('pickRandomAvailable (E Walk-In)', () => {
  const a = stylist('a', { cut: 30 });
  const b = stylist('b', { cut: 30 });
  const c = stylist('c', { cut: 30 });
  const busy = (id: string, minutes = 30) => entry(id, minutes, { status: 'in_service', startedAt: NOW });

  it('returns null when there are no quotes', () => {
    expect(pickRandomAvailable([])).toBeNull();
  });

  it('chooses among all stylists who are free right now', () => {
    const quotes = quoteAll([a, b, c], [busy('c')], ['cut'], ctx);
    // c is busy, so only a and b are tied at 0 minutes
    expect(pickRandomAvailable(quotes, () => 0)!.stylistId).toBe('a');
    expect(pickRandomAvailable(quotes, () => 0.99)!.stylistId).toBe('b');
  });

  it('every free stylist can be picked, and nobody else', () => {
    const quotes = quoteAll([a, b, c], [busy('c')], ['cut'], ctx);
    const seen = new Set<string>();
    for (let i = 0; i < 100; i++) seen.add(pickRandomAvailable(quotes, () => i / 100)!.stylistId);
    expect([...seen].sort()).toEqual(['a', 'b']);
  });

  it('when everyone is busy it only picks among those who free up first', () => {
    const entries = [busy('a', 40), busy('b', 20), busy('c', 20)];
    const quotes = quoteAll([a, b, c], entries, ['cut'], ctx);
    const seen = new Set<string>();
    for (let i = 0; i < 100; i++) seen.add(pickRandomAvailable(quotes, () => i / 100)!.stylistId);
    expect([...seen].sort()).toEqual(['b', 'c']);
  });

  it('a random value just under 1 still picks a valid quote', () => {
    const quotes = quoteAll([a, b], [], ['cut'], ctx);
    expect(pickRandomAvailable(quotes, () => 0.9999999)!.stylistId).toBe('b');
  });
});
