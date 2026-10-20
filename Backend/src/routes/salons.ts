import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Deps } from '../app.js';
import { badRequest } from '../errors.js';
import { openState } from '../hours.js';
import { parse, slugParam, uuid } from '../http.js';
import { minutesFor, pickAnyAvailable, pickRandomAvailable, quoteAll, waitRange } from '../queue/estimator.js';
import { openView, publicSnapshot } from '../queue/serialize.js';
import { engineContext, loadHours, loadSalonState } from '../queue/state.js';
import { salonBySlug } from '../salons/repo.js';

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

export async function salonRoutes(app: FastifyInstance, deps: Deps) {
  // Nearest salons (with lat/lng) or all salons by name (fallback when location is denied).
  app.get('/v1/salons', async (req) => {
    const q = parse(
      z
        .object({
          lat: z.coerce.number().min(-90).max(90).optional(),
          lng: z.coerce.number().min(-180).max(180).optional(),
          radius_m: z.coerce.number().int().min(100).max(100_000).optional(),
          limit: z.coerce.number().int().min(1).max(50).default(20),
        })
        .refine((v) => (v.lat === undefined) === (v.lng === undefined), 'Send both lat and lng, or neither'),
      req.query,
    );
    const hasPoint = q.lat !== undefined && q.lng !== undefined;
    const { rows } = await deps.db.query(
      hasPoint
        ? `WITH p AS (SELECT ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography AS g)
           SELECT s.id, s.slug, s.name, s.address, s.lat, s.lng, s.timezone, s.joins_paused, s.e_walk_in_enabled, s.join_radius_m,
                  round(ST_Distance(s.location, p.g))::int AS distance_m
             FROM salons s, p
            WHERE s.is_active AND ($3::int IS NULL OR ST_DWithin(s.location, p.g, $3))
            ORDER BY s.location <-> p.g
            LIMIT $4`
        : `SELECT id, slug, name, address, lat, lng, timezone, joins_paused, e_walk_in_enabled, join_radius_m, NULL::int AS distance_m
             FROM salons WHERE is_active ORDER BY name LIMIT $1`,
      hasPoint ? [q.lng, q.lat, q.radius_m ?? null, q.limit] : [q.limit],
    );
    const now = deps.now();
    const salons = await Promise.all(
      rows.map(async (s) => {
        const { hours, holidays } = await loadHours(deps.db, s, now);
        const open = openState(now, s.timezone, hours, holidays);
        return {
          id: s.id,
          slug: s.slug,
          name: s.name,
          address: s.address,
          lat: s.lat,
          lng: s.lng,
          distance_m: s.distance_m,
          within_join_radius: s.distance_m === null || s.join_radius_m === null ? null : s.distance_m <= s.join_radius_m,
          is_open_now: open.isOpenNow,
          accepting_joins: open.isOpenNow && !s.joins_paused,
          e_walk_in_enabled: s.e_walk_in_enabled,
          next_open_at: iso(open.nextOpenAt),
        };
      }),
    );
    return { salons };
  });

  app.get('/v1/salons/:slug', async (req) => {
    const { slug } = parse(slugParam, req.params);
    const salon = await salonBySlug(deps.db, slug);
    const now = deps.now();
    const state = await loadSalonState(deps.db, salon, now);
    const { hours } = await loadHours(deps.db, salon, now);
    return {
      salon: {
        id: salon.id,
        slug: salon.slug,
        name: salon.name,
        address: salon.address,
        phone: salon.phone,
        lat: salon.lat,
        lng: salon.lng,
        timezone: salon.timezone,
        join_radius_m: salon.join_radius_m,
        noshow_grace_minutes: salon.noshow_grace_minutes,
        hours,
        ...openView(state),
      },
    };
  });

  app.get('/v1/salons/:slug/services', async (req) => {
    const { slug } = parse(slugParam, req.params);
    const salon = await salonBySlug(deps.db, slug);
    const { rows } = await deps.db.query(
      `SELECT id, name, description, price_paise, default_minutes FROM services
        WHERE salon_id = $1 AND is_active ORDER BY sort_order, name`,
      [salon.id],
    );
    return { services: rows };
  });

  // Stylist cards: status and, when services are chosen, each stylist's own wait for them.
  app.get('/v1/salons/:slug/stylists', async (req) => {
    const { slug } = parse(slugParam, req.params);
    const q = parse(z.object({ service_ids: z.string().optional() }), req.query);
    const serviceIds = q.service_ids ? [...new Set(q.service_ids.split(',').map((s) => s.trim()).filter(Boolean))] : [];
    for (const id of serviceIds) if (!uuid.safeParse(id).success) throw badRequest('VALIDATION_ERROR', `Invalid service id ${id}`);

    const salon = await salonBySlug(deps.db, slug);
    const state = await loadSalonState(deps.db, salon, deps.now());
    const ctx = engineContext(state);
    const quotes = serviceIds.length ? quoteAll(state.stylists, state.entries, serviceIds, ctx) : [];
    const candidates = serviceIds.length ? state.stylists.filter((s) => minutesFor(s, serviceIds) !== null) : state.stylists;

    const stylists = candidates.map((s) => {
      const t = state.timelines.get(s.id)!;
      const quote = quotes.find((qq) => qq.stylistId === s.id);
      return {
        id: s.id,
        display_name: s.displayName,
        status: s.status,
        break_until: iso(s.breakUntil),
        available: t.accepting,
        e_walk_in_enabled: s.eWalkIn,
        queue_length: t.queueLength,
        next_free_at: iso(t.nextFreeAt),
        minutes: serviceIds.length ? minutesFor(s, serviceIds) : null,
        est_start_at: iso(quote?.startAt),
        wait_minutes: quote?.waitMinutes ?? null,
        wait_range_minutes: quote ? waitRange(quote.waitMinutes) : null,
      };
    });
    const best = serviceIds.length ? pickAnyAvailable(state.stylists, quotes) : null;

    // E Walk-In: what a customer joining now (random stylist) would get. Only stylists taking
    // part in E Walk-In count, and only they can be picked.
    const pool = new Set(state.stylists.filter((s) => s.eWalkIn).map((s) => s.id));
    const poolQuotes = quotes.filter((qq) => pool.has(qq.stylistId));
    const soonest = poolQuotes.length ? pickRandomAvailable(poolQuotes, () => 0) : null;
    const eWalkIn = {
      enabled: salon.e_walk_in_enabled,
      free_now: poolQuotes.filter((qq) => qq.waitMinutes === 0).length,
      // true when nobody who does these services can start right now; null until services are chosen.
      all_busy: serviceIds.length && soonest ? soonest.waitMinutes > 0 : null,
      next_slot: soonest
        ? {
            est_start_at: soonest.startAt.toISOString(),
            wait_minutes: soonest.waitMinutes,
            wait_range_minutes: waitRange(soonest.waitMinutes),
            people_ahead: soonest.peopleAhead,
          }
        : null,
    };
    return {
      stylists,
      any_available: best
        ? {
            stylist_id: best.stylistId,
            est_start_at: best.startAt.toISOString(),
            wait_minutes: best.waitMinutes,
            wait_range_minutes: waitRange(best.waitMinutes),
            minutes: best.minutes,
          }
        : null,
      e_walk_in: eWalkIn,
      ...openView(state),
    };
  });

  // Live updates. Public and personal-data-free so a plain EventSource can
  // subscribe without an auth header; clients refetch their own entry on each event.
  app.get('/v1/salons/:slug/events', async (req, reply) => {
    const { slug } = parse(slugParam, req.params);
    const salon = await salonBySlug(deps.db, slug);
    if (!deps.hub) throw badRequest('REALTIME_DISABLED', 'Realtime is not enabled on this server');

    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      ...corsHeaders(req.headers.origin, deps.config.CORS_ORIGINS),
    });

    let closed = false;
    let seq = 0;
    const send = async () => {
      if (closed) return;
      try {
        // Reload the salon each time so desk switches (pause, E Walk-In) show up in long-lived streams.
        const state = await loadSalonState(deps.db, await salonBySlug(deps.db, slug), deps.now());
        if (!closed) res.write(`id: ${++seq}\nevent: queue\ndata: ${JSON.stringify(publicSnapshot(state))}\n\n`);
      } catch (err) {
        req.log.warn({ err }, 'sse snapshot failed');
      }
    };
    res.write(`retry: 3000\n\n`);
    await send();
    const unsubscribe = deps.hub.subscribe(salon.id, () => void send());
    const heartbeat = setInterval(() => !closed && res.write(`: ping\n\n`), 25_000);
    heartbeat.unref();
    req.raw.on('close', () => {
      closed = true;
      clearInterval(heartbeat);
      unsubscribe();
    });
  });
}

function corsHeaders(origin: string | undefined, allowed: string): Record<string, string> {
  if (!origin) return {};
  if (allowed === '*') return { 'Access-Control-Allow-Origin': '*' };
  return allowed.split(',').map((s) => s.trim()).includes(origin)
    ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' }
    : {};
}
