import type { Queryable } from '../db.js';
import { notFound } from '../errors.js';

export interface SalonRow {
  id: string;
  slug: string;
  name: string;
  address: string;
  phone: string | null;
  lat: number;
  lng: number;
  timezone: string;
  buffer_minutes: number;
  noshow_grace_minutes: number;
  noshow_policy: 'requeue_once' | 'mark_no_show';
  turn_alert_minutes: number;
  join_radius_m: number | null;
  joins_paused: boolean;
  e_walk_in_enabled: boolean;
  is_active: boolean;
}

const SALON_COLS = `id, slug, name, address, phone, lat, lng, timezone, buffer_minutes, noshow_grace_minutes,
  noshow_policy, turn_alert_minutes, join_radius_m, joins_paused, e_walk_in_enabled, is_active`;

export async function salonBySlug(q: Queryable, slug: string, opts: { includeInactive?: boolean } = {}): Promise<SalonRow> {
  const { rows } = await q.query<SalonRow>(`SELECT ${SALON_COLS} FROM salons WHERE slug = $1`, [slug]);
  const s = rows[0];
  if (!s || (!s.is_active && !opts.includeInactive)) throw notFound('Salon');
  return s;
}

export async function salonById(q: Queryable, id: string): Promise<SalonRow> {
  const { rows } = await q.query<SalonRow>(`SELECT ${SALON_COLS} FROM salons WHERE id = $1`, [id]);
  if (!rows[0]) throw notFound('Salon');
  return rows[0];
}
