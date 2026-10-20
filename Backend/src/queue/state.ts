import type { Queryable } from '../db.js';
import { type HoursRow, type OpenState, localDate, addDays, openState } from '../hours.js';
import type { SalonRow } from '../salons/repo.js';
import {
  type EngineEntry,
  type EngineStylist,
  type EntryEstimate,
  type StylistStatus,
  type StylistTimeline,
  computeAll,
} from './estimator.js';

export interface StylistInfo extends EngineStylist {
  displayName: string;
  staffMemberId: string | null;
  /** Takes part in E Walk-In: in the random pool and can be requested by name. */
  eWalkIn: boolean;
}

export interface EntryInfo extends EngineEntry {
  salonId: string;
  customerId: string | null;
  customerName: string | null;
  customerPhone: string | null;
  guestName: string | null;
  source: 'app' | 'walk_in';
  joinMode: 'standard' | 'e_walk_in';
  requestedStylistId: string | null;
  extraMinutes: number;
  skipCount: number;
  joinedAt: Date;
  calledAt: Date | null;
  initialEstStartAt: Date | null;
  turnAlertSentAt: Date | null;
  services: { serviceId: string; name: string; minutes: number; pricePaise: number }[];
}

export interface SalonState {
  salon: SalonRow;
  now: Date;
  open: OpenState;
  stylists: StylistInfo[];
  entries: EntryInfo[];
  timelines: Map<string, StylistTimeline>;
  estimates: Map<string, EntryEstimate>;
}

export async function loadHours(q: Queryable, salon: Pick<SalonRow, 'id' | 'timezone'>, now: Date) {
  const today = localDate(now, salon.timezone).date;
  // Sequential on purpose: q may be a single transaction client.
  const { rows: hours } = await q.query<HoursRow>(
      `SELECT weekday, to_char(opens, 'HH24:MI') AS opens, to_char(closes, 'HH24:MI') AS closes
         FROM business_hours WHERE salon_id = $1 ORDER BY weekday, opens`,
      [salon.id],
  );
  const { rows: hol } = await q.query<{ date: string }>(
      `SELECT to_char(date, 'YYYY-MM-DD') AS date FROM holidays WHERE salon_id = $1 AND date BETWEEN $2 AND $3`,
      [salon.id, today, addDays(today, 8)],
  );
  return { hours, holidays: new Set(hol.map((h) => h.date)) };
}

export async function loadStylists(q: Queryable, salonId: string): Promise<StylistInfo[]> {
  const { rows } = await q.query<{
    id: string;
    display_name: string;
    status: StylistStatus;
    break_until: Date | null;
    sort_order: number;
    staff_member_id: string | null;
    e_walk_in_enabled: boolean;
    services: { id: string; minutes: number }[] | null;
  }>(
    `SELECT st.id, st.display_name, st.status, st.break_until, st.sort_order, st.staff_member_id, st.e_walk_in_enabled,
            (SELECT json_agg(json_build_object('id', sv.id, 'minutes', COALESCE(ss.custom_minutes, sv.default_minutes)))
               FROM stylist_services ss JOIN services sv ON sv.id = ss.service_id AND sv.is_active
              WHERE ss.stylist_id = st.id) AS services
       FROM stylists st
      WHERE st.salon_id = $1 AND st.is_active
      ORDER BY st.sort_order, st.display_name`,
    [salonId],
  );
  return rows.map((r) => ({
    id: r.id,
    displayName: r.display_name,
    status: r.status,
    breakUntil: r.break_until,
    sortOrder: r.sort_order,
    staffMemberId: r.staff_member_id,
    eWalkIn: r.e_walk_in_enabled,
    serviceMinutes: new Map((r.services ?? []).map((s) => [s.id, s.minutes])),
  }));
}

const ENTRY_SELECT = `SELECT e.id, e.salon_id, e.stylist_id, e.status, e.position, e.extra_minutes, e.skip_count,
            e.started_at, e.joined_at, e.called_at, e.initial_est_start_at, e.turn_alert_sent_at,
            e.customer_id, e.guest_name, e.source, e.join_mode, e.requested_stylist_id,
            c.name AS customer_name, c.phone AS customer_phone,
            json_agg(json_build_object('serviceId', s.service_id, 'name', s.name_snapshot,
                     'minutes', s.minutes_snapshot, 'pricePaise', s.price_paise_snapshot)
                     ORDER BY s.name_snapshot) AS services
       FROM queue_entries e
       JOIN queue_entry_services s ON s.queue_entry_id = e.id
       LEFT JOIN customers c ON c.id = e.customer_id
`;

export async function loadActiveEntries(q: Queryable, salonId: string): Promise<EntryInfo[]> {
  const { rows } = await q.query(
    `${ENTRY_SELECT} WHERE e.salon_id = $1 AND e.status IN ('waiting', 'called', 'in_service') GROUP BY e.id, c.id`,
    [salonId],
  );
  return rows.map(toEntryInfo);
}

/** One entry in any status (used for ended entries, which have no estimate). */
export async function loadEntry(q: Queryable, entryId: string): Promise<(EntryInfo & { status: string }) | null> {
  const { rows } = await q.query(`${ENTRY_SELECT} WHERE e.id = $1 GROUP BY e.id, c.id`, [entryId]);
  return rows[0] ? toEntryInfo(rows[0]) : null;
}

// Maps a raw row from loadActiveEntries.
export function toEntryInfo(r: any): EntryInfo {
  const services = r.services as EntryInfo['services'];
  const extra = r.extra_minutes as number;
  return {
    id: r.id,
    salonId: r.salon_id,
    stylistId: r.stylist_id,
    status: r.status,
    position: r.position,
    minutes: services.reduce((a, s) => a + s.minutes, 0) + extra,
    startedAt: r.started_at,
    customerId: r.customer_id,
    customerName: r.customer_name ?? null,
    customerPhone: r.customer_phone ?? null,
    guestName: r.guest_name,
    source: r.source,
    joinMode: r.join_mode,
    requestedStylistId: r.requested_stylist_id,
    extraMinutes: extra,
    skipCount: r.skip_count,
    joinedAt: r.joined_at,
    calledAt: r.called_at,
    initialEstStartAt: r.initial_est_start_at,
    turnAlertSentAt: r.turn_alert_sent_at,
    services,
  };
}

/** Loads everything the engine needs for one salon and runs it. Read-only. */
export async function loadSalonState(q: Queryable, salon: SalonRow, now: Date): Promise<SalonState> {
  const { hours, holidays } = await loadHours(q, salon, now);
  const stylists = await loadStylists(q, salon.id);
  const entries = await loadActiveEntries(q, salon.id);
  const open = openState(now, salon.timezone, hours, holidays);
  // An entry whose stylist was deactivated still needs to show up; treat that stylist as off.
  const known = new Set(stylists.map((s) => s.id));
  const engineStylists: EngineStylist[] = [...stylists];
  for (const e of entries) {
    if (!known.has(e.stylistId)) {
      engineStylists.push({ id: e.stylistId, status: 'off', breakUntil: null, sortOrder: 9999, serviceMinutes: new Map() });
      known.add(e.stylistId);
    }
  }
  const { timelines, byEntry } = computeAll(engineStylists, entries, {
    now,
    bufferMinutes: salon.buffer_minutes,
    openIntervals: open.intervals,
  });
  return {
    salon,
    now,
    open,
    stylists,
    entries,
    timelines: new Map(timelines.map((t) => [t.stylistId, t])),
    estimates: byEntry,
  };
}

export function engineContext(state: SalonState) {
  return { now: state.now, bufferMinutes: state.salon.buffer_minutes, openIntervals: state.open.intervals };
}
