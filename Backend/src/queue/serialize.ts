import { maskPhone } from '../phone.js';
import { waitRange } from './estimator.js';
import type { EntryInfo, SalonState, StylistInfo } from './state.js';

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

function base(state: SalonState, e: EntryInfo) {
  const est = state.estimates.get(e.id);
  const stylist = state.stylists.find((s) => s.id === e.stylistId);
  const timeline = state.timelines.get(e.stylistId);
  const wait = est && e.status !== 'in_service' ? est.waitMinutes : 0;
  return {
    id: e.id,
    status: e.status,
    stylist: { id: e.stylistId, display_name: stylist?.displayName ?? 'Unavailable' },
    requested_stylist_id: e.requestedStylistId,
    any_stylist: e.requestedStylistId === null,
    // Joined through the app's E Walk-In (random or requested stylist), as opposed to added by the desk.
    e_walk_in: e.joinMode === 'e_walk_in',
    services: e.services.map((s) => ({ service_id: s.serviceId, name: s.name, minutes: s.minutes, price_paise: s.pricePaise })),
    total_minutes: e.minutes,
    total_price_paise: e.services.reduce((a, s) => a + s.pricePaise, 0),
    people_ahead: est?.peopleAhead ?? null,
    est_start_at: iso(est?.startAt),
    est_end_at: iso(est?.endAt),
    wait_minutes: est ? wait : null,
    wait_range_minutes: est ? waitRange(wait) : null,
    // false when the stylist has gone off: the desk needs to reassign this customer.
    stylist_available: timeline?.accepting ?? false,
    joined_at: iso(e.joinedAt),
    called_at: iso(e.calledAt),
    started_at: iso(e.startedAt),
  };
}

export function customerEntryView(state: SalonState, e: EntryInfo) {
  return {
    ...base(state, e),
    salon: { id: state.salon.id, slug: state.salon.slug, name: state.salon.name },
    noshow_grace_minutes: state.salon.noshow_grace_minutes,
  };
}

export function dashboardEntryView(state: SalonState, e: EntryInfo) {
  return {
    ...base(state, e),
    customer_id: e.customerId,
    display_name: e.customerName ?? e.guestName ?? 'Guest',
    phone_masked: e.customerPhone ? maskPhone(e.customerPhone) : null,
    source: e.source,
    position: e.position,
    skip_count: e.skipCount,
    extra_minutes: e.extraMinutes,
  };
}

export function stylistBoardView(state: SalonState, s: StylistInfo) {
  const t = state.timelines.get(s.id);
  const current = state.entries.find((e) => e.stylistId === s.id && e.status === 'in_service');
  return {
    id: s.id,
    display_name: s.displayName,
    status: s.status,
    break_until: iso(s.breakUntil),
    current_entry_id: current?.id ?? null,
    queue_length: t?.queueLength ?? 0,
    next_free_at: iso(t?.nextFreeAt),
    e_walk_in_enabled: s.eWalkIn,
    service_ids: [...s.serviceMinutes.keys()],
  };
}

export function openView(state: SalonState) {
  return {
    is_open_now: state.open.isOpenNow,
    closes_at: iso(state.open.closesAt),
    today_closes_at: iso(state.open.todayClosesAt),
    next_open_at: iso(state.open.nextOpenAt),
    is_holiday: state.open.isHoliday,
    joins_paused: state.salon.joins_paused,
    e_walk_in_enabled: state.salon.e_walk_in_enabled,
    accepting_joins: state.open.isOpenNow && !state.salon.joins_paused,
  };
}

/** Pushed to every open screen over SSE. No personal data: anyone can subscribe. */
export function publicSnapshot(state: SalonState) {
  return {
    salon_id: state.salon.id,
    at: state.now.toISOString(),
    ...openView(state),
    stylists: state.stylists.map((s) => {
      const t = state.timelines.get(s.id);
      return {
        id: s.id,
        display_name: s.displayName,
        status: s.status,
        queue_length: t?.queueLength ?? 0,
        next_free_at: iso(t?.nextFreeAt),
      };
    }),
  };
}
