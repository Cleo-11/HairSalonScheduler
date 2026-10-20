import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Deps } from '../app.js';
import { ALL_ROLES, DESK_ROLES, OWNER, requireStaff } from '../auth/guards.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { hhmm, parse, slugParam, uuid } from '../http.js';
import { localDate, zonedToUtc, addDays } from '../hours.js';
import { normalizeIndianMobile } from '../phone.js';
import { dashboardEntryView, openView, stylistBoardView } from '../queue/serialize.js';
import { type EntryAction, logEvent, resnapshotMinutes } from '../queue/service.js';
import { lineOrder } from '../queue/estimator.js';
import { type SalonState, loadEntry, loadHours, loadSalonState } from '../queue/state.js';
import { salonById } from '../salons/repo.js';

const stylistParams = z.object({ slug: z.string(), stylistId: uuid });
const serviceParams = z.object({ slug: z.string(), serviceId: uuid });
const entryParams = z.object({ slug: z.string(), entryId: uuid });

const ACTIONS: Record<string, { action: EntryAction; roles: typeof ALL_ROLES }> = {
  call: { action: 'call', roles: ALL_ROLES },
  start: { action: 'start', roles: ALL_ROLES },
  finish: { action: 'finish', roles: ALL_ROLES },
  'no-show': { action: 'no_show', roles: DESK_ROLES },
  requeue: { action: 'requeue', roles: DESK_ROLES },
  cancel: { action: 'cancel', roles: DESK_ROLES },
};

export async function dashboardRoutes(app: FastifyInstance, deps: Deps) {
  const P = '/v1/dashboard/:slug';

  async function dashboard(salonId: string) {
    const state = await loadSalonState(deps.db, await salonById(deps.db, salonId), deps.now());
    // One list across stylists, in the order people will be served; unassignable ones last.
    const start = (id: string) => state.estimates.get(id)?.startAt.getTime() ?? Number.MAX_SAFE_INTEGER;
    const entries = [...state.entries].sort((a, b) => start(a.id) - start(b.id) || lineOrder(a, b));
    return {
      salon: { id: state.salon.id, slug: state.salon.slug, name: state.salon.name, ...openView(state) },
      stylists: state.stylists.map((s) => stylistBoardView(state, s)),
      entries: entries.map((e) => dashboardEntryView(state, e)),
      generated_at: state.now.toISOString(),
    };
  }

  // ------------------------------------------------------------ live queue

  app.get(P, async (req) => {
    const { slug } = parse(slugParam, req.params);
    const access = await requireStaff(req, deps.db, slug, ALL_ROLES);
    return { ...(await dashboard(access.salon.id)), me: { role: access.role, stylist_id: access.stylistId } };
  });

  app.post(`${P}/walk-ins`, async (req, reply) => {
    const { slug } = parse(slugParam, req.params);
    const access = await requireStaff(req, deps.db, slug, DESK_ROLES);
    const body = parse(
      z.object({
        name: z.string().trim().min(1).max(80),
        phone: z.string().max(20).nullish(),
        service_ids: z.array(uuid).min(1).max(10),
        stylist_id: uuid.nullable().default(null),
      }),
      req.body,
    );
    let phone: string | null = null;
    if (body.phone) {
      phone = normalizeIndianMobile(body.phone);
      if (!phone) throw badRequest('INVALID_PHONE', 'Enter a valid 10-digit Indian mobile number');
    }
    const { result: entryId, state } = await deps.queue.join({
      salon: access.salon,
      serviceIds: body.service_ids,
      stylistId: body.stylist_id,
      source: 'walk_in',
      customerId: null,
      guestName: body.name,
      guestPhone: phone,
      actor: `staff:${access.staffUserId}`,
    });
    reply.code(201);
    return { entry: dashboardEntryView(state, state.entries.find((e) => e.id === entryId)!) };
  });

  for (const [path, spec] of Object.entries(ACTIONS)) {
    app.post(`${P}/queue/:entryId/${path}`, async (req) => {
      const { slug, entryId } = parse(entryParams, req.params);
      const access = await requireStaff(req, deps.db, slug, spec.roles);
      const { state } = await deps.queue.entryAction(access, entryId, spec.action);
      return entryResponse(state, entryId);
    });
  }

  // Add time to a running service (the "+5 / +10 min" buttons).
  app.post(`${P}/queue/:entryId/extend`, async (req) => {
    const { slug, entryId } = parse(entryParams, req.params);
    const access = await requireStaff(req, deps.db, slug, ALL_ROLES);
    const { minutes } = parse(z.object({ minutes: z.number().int().min(1).max(120) }), req.body);
    const { state } = await deps.queue.extend(access, entryId, minutes);
    return entryResponse(state, entryId);
  });

  app.patch(`${P}/queue/:entryId`, async (req) => {
    const { slug, entryId } = parse(entryParams, req.params);
    const access = await requireStaff(req, deps.db, slug, DESK_ROLES);
    const body = parse(
      z
        .object({ stylist_id: uuid.optional(), position: z.number().int().min(1).max(1000).optional() })
        .refine((b) => b.stylist_id !== undefined || b.position !== undefined, 'Send stylist_id and/or position'),
      req.body,
    );
    const { state } = await deps.queue.updateEntry(access, entryId, { stylistId: body.stylist_id, position: body.position });
    return entryResponse(state, entryId);
  });

  // ------------------------------------------------------------ stylists

  app.get(`${P}/stylists`, async (req) => {
    const { slug } = parse(slugParam, req.params);
    const access = await requireStaff(req, deps.db, slug, ALL_ROLES);
    const { rows } = await deps.db.query(
      `SELECT st.id, st.display_name, st.status, st.break_until, st.sort_order, st.is_active, st.staff_member_id,
              st.e_walk_in_enabled,
              COALESCE(json_agg(json_build_object(
                'service_id', sv.id, 'name', sv.name, 'default_minutes', sv.default_minutes,
                'custom_minutes', ss.custom_minutes, 'effective_minutes', COALESCE(ss.custom_minutes, sv.default_minutes))
                ORDER BY sv.sort_order, sv.name) FILTER (WHERE sv.id IS NOT NULL), '[]') AS services
         FROM stylists st
         LEFT JOIN stylist_services ss ON ss.stylist_id = st.id
         LEFT JOIN services sv ON sv.id = ss.service_id
        WHERE st.salon_id = $1
        GROUP BY st.id ORDER BY st.sort_order, st.display_name`,
      [access.salon.id],
    );
    return { stylists: rows };
  });

  app.post(`${P}/stylists`, async (req, reply) => {
    const { slug } = parse(slugParam, req.params);
    const access = await requireStaff(req, deps.db, slug, OWNER);
    const body = parse(
      z.object({
        display_name: z.string().trim().min(1).max(60),
        service_ids: z.array(uuid).default([]),
        sort_order: z.number().int().default(0),
      }),
      req.body,
    );
    let id = '';
    await deps.queue.touch(access.salon.id, async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO stylists (salon_id, display_name, sort_order, status) VALUES ($1, $2, $3, 'off') RETURNING id`,
        [access.salon.id, body.display_name, body.sort_order],
      );
      id = rows[0]!.id;
      await setStylistServices(tx, access.salon.id, id, body.service_ids.map((s) => ({ service_id: s, custom_minutes: null })));
    });
    reply.code(201);
    return { stylist: { id, display_name: body.display_name, status: 'off' } };
  });

  app.patch(`${P}/stylists/:stylistId`, async (req) => {
    const { slug, stylistId } = parse(stylistParams, req.params);
    const access = await requireStaff(req, deps.db, slug, OWNER);
    const body = parse(
      z.object({
        display_name: z.string().trim().min(1).max(60).optional(),
        sort_order: z.number().int().optional(),
        is_active: z.boolean().optional(),
      }),
      req.body,
    );
    await deps.queue.touch(access.salon.id, async (tx) => {
      if (body.is_active === false) {
        const { rows } = await tx.query(
          `SELECT 1 FROM queue_entries WHERE stylist_id = $1 AND status IN ('waiting','called','in_service') LIMIT 1`,
          [stylistId],
        );
        if (rows.length) throw conflict('STYLIST_HAS_QUEUE', 'Move this stylist\'s customers before deactivating them');
      }
      const { rowCount } = await tx.query(
        `UPDATE stylists SET display_name = COALESCE($3, display_name), sort_order = COALESCE($4, sort_order),
                is_active = COALESCE($5, is_active), status = CASE WHEN $5 = false THEN 'off' ELSE status END
          WHERE id = $1 AND salon_id = $2`,
        [stylistId, access.salon.id, body.display_name ?? null, body.sort_order ?? null, body.is_active ?? null],
      );
      if (!rowCount) throw notFound('Stylist');
    });
    return { ok: true };
  });

  app.put(`${P}/stylists/:stylistId/status`, async (req) => {
    const { slug, stylistId } = parse(stylistParams, req.params);
    const access = await requireStaff(req, deps.db, slug, ALL_ROLES);
    const body = parse(
      z.object({
        status: z.enum(['available', 'busy', 'break', 'off']),
        break_minutes: z.number().int().min(1).max(240).optional(),
      }),
      req.body,
    );
    const { state } = await deps.queue.setStylistStatus(access, stylistId, body.status, body.break_minutes);
    const s = state.stylists.find((x) => x.id === stylistId);
    if (!s) throw notFound('Stylist');
    return { stylist: stylistBoardView(state, s) };
  });

  // E Walk-In switch for one stylist: out of the random pool and not requestable by name.
  // The desk can change anyone; a stylist can only change their own.
  app.put(`${P}/stylists/:stylistId/e-walk-in`, async (req) => {
    const { slug, stylistId } = parse(stylistParams, req.params);
    const access = await requireStaff(req, deps.db, slug, ALL_ROLES);
    if (access.role === 'stylist' && access.stylistId !== stylistId) {
      throw forbidden('Stylists can only change their own E Walk-In setting');
    }
    const { enabled } = parse(z.object({ enabled: z.boolean() }), req.body);
    let found = false;
    const { state } = await deps.queue.touch(access.salon.id, async (tx, now) => {
      const { rowCount } = await tx.query(
        `UPDATE stylists SET e_walk_in_enabled = $3 WHERE id = $1 AND salon_id = $2 AND is_active`,
        [stylistId, access.salon.id, enabled],
      );
      found = !!rowCount;
      if (found) {
        await logEvent(tx, access.salon.id, null, stylistId, enabled ? 'e_walk_in_on' : 'e_walk_in_off', `staff:${access.staffUserId}`, {}, now);
      }
    });
    if (!found) throw notFound('Stylist');
    const s = state.stylists.find((x) => x.id === stylistId);
    if (!s) throw notFound('Stylist');
    return { stylist: stylistBoardView(state, s) };
  });

  // Which services a stylist offers and their own duration for each (duration override).
  app.put(`${P}/stylists/:stylistId/services`, async (req) => {
    const { slug, stylistId } = parse(stylistParams, req.params);
    const access = await requireStaff(req, deps.db, slug, OWNER);
    const body = parse(
      z.object({
        services: z
          .array(z.object({ service_id: uuid, custom_minutes: z.number().int().min(1).max(600).nullable().default(null) }))
          .max(200),
      }),
      req.body,
    );
    await deps.queue.touch(access.salon.id, async (tx) => {
      const { rows } = await tx.query(`SELECT 1 FROM stylists WHERE id = $1 AND salon_id = $2`, [stylistId, access.salon.id]);
      if (!rows.length) throw notFound('Stylist');
      await setStylistServices(tx, access.salon.id, stylistId, body.services);
      await resnapshotMinutes(tx, access.salon.id);
    });
    return { ok: true };
  });

  // ------------------------------------------------------------ services

  app.get(`${P}/services`, async (req) => {
    const { slug } = parse(slugParam, req.params);
    const access = await requireStaff(req, deps.db, slug, ALL_ROLES);
    const { rows } = await deps.db.query(
      `SELECT sv.id, sv.name, sv.description, sv.price_paise, sv.default_minutes, sv.sort_order, sv.is_active,
              COALESCE(array_agg(ss.stylist_id) FILTER (WHERE ss.stylist_id IS NOT NULL), '{}') AS stylist_ids
         FROM services sv LEFT JOIN stylist_services ss ON ss.service_id = sv.id
        WHERE sv.salon_id = $1 GROUP BY sv.id ORDER BY sv.sort_order, sv.name`,
      [access.salon.id],
    );
    return { services: rows };
  });

  const serviceFields = {
    name: z.string().trim().min(1).max(80),
    description: z.string().trim().max(300).nullable(),
    price_paise: z.number().int().min(0).max(10_000_000),
    default_minutes: z.number().int().min(1).max(600),
    sort_order: z.number().int(),
    is_active: z.boolean(),
  };

  app.post(`${P}/services`, async (req, reply) => {
    const { slug } = parse(slugParam, req.params);
    const access = await requireStaff(req, deps.db, slug, OWNER);
    const body = parse(
      z.object({
        ...serviceFields,
        description: serviceFields.description.default(null),
        sort_order: serviceFields.sort_order.default(0),
        is_active: serviceFields.is_active.default(true),
        // Who offers it. Omit to give it to every active stylist.
        stylist_ids: z.array(uuid).optional(),
      }),
      req.body,
    );
    let service: Record<string, unknown> = {};
    await deps.queue.touch(access.salon.id, async (tx) => {
      const { rows } = await tx.query(
        `INSERT INTO services (salon_id, name, description, price_paise, default_minutes, sort_order, is_active)
         VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (salon_id, name) DO NOTHING
         RETURNING id, name, description, price_paise, default_minutes, sort_order, is_active`,
        [access.salon.id, body.name, body.description, body.price_paise, body.default_minutes, body.sort_order, body.is_active],
      );
      if (!rows[0]) throw conflict('DUPLICATE_SERVICE', 'A service with this name already exists');
      service = rows[0];
      const { rowCount } = await tx.query(
        `INSERT INTO stylist_services (salon_id, stylist_id, service_id)
         SELECT $1, id, $2 FROM stylists WHERE salon_id = $1 AND is_active AND ($3::uuid[] IS NULL OR id = ANY($3))`,
        [access.salon.id, rows[0].id, body.stylist_ids ?? null],
      );
      if (body.stylist_ids && rowCount !== body.stylist_ids.length) throw badRequest('INVALID_STYLISTS', 'Unknown stylist in stylist_ids');
    });
    reply.code(201);
    return { service };
  });

  app.patch(`${P}/services/:serviceId`, async (req) => {
    const { slug, serviceId } = parse(serviceParams, req.params);
    const access = await requireStaff(req, deps.db, slug, OWNER);
    const body = parse(z.object(serviceFields).partial(), req.body);
    let service: Record<string, unknown> = {};
    await deps.queue.touch(access.salon.id, async (tx) => {
      const { rows } = await tx.query(
        `UPDATE services SET
            name = COALESCE($3, name),
            description = CASE WHEN $4::boolean THEN $5 ELSE description END,
            price_paise = COALESCE($6, price_paise),
            default_minutes = COALESCE($7, default_minutes),
            sort_order = COALESCE($8, sort_order),
            is_active = COALESCE($9, is_active)
          WHERE id = $1 AND salon_id = $2
          RETURNING id, name, description, price_paise, default_minutes, sort_order, is_active`,
        [
          serviceId, access.salon.id, body.name ?? null, body.description !== undefined, body.description ?? null,
          body.price_paise ?? null, body.default_minutes ?? null, body.sort_order ?? null, body.is_active ?? null,
        ],
      );
      if (!rows[0]) throw notFound('Service');
      service = rows[0];
      // Waiting customers get the corrected duration; prices they were quoted stay.
      if (body.default_minutes !== undefined) await resnapshotMinutes(tx, access.salon.id);
    });
    return { service };
  });

  // ------------------------------------------------------------ settings & hours

  app.get(`${P}/settings`, async (req) => {
    const { slug } = parse(slugParam, req.params);
    const { salon } = await requireStaff(req, deps.db, slug, ALL_ROLES);
    return { settings: salon };
  });

  app.patch(`${P}/settings`, async (req) => {
    const { slug } = parse(slugParam, req.params);
    const access = await requireStaff(req, deps.db, slug, DESK_ROLES);
    const body = parse(
      z
        .object({
          name: z.string().trim().min(1).max(100),
          address: z.string().trim().min(1).max(300),
          phone: z.string().max(20).nullable(),
          lat: z.number().min(-90).max(90),
          lng: z.number().min(-180).max(180),
          buffer_minutes: z.number().int().min(0).max(60),
          noshow_grace_minutes: z.number().int().min(1).max(60),
          noshow_policy: z.enum(['requeue_once', 'mark_no_show']),
          turn_alert_minutes: z.number().int().min(0).max(120),
          join_radius_m: z.number().int().min(50).max(100_000).nullable(),
          joins_paused: z.boolean(),
          e_walk_in_enabled: z.boolean(),
        })
        .partial()
        .strict(),
      req.body,
    );
    const keys = Object.keys(body) as (keyof typeof body)[];
    if (access.role !== 'owner' && keys.some((k) => k !== 'joins_paused' && k !== 'e_walk_in_enabled')) {
      throw forbidden('Receptionists can only pause or resume joins and switch E Walk-In on or off');
    }
    await deps.queue.touch(access.salon.id, async (tx, now) => {
      if (!keys.length) return;
      const sets = keys.map((k, i) => `${k} = $${i + 3}`).join(', ');
      await tx.query(`UPDATE salons SET ${sets}, updated_at = $2 WHERE id = $1`, [access.salon.id, now, ...keys.map((k) => body[k])]);
    });
    return { settings: await salonById(deps.db, access.salon.id) };
  });

  app.get(`${P}/hours`, async (req) => {
    const { slug } = parse(slugParam, req.params);
    const { salon } = await requireStaff(req, deps.db, slug, ALL_ROLES);
    const { hours } = await loadHours(deps.db, salon, deps.now());
    const { rows: holidays } = await deps.db.query(
      `SELECT to_char(date, 'YYYY-MM-DD') AS date, note FROM holidays WHERE salon_id = $1 AND date >= $2 ORDER BY date`,
      [salon.id, localDate(deps.now(), salon.timezone).date],
    );
    return { timezone: salon.timezone, hours, holidays };
  });

  // Replace the weekly schedule. Several intervals on one day model a midday break.
  app.put(`${P}/hours`, async (req) => {
    const { slug } = parse(slugParam, req.params);
    const access = await requireStaff(req, deps.db, slug, OWNER);
    const body = parse(
      z.object({
        hours: z.array(z.object({ weekday: z.number().int().min(0).max(6), opens: hhmm, closes: hhmm })).max(28),
      }),
      req.body,
    );
    for (let d = 0; d < 7; d++) {
      const day = body.hours.filter((h) => h.weekday === d).sort((a, b) => a.opens.localeCompare(b.opens));
      for (let i = 0; i < day.length; i++) {
        if (day[i]!.closes <= day[i]!.opens) throw badRequest('INVALID_HOURS', `Closing must be after opening (weekday ${d})`);
        if (i > 0 && day[i]!.opens < day[i - 1]!.closes) throw badRequest('INVALID_HOURS', `Overlapping intervals (weekday ${d})`);
      }
    }
    await deps.queue.touch(access.salon.id, async (tx) => {
      await tx.query(`DELETE FROM business_hours WHERE salon_id = $1`, [access.salon.id]);
      for (const h of body.hours) {
        await tx.query(`INSERT INTO business_hours (salon_id, weekday, opens, closes) VALUES ($1, $2, $3, $4)`, [
          access.salon.id, h.weekday, h.opens, h.closes,
        ]);
      }
    });
    return { hours: body.hours };
  });

  app.post(`${P}/holidays`, async (req, reply) => {
    const { slug } = parse(slugParam, req.params);
    const access = await requireStaff(req, deps.db, slug, OWNER);
    const body = parse(z.object({ date: z.string().date(), note: z.string().max(200).nullish() }), req.body);
    await deps.queue.touch(access.salon.id, async (tx) => {
      await tx.query(
        `INSERT INTO holidays (salon_id, date, note) VALUES ($1, $2, $3)
         ON CONFLICT (salon_id, date) DO UPDATE SET note = EXCLUDED.note`,
        [access.salon.id, body.date, body.note ?? null],
      );
    });
    reply.code(201);
    return { holiday: { date: body.date, note: body.note ?? null } };
  });

  app.delete(`${P}/holidays/:date`, async (req) => {
    const { slug, date } = parse(z.object({ slug: z.string(), date: z.string().date() }), req.params);
    const access = await requireStaff(req, deps.db, slug, OWNER);
    await deps.queue.touch(access.salon.id, async (tx) => {
      await tx.query(`DELETE FROM holidays WHERE salon_id = $1 AND date = $2`, [access.salon.id, date]);
    });
    return { ok: true };
  });

  // ------------------------------------------------------------ reports

  // Pilot gate: how close were the wait estimates shown at join to when service actually started?
  app.get(`${P}/reports/accuracy`, async (req) => {
    const { slug } = parse(slugParam, req.params);
    const access = await requireStaff(req, deps.db, slug, DESK_ROLES);
    const tz = access.salon.timezone;
    const q = parse(z.object({ date: z.string().date().optional() }), req.query);
    const date = q.date ?? localDate(deps.now(), tz).date;
    const from = zonedToUtc(date, '00:00', tz);
    const to = zonedToUtc(addDays(date, 1), '00:00', tz);

    const { rows: summary } = await deps.db.query(
      `WITH day AS (
         SELECT e.*, EXTRACT(EPOCH FROM (e.started_at - e.initial_est_start_at)) / 60 AS err_min,
                EXTRACT(EPOCH FROM (e.started_at - e.joined_at)) / 60 AS wait_min
           FROM queue_entries e WHERE e.salon_id = $1 AND e.joined_at >= $2 AND e.joined_at < $3)
       SELECT count(*)::int AS joined,
              count(*) FILTER (WHERE started_at IS NOT NULL)::int AS served,
              count(*) FILTER (WHERE status = 'no_show')::int AS no_shows,
              count(*) FILTER (WHERE status = 'left')::int AS left_queue,
              count(*) FILTER (WHERE source = 'app')::int AS via_app,
              count(*) FILTER (WHERE join_mode = 'e_walk_in')::int AS via_e_walk_in,
              round(avg(abs(err_min))::numeric, 1)::float AS mean_abs_error_minutes,
              round(avg(err_min)::numeric, 1)::float AS mean_signed_error_minutes,
              round((avg((abs(err_min) <= 10)::int) FILTER (WHERE err_min IS NOT NULL) * 100)::numeric, 0)::float AS pct_within_10_min,
              round(avg(wait_min)::numeric, 1)::float AS mean_actual_wait_minutes
         FROM day`,
      [access.salon.id, from, to],
    );
    const { rows: byStylist } = await deps.db.query(
      `SELECT st.id AS stylist_id, st.display_name, count(*)::int AS served,
              round(avg(abs(EXTRACT(EPOCH FROM (e.started_at - e.initial_est_start_at)) / 60))::numeric, 1)::float AS mean_abs_error_minutes,
              round(avg(EXTRACT(EPOCH FROM (e.finished_at - e.started_at)) / 60
                        - (SELECT sum(minutes_snapshot) FROM queue_entry_services s WHERE s.queue_entry_id = e.id))::numeric, 1)::float
                AS mean_overrun_minutes
         FROM queue_entries e JOIN stylists st ON st.id = e.stylist_id
        WHERE e.salon_id = $1 AND e.joined_at >= $2 AND e.joined_at < $3 AND e.started_at IS NOT NULL
        GROUP BY st.id ORDER BY st.display_name`,
      [access.salon.id, from, to],
    );
    return { date, timezone: tz, summary: summary[0], by_stylist: byStylist };
  });

  async function entryResponse(state: SalonState, entryId: string) {
    const e = state.entries.find((x) => x.id === entryId) ?? (await loadEntry(deps.db, entryId));
    if (!e) throw notFound('Queue entry');
    return { entry: dashboardEntryView(state, e) };
  }
}

async function setStylistServices(
  tx: import('../db.js').Tx,
  salonId: string,
  stylistId: string,
  services: { service_id: string; custom_minutes: number | null }[],
) {
  await tx.query(`DELETE FROM stylist_services WHERE stylist_id = $1`, [stylistId]);
  for (const s of services) {
    const { rowCount } = await tx.query(
      `INSERT INTO stylist_services (salon_id, stylist_id, service_id, custom_minutes)
       SELECT $1, $2, id, $4 FROM services WHERE id = $3 AND salon_id = $1`,
      [salonId, stylistId, s.service_id, s.custom_minutes],
    );
    if (!rowCount) throw badRequest('INVALID_SERVICES', `Unknown service ${s.service_id}`);
  }
}
