import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Deps } from '../app.js';
import { requireCustomer } from '../auth/guards.js';
import { badRequest, notFound } from '../errors.js';
import { parse, slugParam, uuid } from '../http.js';
import { customerEntryView } from '../queue/serialize.js';
import { loadEntry, loadSalonState } from '../queue/state.js';
import { salonById, salonBySlug } from '../salons/repo.js';

export const joinBody = z.object({
  service_ids: z.array(uuid).min(1).max(10),
  stylist_id: uuid.nullable().default(null), // null = any available (E Walk-In: random)
  e_walk_in: z.boolean().default(false), // join through E Walk-In (random stylist, or the one named in stylist_id)
  location: z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) }).nullish(),
});

export async function customerQueueRoutes(app: FastifyInstance, deps: Deps) {
  app.post('/v1/salons/:slug/queue', async (req, reply) => {
    const customerId = await requireCustomer(req);
    const { slug } = parse(slugParam, req.params);
    const body = parse(joinBody, req.body);
    const { rows } = await deps.db.query<{ name: string | null }>(`SELECT name FROM customers WHERE id = $1`, [customerId]);
    if (!rows[0]) throw notFound('Customer');
    if (!rows[0].name) throw badRequest('NAME_REQUIRED', 'Add your name before joining a queue');

    const salon = await salonBySlug(deps.db, slug);
    const { result: entryId, state } = await deps.queue.join({
      salon,
      serviceIds: body.service_ids,
      stylistId: body.stylist_id,
      source: 'app',
      eWalkIn: body.e_walk_in,
      customerId,
      location: body.location ?? null,
      actor: `customer:${customerId}`,
    });
    const entry = state.entries.find((e) => e.id === entryId)!;
    reply.code(201);
    return { entry: customerEntryView(state, entry) };
  });

  // The customer's current place(s) in a queue; empty list when none.
  app.get('/v1/me/queue', async (req) => {
    const customerId = await requireCustomer(req);
    const { rows } = await deps.db.query<{ id: string; salon_id: string }>(
      `SELECT id, salon_id FROM queue_entries
        WHERE customer_id = $1 AND status IN ('waiting', 'called', 'in_service') ORDER BY joined_at`,
      [customerId],
    );
    const entries = [];
    for (const r of rows) {
      const state = await loadSalonState(deps.db, await salonById(deps.db, r.salon_id), deps.now());
      const e = state.entries.find((x) => x.id === r.id);
      if (e) entries.push(customerEntryView(state, e));
    }
    return { entries };
  });

  app.get('/v1/queue/:entryId', async (req) => {
    const customerId = await requireCustomer(req);
    const { entryId } = parse(z.object({ entryId: uuid }), req.params);
    return { entry: await ownEntryView(deps, customerId, entryId) };
  });

  app.post('/v1/queue/:entryId/leave', async (req) => {
    const customerId = await requireCustomer(req);
    const { entryId } = parse(z.object({ entryId: uuid }), req.params);
    await deps.queue.leave(entryId, customerId);
    return { entry: await ownEntryView(deps, customerId, entryId) };
  });
}

async function ownEntryView(deps: Deps, customerId: string, entryId: string) {
  const info = await loadEntry(deps.db, entryId);
  if (!info || info.customerId !== customerId) throw notFound('Queue entry');
  const state = await loadSalonState(deps.db, await salonById(deps.db, info.salonId), deps.now());
  const live = state.entries.find((e) => e.id === entryId);
  return customerEntryView(state, live ?? info);
}
