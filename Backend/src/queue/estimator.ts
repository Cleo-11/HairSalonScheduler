/**
 * Pure wait-time engine. No database, no clock: everything comes in as
 * arguments so it can be unit-tested exhaustively.
 *
 *   wait(S) = remaining(S) + sum of (d_j + buffer) over jobs j queued ahead on S
 *
 * - Each stylist has their own line.
 * - A running job counts only its remaining time from the actual start;
 *   if it has overrun, it is assumed to end now (the stylist must add time
 *   or finish it to push people back).
 * - A fixed buffer (per salon) separates consecutive customers.
 * - A stylist on break starts nothing before their break ends.
 * - Starts are pushed out of gaps in the salon's opening hours
 *   (e.g. a lunch closure).
 */

export type StylistStatus = 'available' | 'busy' | 'break' | 'off';
export type ActiveStatus = 'waiting' | 'called' | 'in_service';

export interface EngineStylist {
  id: string;
  status: StylistStatus;
  breakUntil: Date | null;
  sortOrder: number;
  /** Effective minutes per service this stylist offers (override ?? default). */
  serviceMinutes: Map<string, number>;
}

export interface EngineEntry {
  id: string;
  stylistId: string;
  status: ActiveStatus;
  position: number;
  /** Sum of the booked services' minutes plus any extension. */
  minutes: number;
  startedAt: Date | null;
}

export interface Interval {
  start: Date;
  end: Date;
}

export interface EngineContext {
  now: Date;
  bufferMinutes: number;
  /** Today's (and possibly tomorrow's) opening intervals, sorted. Empty = no constraint. */
  openIntervals: Interval[];
}

export interface EntryEstimate {
  entryId: string;
  stylistId: string;
  startAt: Date;
  endAt: Date;
  waitMinutes: number;
  peopleAhead: number;
}

export interface StylistTimeline {
  stylistId: string;
  /** false when the stylist is off: nobody should be estimated or assigned. */
  accepting: boolean;
  /** When the stylist could start a customer who joins now (null if not accepting). */
  nextFreeAt: Date | null;
  queueLength: number;
  estimates: EntryEstimate[];
}

const MIN = 60_000;

export const addMinutes = (d: Date, m: number) => new Date(d.getTime() + m * MIN);
const maxDate = (a: Date, b: Date) => (a.getTime() >= b.getTime() ? a : b);
export const minutesBetween = (from: Date, to: Date) => Math.max(0, Math.round((to.getTime() - from.getTime()) / MIN));

/** Move t forward to the next moment the salon is open. After the last interval, t is returned unchanged. */
export function alignToOpen(t: Date, intervals: Interval[]): Date {
  if (intervals.length === 0) return t;
  for (const iv of intervals) {
    if (t < iv.start) return iv.start;
    if (t < iv.end) return t;
  }
  return t;
}

/** Order of service within one stylist's line: running job, then the called customer, then waiting by position. */
export function lineOrder(a: EngineEntry, b: EngineEntry): number {
  const rank = (e: EngineEntry) => (e.status === 'in_service' ? 0 : e.status === 'called' ? 1 : 2);
  return rank(a) - rank(b) || a.position - b.position;
}

export function stylistTimeline(stylist: EngineStylist, entries: EngineEntry[], ctx: EngineContext): StylistTimeline {
  const line = entries.filter((e) => e.stylistId === stylist.id).sort(lineOrder);
  if (stylist.status === 'off') {
    return { stylistId: stylist.id, accepting: false, nextFreeAt: null, queueLength: line.length, estimates: [] };
  }

  const { now, bufferMinutes } = ctx;
  let cursor = now;
  if (stylist.status === 'break' && stylist.breakUntil && stylist.breakUntil > now) cursor = stylist.breakUntil;

  const estimates: EntryEstimate[] = [];
  let ahead = 0;
  for (const e of line) {
    if (e.status === 'in_service') {
      const start = e.startedAt ?? now;
      const plannedEnd = addMinutes(start, e.minutes);
      const end = maxDate(plannedEnd, now); // overrun: assume it ends now
      estimates.push({ entryId: e.id, stylistId: stylist.id, startAt: start, endAt: end, waitMinutes: 0, peopleAhead: 0 });
      cursor = addMinutes(maxDate(cursor, end), bufferMinutes);
    } else {
      const start = alignToOpen(cursor, ctx.openIntervals);
      const end = addMinutes(start, e.minutes);
      estimates.push({
        entryId: e.id,
        stylistId: stylist.id,
        startAt: start,
        endAt: end,
        waitMinutes: minutesBetween(now, start),
        peopleAhead: ahead,
      });
      cursor = addMinutes(end, bufferMinutes);
    }
    ahead++;
  }

  return {
    stylistId: stylist.id,
    accepting: true,
    nextFreeAt: alignToOpen(cursor, ctx.openIntervals),
    queueLength: line.length,
    estimates,
  };
}

export function computeAll(stylists: EngineStylist[], entries: EngineEntry[], ctx: EngineContext) {
  const timelines = stylists.map((s) => stylistTimeline(s, entries, ctx));
  const byEntry = new Map<string, EntryEstimate>();
  for (const t of timelines) for (const e of t.estimates) byEntry.set(e.entryId, e);
  return { timelines, byEntry };
}

/** Minutes this stylist needs for the given services, or null if they don't offer all of them. */
export function minutesFor(stylist: EngineStylist, serviceIds: string[]): number | null {
  let total = 0;
  for (const id of serviceIds) {
    const m = stylist.serviceMinutes.get(id);
    if (m === undefined) return null;
    total += m;
  }
  return total;
}

export interface Quote {
  stylistId: string;
  startAt: Date;
  endAt: Date;
  waitMinutes: number;
  minutes: number;
  peopleAhead: number;
}

/** What a customer joining now would get with each stylist who can do every chosen service. */
export function quoteAll(
  stylists: EngineStylist[],
  entries: EngineEntry[],
  serviceIds: string[],
  ctx: EngineContext,
): Quote[] {
  const quotes: Quote[] = [];
  for (const s of stylists) {
    const minutes = minutesFor(s, serviceIds);
    if (minutes === null) continue;
    const t = stylistTimeline(s, entries, ctx);
    if (!t.accepting || !t.nextFreeAt) continue;
    const startAt = t.nextFreeAt;
    quotes.push({
      stylistId: s.id,
      startAt,
      endAt: addMinutes(startAt, minutes),
      waitMinutes: minutesBetween(ctx.now, startAt),
      minutes,
      peopleAhead: t.queueLength,
    });
  }
  return quotes;
}

/** "Any available": earliest start, then earliest finish, then shortest line, then salon order. */
export function pickAnyAvailable(stylists: EngineStylist[], quotes: Quote[]): Quote | null {
  const order = new Map(stylists.map((s) => [s.id, s.sortOrder]));
  const sorted = [...quotes].sort(
    (a, b) =>
      a.startAt.getTime() - b.startAt.getTime() ||
      a.endAt.getTime() - b.endAt.getTime() ||
      a.peopleAhead - b.peopleAhead ||
      (order.get(a.stylistId) ?? 0) - (order.get(b.stylistId) ?? 0),
  );
  return sorted[0] ?? null;
}

/**
 * E Walk-In "assign me anyone": pick at random among the stylists who can start
 * soonest. Stylists free right now are all tied at 0 minutes, so a customer who
 * walks in while several chairs are free gets one of them at random. When every
 * stylist is busy, only those freeing up first (same whole minute) are tied, so
 * randomness never makes someone wait longer than the soonest slot.
 *
 * `random` returns a number in [0, 1), like Math.random; injectable for tests.
 */
export function pickRandomAvailable(quotes: Quote[], random: () => number = Math.random): Quote | null {
  if (quotes.length === 0) return null;
  const soonest = Math.min(...quotes.map((q) => q.waitMinutes));
  const tied = quotes.filter((q) => q.waitMinutes === soonest);
  return tied[Math.min(tied.length - 1, Math.floor(random() * tied.length))]!;
}

/**
 * Show a range rather than a single number (risk mitigation in the project doc).
 * Spread grows with the wait: roughly -20% / +25%, rounded to 5 minutes.
 */
export function waitRange(waitMinutes: number): { low: number; high: number } {
  if (waitMinutes <= 0) return { low: 0, high: 0 };
  const low = Math.floor((waitMinutes * 0.8) / 5) * 5;
  const high = Math.max(Math.ceil((waitMinutes * 1.25) / 5) * 5, low + 5);
  return { low, high };
}
