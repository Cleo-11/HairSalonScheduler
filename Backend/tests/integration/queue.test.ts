import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { hashPassword } from '../../src/auth/password.js';
import { Sweeper } from '../../src/queue/sweeper.js';
import { DEMO, auth, expectContract, makeApp, nextPhone, signInCustomer, signInStaff, type TestCtx } from '../helpers.js';

const SLUG = DEMO.salon.slug;
const S = DEMO.services;
const T = DEMO.stylists;
const NEAR = { lat: 19.0550, lng: 72.8345 };

let ctx: TestCtx;
let owner: string;
let desk: string;
let anjali: string; // stylist login linked to Anjali

beforeAll(async () => {
  ctx = await makeApp();
});
afterAll(() => ctx.close());
beforeEach(async () => {
  const { seedDemo } = await import('../../src/seed.js');
  await seedDemo(ctx.db);
  ctx.clock.set('2026-09-29T06:30:00Z'); // Tue 12:00 IST
  ctx.messenger.outbox.length = 0;
  owner = await signInStaff(ctx, DEMO.staff.owner.email);
  desk = await signInStaff(ctx, DEMO.staff.receptionist.email);
  anjali = await signInStaff(ctx, DEMO.staff.stylist.email);
});

// ------------------------------------------------------------------ helpers

async function join(token: string, body: Record<string, unknown>, slug = SLUG) {
  return ctx.app.inject({ method: 'POST', url: `/v1/salons/${slug}/queue`, headers: auth(token), payload: body });
}
async function joinOk(token: string, services: string[], stylist: string | null = null) {
  const r = await join(token, { service_ids: services, stylist_id: stylist, location: NEAR });
  expect(r.statusCode, r.body).toBe(201);
  return r.json().entry;
}
async function walkIn(name: string, services: string[], stylist: string | null = null, phone?: string) {
  const r = await ctx.app.inject({
    method: 'POST', url: `/v1/dashboard/${SLUG}/walk-ins`, headers: auth(desk),
    payload: { name, service_ids: services, stylist_id: stylist, phone },
  });
  expect(r.statusCode, r.body).toBe(201);
  return r.json().entry;
}
async function act(entryId: string, action: string, token = desk, payload?: object) {
  return ctx.app.inject({ method: 'POST', url: `/v1/dashboard/${SLUG}/queue/${entryId}/${action}`, headers: auth(token), payload });
}
async function actOk(entryId: string, action: string, token = desk, payload?: object) {
  const r = await act(entryId, action, token, payload);
  expect(r.statusCode, r.body).toBe(200);
  return r.json().entry;
}
async function myEntry(token: string, id: string) {
  const r = await ctx.app.inject({ method: 'GET', url: `/v1/queue/${id}`, headers: auth(token) });
  expect(r.statusCode, r.body).toBe(200);
  return r.json().entry;
}
async function dashboard(token = desk) {
  const r = await ctx.app.inject({ method: 'GET', url: `/v1/dashboard/${SLUG}`, headers: auth(token) });
  expect(r.statusCode, r.body).toBe(200);
  return r.json();
}
const sweeper = () => new Sweeper(ctx.db, ctx.deps.queue, 0, () => {});

// ------------------------------------------------------------------ tests

describe('customer journey', () => {
  it('discovers the salon, picks services and a stylist, joins, and is served', async () => {
    const list = await ctx.app.inject({ method: 'GET', url: `/v1/salons?lat=${NEAR.lat}&lng=${NEAR.lng}` });
    await expectContract('GET', '/v1/salons', 200, list.json());
    expect(list.json().salons[0]).toMatchObject({ slug: SLUG, within_join_radius: true, accepting_joins: true });

    const noLoc = await ctx.app.inject({ method: 'GET', url: `/v1/salons` });
    expect(noLoc.json().salons[0]).toMatchObject({ slug: SLUG, distance_m: null, within_join_radius: null });

    const salon = await ctx.app.inject({ method: 'GET', url: `/v1/salons/${SLUG}` });
    await expectContract('GET', '/v1/salons/{slug}', 200, salon.json());
    expect(salon.json().salon.hours).toHaveLength(7);

    const services = await ctx.app.inject({ method: 'GET', url: `/v1/salons/${SLUG}/services` });
    await expectContract('GET', '/v1/salons/{slug}/services', 200, services.json());
    expect(services.json().services).toHaveLength(8);

    const cards = await ctx.app.inject({ method: 'GET', url: `/v1/salons/${SLUG}/stylists?service_ids=${S.mensCut}` });
    await expectContract('GET', '/v1/salons/{slug}/stylists', 200, cards.json());
    const body = cards.json();
    // Farah does not do men's cuts; Vikram is off.
    expect(body.stylists.map((s: { display_name: string }) => s.display_name)).toEqual(['Anjali', 'Rahul', 'Vikram']);
    expect(body.stylists.find((s: { id: string }) => s.id === T.vikram)).toMatchObject({ available: false, wait_minutes: null });
    expect(body.stylists.find((s: { id: string }) => s.id === T.rahul)).toMatchObject({ minutes: 25, wait_minutes: 0 });
    // Both can start now; Rahul finishes first (25 vs 35 min).
    expect(body.any_available).toMatchObject({ stylist_id: T.rahul, wait_minutes: 0, minutes: 25 });

    const c = await signInCustomer(ctx, 'Ravi');
    const r = await join(c.token, { service_ids: [S.mensCut, S.beardTrim], stylist_id: null, location: NEAR });
    expect(r.statusCode).toBe(201);
    await expectContract('POST', '/v1/salons/{slug}/queue', 201, r.json());
    const entry = r.json().entry;
    expect(entry).toMatchObject({
      status: 'waiting',
      stylist: { id: T.rahul, display_name: 'Rahul' },
      any_stylist: true,
      total_minutes: 40,
      total_price_paise: 45_000,
      people_ahead: 0,
      wait_minutes: 0,
      salon: { slug: SLUG },
    });

    const mine = await ctx.app.inject({ method: 'GET', url: '/v1/me/queue', headers: auth(c.token) });
    await expectContract('GET', '/v1/me/queue', 200, mine.json());
    expect(mine.json().entries.map((e: { id: string }) => e.id)).toEqual([entry.id]);

    const dash = await dashboard();
    await expectContract('GET', '/v1/dashboard/{slug}', 200, dash);
    expect(dash.entries[0]).toMatchObject({ id: entry.id, display_name: 'Ravi', source: 'app', phone_masked: expect.stringMatching(/^\+91 ••••• •\d{4}$/) });

    const called = await act(entry.id, 'call');
    await expectContract('POST', '/v1/dashboard/{slug}/queue/{entryId}/call', 200, called.json());
    expect(called.json().entry.status).toBe('called');
    expect(ctx.messenger.outbox).toContainEqual(expect.objectContaining({ kind: 'called', to: c.phone }));

    const started = await actOk(entry.id, 'start');
    expect(started.status).toBe('in_service');
    expect((await dashboard()).stylists.find((s: { id: string }) => s.id === T.rahul)).toMatchObject({ status: 'busy', current_entry_id: entry.id });

    ctx.clock.advance(38);
    const done = await actOk(entry.id, 'finish');
    expect(done.status).toBe('done');
    expect((await dashboard()).stylists.find((s: { id: string }) => s.id === T.rahul).status).toBe('available');

    const after = await ctx.app.inject({ method: 'GET', url: `/v1/queue/${entry.id}`, headers: auth(c.token) });
    await expectContract('GET', '/v1/queue/{entryId}', 200, after.json());
    expect(after.json().entry).toMatchObject({ status: 'done', est_start_at: null, people_ahead: null });
  });

  it('estimates stack per stylist and react to extensions and overruns', async () => {
    const a = await walkIn('A', [S.mensCut], T.rahul);
    const c = await signInCustomer(ctx, 'B');
    const b = await joinOk(c.token, [S.mensCut], T.rahul);
    expect(b).toMatchObject({ wait_minutes: 30, people_ahead: 1 }); // 25 + 5 buffer
    expect(b.wait_range_minutes.low).toBeLessThanOrEqual(30);
    expect(b.wait_range_minutes.high).toBeGreaterThanOrEqual(30);

    await actOk(a.id, 'start');
    ctx.clock.advance(10);
    expect((await myEntry(c.token, b.id)).wait_minutes).toBe(20);

    const ext = await act(a.id, 'extend', desk, { minutes: 10 });
    await expectContract('POST', '/v1/dashboard/{slug}/queue/{entryId}/extend', 200, ext.json());
    expect(ext.json().entry).toMatchObject({ extra_minutes: 10, total_minutes: 35 });
    expect((await myEntry(c.token, b.id)).wait_minutes).toBe(30);

    // Overrun: 50 minutes into a 35-minute job. Assume it ends now.
    ctx.clock.advance(40);
    expect((await myEntry(c.token, b.id)).wait_minutes).toBe(5);
  });

  it('"any available" goes to whoever can start soonest', async () => {
    const w = await walkIn('Busy', [S.mensCut], T.rahul);
    await actOk(w.id, 'start');
    const c = await signInCustomer(ctx);
    const e = await joinOk(c.token, [S.mensCut]);
    expect(e.stylist.id).toBe(T.anjali);
    expect(e.total_minutes).toBe(35); // Anjali's own duration
  });

  it('many simultaneous joins get distinct positions', async () => {
    const customers = await Promise.all(Array.from({ length: 8 }, (_, i) => signInCustomer(ctx, `C${i}`)));
    const results = await Promise.all(customers.map((c) => join(c.token, { service_ids: [S.mensCut], stylist_id: T.rahul })));
    expect(results.every((r) => r.statusCode === 201)).toBe(true);
    const dash = await dashboard();
    const waits = dash.entries.map((e: { wait_minutes: number }) => e.wait_minutes);
    expect(new Set(dash.entries.map((e: { position: number }) => e.position)).size).toBe(8);
    expect(waits).toEqual([0, 30, 60, 90, 120, 150, 180, 210]);
  });
});

describe('join rules', () => {
  it('needs a name first', async () => {
    const c = await signInCustomer(ctx, null);
    const r = await join(c.token, { service_ids: [S.mensCut] });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe('NAME_REQUIRED');
  });

  it('refuses joins from far away but allows unknown location', async () => {
    const c = await signInCustomer(ctx);
    const far = await join(c.token, { service_ids: [S.mensCut], location: { lat: 18.52, lng: 73.85 } }); // Pune
    expect(far.statusCode).toBe(403);
    expect(far.json().error).toMatchObject({ code: 'TOO_FAR_FROM_SALON', details: { max_distance_m: 3000 } });
    await expectContract('POST', '/v1/salons/{slug}/queue', 403, far.json());
    expect((await join(c.token, { service_ids: [S.mensCut] })).statusCode).toBe(201);
  });

  it('checks services and stylist choice', async () => {
    const c = await signInCustomer(ctx);
    expect((await join(c.token, { service_ids: ['00000000-0000-4000-8000-999999999999'] })).json().error.code).toBe('INVALID_SERVICES');
    expect((await join(c.token, { service_ids: [] })).json().error.code).toBe('VALIDATION_ERROR');
    expect((await join(c.token, { service_ids: [S.mensCut], stylist_id: T.farah })).json().error.code).toBe('STYLIST_DOES_NOT_OFFER');
    const off = await join(c.token, { service_ids: [S.mensCut], stylist_id: T.vikram });
    expect(off.statusCode).toBe(409);
    expect(off.json().error.code).toBe('STYLIST_UNAVAILABLE');
  });

  it('one active place per customer', async () => {
    const c = await signInCustomer(ctx);
    const e = await joinOk(c.token, [S.mensCut]);
    const again = await join(c.token, { service_ids: [S.beardTrim] });
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toMatchObject({ code: 'ALREADY_IN_QUEUE', details: { entry_id: e.id } });
  });

  it('refuses joins when closed, paused, or too late to fit in', async () => {
    const c = await signInCustomer(ctx);

    ctx.clock.set('2026-09-29T02:30:00Z'); // 08:00 IST
    const closed = await join(c.token, { service_ids: [S.mensCut] });
    expect(closed.statusCode).toBe(409);
    expect(closed.json().error).toMatchObject({ code: 'SALON_CLOSED', details: { next_open_at: '2026-09-29T04:30:00.000Z' } });

    ctx.clock.set('2026-09-29T06:30:00Z');
    await ctx.app.inject({ method: 'PATCH', url: `/v1/dashboard/${SLUG}/settings`, headers: auth(desk), payload: { joins_paused: true } });
    expect((await join(c.token, { service_ids: [S.mensCut] })).json().error.code).toBe('JOINS_PAUSED');
    await ctx.app.inject({ method: 'PATCH', url: `/v1/dashboard/${SLUG}/settings`, headers: auth(desk), payload: { joins_paused: false } });

    ctx.clock.set('2026-09-29T15:20:00Z'); // 20:50 IST, closes 21:00
    await walkIn('Late colour', [S.globalColour], T.anjali); // walk-ins may be added late
    const late = await join(c.token, { service_ids: [S.womensCut], stylist_id: T.anjali });
    expect(late.json().error.code).toBe('WOULD_EXCEED_CLOSING');
    // Farah is free and can start before closing.
    expect((await join(c.token, { service_ids: [S.womensCut], stylist_id: T.farah })).statusCode).toBe(201);
  });
});

describe('leaving and no-shows', () => {
  it('customer can leave; the people behind move up', async () => {
    const c1 = await signInCustomer(ctx);
    const c2 = await signInCustomer(ctx);
    const e1 = await joinOk(c1.token, [S.mensCut], T.rahul);
    const e2 = await joinOk(c2.token, [S.mensCut], T.rahul);
    expect(e2.wait_minutes).toBe(30);
    const left = await ctx.app.inject({ method: 'POST', url: `/v1/queue/${e1.id}/leave`, headers: auth(c1.token) });
    await expectContract('POST', '/v1/queue/{entryId}/leave', 200, left.json());
    expect(left.json().entry.status).toBe('left');
    expect((await myEntry(c2.token, e2.id)).wait_minutes).toBe(0);
    const again = await ctx.app.inject({ method: 'POST', url: `/v1/queue/${e1.id}/leave`, headers: auth(c1.token) });
    expect(again.json().error.code).toBe('CANNOT_LEAVE');
    // Someone else's entry is invisible.
    expect((await ctx.app.inject({ method: 'GET', url: `/v1/queue/${e2.id}`, headers: auth(c1.token) })).statusCode).toBe(404);
  });

  it('cannot leave once in service', async () => {
    const c = await signInCustomer(ctx);
    const e = await joinOk(c.token, [S.mensCut]);
    await actOk(e.id, 'start');
    const r = await ctx.app.inject({ method: 'POST', url: `/v1/queue/${e.id}/leave`, headers: auth(c.token) });
    expect(r.statusCode).toBe(409);
  });

  it('a called customer who misses the grace period goes to the back once, then is a no-show', async () => {
    const c = await signInCustomer(ctx);
    const e = await joinOk(c.token, [S.mensCut], T.rahul);
    await walkIn('Behind', [S.mensCut], T.rahul);
    await actOk(e.id, 'call');

    ctx.clock.advance(4);
    await sweeper().runOnce();
    expect((await myEntry(c.token, e.id)).status).toBe('called');

    ctx.clock.advance(2);
    await sweeper().runOnce();
    const requeued = await myEntry(c.token, e.id);
    expect(requeued).toMatchObject({ status: 'waiting', people_ahead: 1 });

    const dash = await dashboard();
    const behind = dash.entries.find((x: { display_name: string }) => x.display_name === 'Behind');
    await actOk(behind.id, 'start');
    await actOk(e.id, 'call');
    ctx.clock.advance(6);
    await sweeper().runOnce();
    expect((await myEntry(c.token, e.id)).status).toBe('no_show');
  });

  it('desk actions: skip to back, no-show, cancel, and invalid transitions', async () => {
    const a = await walkIn('A', [S.mensCut], T.rahul);
    const b = await walkIn('B', [S.mensCut], T.rahul);
    const c = await walkIn('C', [S.mensCut], T.rahul);
    const skipped = await actOk(a.id, 'requeue');
    expect(skipped).toMatchObject({ skip_count: 1, people_ahead: 2 });
    expect((await actOk(b.id, 'no-show')).status).toBe('no_show');
    expect((await actOk(c.id, 'cancel')).status).toBe('cancelled');
    const bad = await act(b.id, 'start');
    expect(bad.statusCode).toBe(409);
    expect(bad.json().error.code).toBe('INVALID_TRANSITION');
    expect((await act(a.id, 'finish')).json().error.code).toBe('INVALID_TRANSITION');
  });

  it('one customer in the chair and one called per stylist', async () => {
    const a = await walkIn('A', [S.mensCut], T.rahul);
    const b = await walkIn('B', [S.mensCut], T.rahul);
    const c = await walkIn('C', [S.mensCut], T.rahul);
    await actOk(a.id, 'start');
    expect((await act(b.id, 'start')).json().error.code).toBe('STYLIST_BUSY');
    await actOk(b.id, 'call');
    expect((await act(c.id, 'call')).json().error.code).toBe('STYLIST_ALREADY_CALLING');
  });
});

describe('turn-near WhatsApp alert', () => {
  it('fires once when the wait drops to the alert threshold', async () => {
    const w1 = await walkIn('W1', [S.mensCut], T.rahul);
    const w2 = await walkIn('W2', [S.mensCut], T.rahul);
    await actOk(w1.id, 'start');
    const c = await signInCustomer(ctx, 'Meena');
    const e = await joinOk(c.token, [S.mensCut], T.rahul);
    expect(e.wait_minutes).toBe(60);
    const alerts = () => ctx.messenger.outbox.filter((m) => m.kind === 'turn_alert' && m.to === c.phone);

    ctx.clock.advance(25);
    await actOk(w1.id, 'finish');
    await actOk(w2.id, 'start');
    expect(alerts()).toHaveLength(0); // wait is 30

    ctx.clock.advance(20);
    await sweeper().runOnce();
    expect(alerts()).toHaveLength(1);
    expect(alerts()[0]).toMatchObject({ alert: { stylistName: 'Rahul', minutesUntilStart: 10, customerName: 'Meena' } });

    ctx.clock.advance(1);
    await sweeper().runOnce();
    expect(alerts()).toHaveLength(1);
  });

  it('is not sent to someone who joined with a short wait', async () => {
    const c = await signInCustomer(ctx);
    await joinOk(c.token, [S.mensCut], T.rahul);
    await sweeper().runOnce();
    expect(ctx.messenger.outbox.filter((m) => m.kind === 'turn_alert')).toHaveLength(0);
  });

  it('a failed WhatsApp send does not undo the queue change', async () => {
    const original = ctx.messenger.sendCalled.bind(ctx.messenger);
    ctx.messenger.sendCalled = async () => {
      throw new Error('provider down');
    };
    try {
      const c = await signInCustomer(ctx);
      const e = await joinOk(c.token, [S.mensCut]);
      expect((await actOk(e.id, 'call')).status).toBe('called');
    } finally {
      ctx.messenger.sendCalled = original;
    }
  });
});

describe('stylist board', () => {
  it('break delays estimates; off moves "any" customers and flags named ones', async () => {
    const x = await signInCustomer(ctx, 'X');
    const y = await signInCustomer(ctx, 'Y');
    const ex = await joinOk(x.token, [S.womensCut]); // any -> Anjali (45 min) over Farah (50)
    expect(ex.stylist.id).toBe(T.anjali);
    const ey = await joinOk(y.token, [S.womensCut], T.anjali);

    const brk = await ctx.app.inject({
      method: 'PUT', url: `/v1/dashboard/${SLUG}/stylists/${T.anjali}/status`, headers: auth(anjali),
      payload: { status: 'break', break_minutes: 20 },
    });
    expect(brk.statusCode, brk.body).toBe(200);
    await expectContract('PUT', '/v1/dashboard/{slug}/stylists/{stylistId}/status', 200, brk.json());
    expect((await myEntry(x.token, ex.id)).wait_minutes).toBe(20);

    const off = await ctx.app.inject({
      method: 'PUT', url: `/v1/dashboard/${SLUG}/stylists/${T.anjali}/status`, headers: auth(desk), payload: { status: 'off' },
    });
    expect(off.statusCode).toBe(200);
    const movedX = await myEntry(x.token, ex.id);
    expect(movedX).toMatchObject({ stylist: { id: T.farah }, total_minutes: 50, wait_minutes: 0, stylist_available: true });
    const stuckY = await myEntry(y.token, ey.id);
    expect(stuckY).toMatchObject({ stylist: { id: T.anjali }, stylist_available: false, est_start_at: null });
    // The desk cannot call someone whose stylist is off.
    expect((await act(ey.id, 'call')).json().error.code).toBe('STYLIST_OFF');
  });

  it('cannot go off or on break with someone in the chair', async () => {
    const w = await walkIn('W', [S.mensCut], T.rahul);
    await actOk(w.id, 'start');
    const r = await ctx.app.inject({
      method: 'PUT', url: `/v1/dashboard/${SLUG}/stylists/${T.rahul}/status`, headers: auth(desk), payload: { status: 'off' },
    });
    expect(r.json().error.code).toBe('STYLIST_HAS_ACTIVE_SERVICE');
  });

  it('reorders and reassigns (re-reading the new stylist\'s durations)', async () => {
    const a = await walkIn('A', [S.mensCut], T.rahul);
    await walkIn('B', [S.mensCut], T.rahul);
    const c = await walkIn('C', [S.mensCut], T.rahul);
    const moved = await ctx.app.inject({
      method: 'PATCH', url: `/v1/dashboard/${SLUG}/queue/${c.id}`, headers: auth(desk), payload: { position: 1 },
    });
    expect(moved.statusCode, moved.body).toBe(200);
    await expectContract('PATCH', '/v1/dashboard/{slug}/queue/{entryId}', 200, moved.json());
    expect(moved.json().entry).toMatchObject({ people_ahead: 0, wait_minutes: 0 });
    expect((await dashboard()).entries.filter((e: { stylist: { id: string } }) => e.stylist.id === T.rahul).map((e: { display_name: string }) => e.display_name)).toEqual(['C', 'A', 'B']);

    const re = await ctx.app.inject({
      method: 'PATCH', url: `/v1/dashboard/${SLUG}/queue/${a.id}`, headers: auth(desk), payload: { stylist_id: T.anjali },
    });
    expect(re.json().entry).toMatchObject({ stylist: { id: T.anjali }, total_minutes: 35 });
    const bad = await ctx.app.inject({
      method: 'PATCH', url: `/v1/dashboard/${SLUG}/queue/${a.id}`, headers: auth(desk), payload: { stylist_id: T.farah },
    });
    expect(bad.json().error.code).toBe('STYLIST_DOES_NOT_OFFER');
    const toOff = await ctx.app.inject({
      method: 'PATCH', url: `/v1/dashboard/${SLUG}/queue/${a.id}`, headers: auth(desk), payload: { stylist_id: T.vikram },
    });
    expect(toOff.json().error.code).toBe('STYLIST_UNAVAILABLE');
  });

  it('duration changes update waiting customers but not their price', async () => {
    const c = await signInCustomer(ctx);
    await walkIn('First', [S.mensCut], T.rahul);
    const e = await joinOk(c.token, [S.mensCut], T.rahul);
    expect(e.wait_minutes).toBe(30);
    const put = await ctx.app.inject({
      method: 'PUT', url: `/v1/dashboard/${SLUG}/stylists/${T.rahul}/services`, headers: auth(owner),
      payload: { services: [{ service_id: S.mensCut, custom_minutes: 40 }, { service_id: S.beardTrim }] },
    });
    expect(put.statusCode, put.body).toBe(200);
    const after = await myEntry(c.token, e.id);
    expect(after).toMatchObject({ total_minutes: 40, wait_minutes: 45, total_price_paise: 30_000 });

    await ctx.app.inject({
      method: 'PATCH', url: `/v1/dashboard/${SLUG}/services/${S.mensCut}`, headers: auth(owner), payload: { price_paise: 99_900 },
    });
    expect((await myEntry(c.token, e.id)).total_price_paise).toBe(30_000);
  });
});

describe('roles and salon isolation', () => {
  it('stylists act only on their own customers and status', async () => {
    const r = await walkIn('R', [S.mensCut], T.rahul);
    const a = await walkIn('A', [S.womensCut], T.anjali);
    expect((await act(r.id, 'call', anjali)).statusCode).toBe(403);
    expect((await act(a.id, 'call', anjali)).statusCode).toBe(200);
    expect((await act(a.id, 'no-show', anjali)).statusCode).toBe(403); // desk only
    const other = await ctx.app.inject({
      method: 'PUT', url: `/v1/dashboard/${SLUG}/stylists/${T.rahul}/status`, headers: auth(anjali), payload: { status: 'break' },
    });
    expect(other.statusCode).toBe(403);
    expect((await ctx.app.inject({ method: 'POST', url: `/v1/dashboard/${SLUG}/walk-ins`, headers: auth(anjali), payload: { name: 'x', service_ids: [S.mensCut] } })).statusCode).toBe(403);
  });

  it('receptionists can pause joins but not change owner settings', async () => {
    const pause = await ctx.app.inject({ method: 'PATCH', url: `/v1/dashboard/${SLUG}/settings`, headers: auth(desk), payload: { joins_paused: true } });
    expect(pause.statusCode).toBe(200);
    await expectContract('PATCH', '/v1/dashboard/{slug}/settings', 200, pause.json());
    const buf = await ctx.app.inject({ method: 'PATCH', url: `/v1/dashboard/${SLUG}/settings`, headers: auth(desk), payload: { buffer_minutes: 0 } });
    expect(buf.statusCode).toBe(403);
    const hours = await ctx.app.inject({ method: 'PUT', url: `/v1/dashboard/${SLUG}/hours`, headers: auth(desk), payload: { hours: [] } });
    expect(hours.statusCode).toBe(403);
  });

  it('staff of one salon cannot see or touch another salon', async () => {
    // A second salon with its own owner.
    const salon2 = '00000000-0000-4000-8000-00000000a002';
    await ctx.db.query(`DELETE FROM salons WHERE id = $1`, [salon2]);
    await ctx.db.query(
      `INSERT INTO salons (id, slug, name, address, lat, lng) VALUES ($1, 'second-salon', 'Second', 'Andheri', 19.1197, 72.8468)`,
      [salon2],
    );
    await ctx.db.query(`DELETE FROM staff_users WHERE email = 'owner2@x.test'`);
    const { rows } = await ctx.db.query(
      `INSERT INTO staff_users (email, name, password_hash) VALUES ('owner2@x.test', 'Owner 2', $1) RETURNING id`,
      [await hashPassword('pw-owner-2')],
    );
    await ctx.db.query(`INSERT INTO staff_members (staff_user_id, salon_id, role) VALUES ($1, $2, 'owner')`, [rows[0].id, salon2]);
    const owner2 = await signInStaff(ctx, 'owner2@x.test', 'pw-owner-2');

    const e = await walkIn('Demo customer', [S.mensCut]);
    const r1 = await ctx.app.inject({ method: 'GET', url: `/v1/dashboard/${SLUG}`, headers: auth(owner2) });
    expect(r1.statusCode).toBe(403);
    // Using their own salon's URL with the other salon's entry id finds nothing.
    const r2 = await ctx.app.inject({ method: 'POST', url: `/v1/dashboard/second-salon/queue/${e.id}/cancel`, headers: auth(owner2) });
    expect(r2.statusCode).toBe(404);
    const r3 = await ctx.app.inject({ method: 'GET', url: `/v1/dashboard/second-salon`, headers: auth(owner) });
    expect(r3.statusCode).toBe(403);
    // Nearest-first ordering with two salons.
    const near2 = await ctx.app.inject({ method: 'GET', url: `/v1/salons?lat=19.12&lng=72.847` });
    expect(near2.json().salons.map((s: { slug: string }) => s.slug)).toEqual(['second-salon', SLUG]);
    // The database refuses cross-salon references even if code forgot to check.
    await expect(
      ctx.db.query(`UPDATE queue_entries SET salon_id = $1 WHERE id = $2`, [salon2, e.id]),
    ).rejects.toThrow(/foreign key/);
    await ctx.db.query(`DELETE FROM salons WHERE id = $1`, [salon2]);
  });
});

describe('walk-ins', () => {
  it('with a phone number, links to the customer so they get alerts and see it in the app', async () => {
    const phone = nextPhone();
    const w = await walkIn('Walk In', [S.kidsCut], null, phone.replace('+91', ''));
    await expectContract('POST', '/v1/dashboard/{slug}/walk-ins', 201, { entry: w });
    expect(w).toMatchObject({ source: 'walk_in', display_name: 'Walk In' });
    const c = await signInCustomer(ctx, null, phone);
    const mine = await ctx.app.inject({ method: 'GET', url: '/v1/me/queue', headers: auth(c.token) });
    expect(mine.json().entries.map((e: { id: string }) => e.id)).toEqual([w.id]);
    const me = await ctx.app.inject({ method: 'GET', url: '/v1/me', headers: auth(c.token) });
    expect(me.json().customer.name).toBe('Walk In');
  });

  it('walk-ins may be added before opening', async () => {
    ctx.clock.set('2026-09-29T04:10:00Z'); // 09:40 IST
    const w = await walkIn('Early', [S.mensCut], T.rahul);
    expect(w.est_start_at).toBe('2026-09-29T04:30:00.000Z'); // starts at opening
  });
});

describe('owner settings', () => {
  it('services: create, list, hide', async () => {
    const created = await ctx.app.inject({
      method: 'POST', url: `/v1/dashboard/${SLUG}/services`, headers: auth(owner),
      payload: { name: 'Hair spa', price_paise: 150_000, default_minutes: 45, stylist_ids: [T.anjali, T.farah] },
    });
    expect(created.statusCode, created.body).toBe(201);
    await expectContract('POST', '/v1/dashboard/{slug}/services', 201, created.json());
    const id = created.json().service.id;
    const cards = await ctx.app.inject({ method: 'GET', url: `/v1/salons/${SLUG}/stylists?service_ids=${id}` });
    expect(cards.json().stylists.map((s: { id: string }) => s.id).sort()).toEqual([T.anjali, T.farah].sort());

    const dup = await ctx.app.inject({
      method: 'POST', url: `/v1/dashboard/${SLUG}/services`, headers: auth(owner),
      payload: { name: 'Hair spa', price_paise: 1, default_minutes: 1 },
    });
    expect(dup.json().error.code).toBe('DUPLICATE_SERVICE');

    const hidden = await ctx.app.inject({
      method: 'PATCH', url: `/v1/dashboard/${SLUG}/services/${id}`, headers: auth(owner), payload: { is_active: false },
    });
    await expectContract('PATCH', '/v1/dashboard/{slug}/services/{serviceId}', 200, hidden.json());
    const pub = await ctx.app.inject({ method: 'GET', url: `/v1/salons/${SLUG}/services` });
    expect(pub.json().services.map((s: { id: string }) => s.id)).not.toContain(id);
    const admin = await ctx.app.inject({ method: 'GET', url: `/v1/dashboard/${SLUG}/services`, headers: auth(desk) });
    await expectContract('GET', '/v1/dashboard/{slug}/services', 200, admin.json());
    expect(admin.json().services).toHaveLength(9);
  });

  it('stylists: create, list with overrides, deactivate', async () => {
    const created = await ctx.app.inject({
      method: 'POST', url: `/v1/dashboard/${SLUG}/stylists`, headers: auth(owner),
      payload: { display_name: 'Zoya', service_ids: [S.womensCut] },
    });
    expect(created.statusCode, created.body).toBe(201);
    await expectContract('POST', '/v1/dashboard/{slug}/stylists', 201, created.json());
    const list = await ctx.app.inject({ method: 'GET', url: `/v1/dashboard/${SLUG}/stylists`, headers: auth(desk) });
    await expectContract('GET', '/v1/dashboard/{slug}/stylists', 200, list.json());
    const rahul = list.json().stylists.find((s: { id: string }) => s.id === T.rahul);
    expect(rahul.services.find((s: { service_id: string }) => s.service_id === S.mensCut)).toMatchObject({
      default_minutes: 30, custom_minutes: 25, effective_minutes: 25,
    });

    await walkIn('W', [S.mensCut], T.rahul);
    const busy = await ctx.app.inject({
      method: 'PATCH', url: `/v1/dashboard/${SLUG}/stylists/${T.rahul}`, headers: auth(owner), payload: { is_active: false },
    });
    expect(busy.json().error.code).toBe('STYLIST_HAS_QUEUE');
    const ok = await ctx.app.inject({
      method: 'PATCH', url: `/v1/dashboard/${SLUG}/stylists/${created.json().stylist.id}`, headers: auth(owner), payload: { is_active: false },
    });
    expect(ok.statusCode).toBe(200);
    await expectContract('PATCH', '/v1/dashboard/{slug}/stylists/{stylistId}', 200, ok.json());
  });

  it('hours with a lunch break, and holidays', async () => {
    const hours = [0, 1, 2, 3, 4, 5, 6].flatMap((weekday) => [
      { weekday, opens: '10:00', closes: '11:30' },
      { weekday, opens: '13:00', closes: '21:00' },
    ]);
    const put = await ctx.app.inject({ method: 'PUT', url: `/v1/dashboard/${SLUG}/hours`, headers: auth(owner), payload: { hours } });
    expect(put.statusCode, put.body).toBe(200);
    await expectContract('PUT', '/v1/dashboard/{slug}/hours', 200, put.json());

    // 11:00 IST: someone in the chair until 11:25, next customer would start 11:30 -> pushed to 13:00.
    ctx.clock.set('2026-09-29T05:30:00Z');
    const w = await walkIn('W', [S.mensCut], T.rahul);
    await actOk(w.id, 'start');
    const c = await signInCustomer(ctx);
    const e = await joinOk(c.token, [S.mensCut], T.rahul);
    expect(e.est_start_at).toBe('2026-09-29T07:30:00.000Z');

    const overlap = await ctx.app.inject({
      method: 'PUT', url: `/v1/dashboard/${SLUG}/hours`, headers: auth(owner),
      payload: { hours: [{ weekday: 1, opens: '10:00', closes: '14:00' }, { weekday: 1, opens: '13:00', closes: '18:00' }] },
    });
    expect(overlap.json().error.code).toBe('INVALID_HOURS');

    const hol = await ctx.app.inject({ method: 'POST', url: `/v1/dashboard/${SLUG}/holidays`, headers: auth(owner), payload: { date: '2026-09-29', note: 'Dussehra' } });
    expect(hol.statusCode).toBe(201);
    await expectContract('POST', '/v1/dashboard/{slug}/holidays', 201, hol.json());
    const salon = await ctx.app.inject({ method: 'GET', url: `/v1/salons/${SLUG}` });
    expect(salon.json().salon).toMatchObject({ is_open_now: false, is_holiday: true });
    const got = await ctx.app.inject({ method: 'GET', url: `/v1/dashboard/${SLUG}/hours`, headers: auth(desk) });
    await expectContract('GET', '/v1/dashboard/{slug}/hours', 200, got.json());
    expect(got.json().holidays).toEqual([{ date: '2026-09-29', note: 'Dussehra' }]);
    const del = await ctx.app.inject({ method: 'DELETE', url: `/v1/dashboard/${SLUG}/holidays/2026-09-29`, headers: auth(owner) });
    await expectContract('DELETE', '/v1/dashboard/{slug}/holidays/{date}', 200, del.json());
  });

  it('settings round-trip', async () => {
    const got = await ctx.app.inject({ method: 'GET', url: `/v1/dashboard/${SLUG}/settings`, headers: auth(desk) });
    await expectContract('GET', '/v1/dashboard/{slug}/settings', 200, got.json());
    const r = await ctx.app.inject({
      method: 'PATCH', url: `/v1/dashboard/${SLUG}/settings`, headers: auth(owner),
      payload: { buffer_minutes: 0, noshow_policy: 'mark_no_show', join_radius_m: null },
    });
    expect(r.json().settings).toMatchObject({ buffer_minutes: 0, noshow_policy: 'mark_no_show', join_radius_m: null });
    const unknown = await ctx.app.inject({ method: 'PATCH', url: `/v1/dashboard/${SLUG}/settings`, headers: auth(owner), payload: { slug: 'hack' } });
    expect(unknown.statusCode).toBe(400);
  });
});

describe('accuracy report', () => {
  it('compares the start time promised at join with the real one', async () => {
    const a = await walkIn('A', [S.mensCut], T.rahul); // promised 12:00
    const b = await walkIn('B', [S.mensCut], T.rahul); // promised 12:30
    await actOk(a.id, 'start');
    ctx.clock.advance(35);
    await actOk(a.id, 'finish');
    await actOk(b.id, 'start'); // started 12:35: 5 min late
    ctx.clock.advance(20);
    await actOk(b.id, 'finish');
    const r = await ctx.app.inject({ method: 'GET', url: `/v1/dashboard/${SLUG}/reports/accuracy?date=2026-09-29`, headers: auth(owner) });
    expect(r.statusCode, r.body).toBe(200);
    await expectContract('GET', '/v1/dashboard/{slug}/reports/accuracy', 200, r.json());
    expect(r.json().summary).toMatchObject({ joined: 2, served: 2, mean_abs_error_minutes: 2.5, pct_within_10_min: 100 });
    expect(r.json().by_stylist[0]).toMatchObject({ display_name: 'Rahul', served: 2, mean_overrun_minutes: 2.5 });
  });
});
