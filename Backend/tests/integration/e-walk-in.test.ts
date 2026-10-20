import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DEMO, auth, expectContract, makeApp, signInCustomer, signInStaff, type TestCtx } from '../helpers.js';

const SLUG = DEMO.salon.slug;
const S = DEMO.services;
const T = DEMO.stylists;
const NEAR = { lat: 19.055, lng: 72.8345 };

let ctx: TestCtx;
let owner: string;
let desk: string;
let anjali: string;

beforeAll(async () => {
  ctx = await makeApp();
});
afterAll(() => ctx.close());
beforeEach(async () => {
  const { seedDemo } = await import('../../src/seed.js');
  await seedDemo(ctx.db);
  ctx.clock.set('2026-09-29T06:30:00Z'); // Tue 12:00 IST
  ctx.messenger.outbox.length = 0;
  setRandom(undefined);
  owner = await signInStaff(ctx, DEMO.staff.owner.email);
  desk = await signInStaff(ctx, DEMO.staff.receptionist.email);
  anjali = await signInStaff(ctx, DEMO.staff.stylist.email);
});

// Wash & blow-dry is done by Anjali and Farah only, and both start 'available' in the demo data.
const SERVICE = S.washBlowDry;
const POOL = [T.anjali, T.farah];

function setRandom(fn: (() => number) | undefined) {
  (ctx.deps.queue as unknown as { opts: { random?: () => number } }).opts.random = fn;
}

async function eWalkIn(token: string, stylist: string | null = null, services = [SERVICE]) {
  return ctx.app.inject({
    method: 'POST', url: `/v1/salons/${SLUG}/queue`, headers: auth(token),
    payload: { service_ids: services, stylist_id: stylist, e_walk_in: true, location: NEAR },
  });
}
async function eWalkInOk(token: string, stylist: string | null = null, services = [SERVICE]) {
  const r = await eWalkIn(token, stylist, services);
  expect(r.statusCode, r.body).toBe(201);
  await expectContract('POST', '/v1/salons/{slug}/queue', 201, r.json());
  return r.json().entry;
}
async function newCustomer(name = 'E Customer') {
  return (await signInCustomer(ctx, name)).token;
}
async function deskWalkIn(name: string, stylist: string, services = [SERVICE]) {
  const r = await ctx.app.inject({
    method: 'POST', url: `/v1/dashboard/${SLUG}/walk-ins`, headers: auth(desk),
    payload: { name, service_ids: services, stylist_id: stylist },
  });
  expect(r.statusCode, r.body).toBe(201);
  return r.json().entry;
}
async function act(entryId: string, action: string, token = desk) {
  const r = await ctx.app.inject({ method: 'POST', url: `/v1/dashboard/${SLUG}/queue/${entryId}/${action}`, headers: auth(token) });
  expect(r.statusCode, r.body).toBe(200);
  return r.json().entry;
}
async function cards(services = SERVICE) {
  const r = await ctx.app.inject({ method: 'GET', url: `/v1/salons/${SLUG}/stylists?service_ids=${services}` });
  expect(r.statusCode, r.body).toBe(200);
  await expectContract('GET', '/v1/salons/{slug}/stylists', 200, r.json());
  return r.json();
}
async function patchSettings(token: string, payload: object) {
  return ctx.app.inject({ method: 'PATCH', url: `/v1/dashboard/${SLUG}/settings`, headers: auth(token), payload });
}
async function setPool(token: string, stylistId: string, enabled: boolean) {
  return ctx.app.inject({
    method: 'PUT', url: `/v1/dashboard/${SLUG}/stylists/${stylistId}/e-walk-in`, headers: auth(token), payload: { enabled },
  });
}
async function dashboard() {
  const r = await ctx.app.inject({ method: 'GET', url: `/v1/dashboard/${SLUG}`, headers: auth(desk) });
  expect(r.statusCode, r.body).toBe(200);
  await expectContract('GET', '/v1/dashboard/{slug}', 200, r.json());
  return r.json();
}

async function extend(entryId: string, minutes: number) {
  const r = await ctx.app.inject({
    method: 'POST', url: `/v1/dashboard/${SLUG}/queue/${entryId}/extend`, headers: auth(desk), payload: { minutes },
  });
  expect(r.statusCode, r.body).toBe(200);
}
/** Put both stylists who do wash & blow-dry in the chair. Returns their entries. */
async function busyBoth(extraFarahMinutes = 0) {
  const a = await deskWalkIn('Chair A', T.anjali);
  const f = await deskWalkIn('Chair F', T.farah);
  await act(a.id, 'start');
  await act(f.id, 'start');
  if (extraFarahMinutes) await extend(f.id, extraFarahMinutes);
  return { a, f };
}

describe('E Walk-In: random stylist', () => {
  it('assigns one of the free stylists and flags the entry', async () => {
    const e = await eWalkInOk(await newCustomer());
    expect(POOL).toContain(e.stylist.id);
    expect(e).toMatchObject({ e_walk_in: true, any_stylist: true, requested_stylist_id: null, people_ahead: 0, wait_minutes: 0 });
  });

  it('lets the random number choose between free stylists', async () => {
    setRandom(() => 0);
    expect((await eWalkInOk(await newCustomer())).stylist.id).toBe(T.anjali);
  });

  it('the other end of the range picks the other stylist', async () => {
    setRandom(() => 0.99);
    expect((await eWalkInOk(await newCustomer())).stylist.id).toBe(T.farah);
  });

  it('the second customer gets the stylist who is still free', async () => {
    const first = await eWalkInOk(await newCustomer('One'));
    const second = await eWalkInOk(await newCustomer('Two'));
    expect(POOL).toContain(second.stylist.id);
    expect(second.stylist.id).not.toBe(first.stylist.id);
    expect(second.people_ahead).toBe(0);
  });

  it('when every stylist is busy, joins the line with a wait and clients ahead', async () => {
    await busyBoth();
    const e = await eWalkInOk(await newCustomer());
    expect(POOL).toContain(e.stylist.id);
    expect(e.people_ahead).toBe(1); // the person in the chair
    expect(e.wait_minutes).toBe(35); // 30 min service + 5 min buffer
    expect(new Date(e.est_start_at).getTime()).toBeGreaterThan(ctx.clock.now().getTime());
  });

  it('when busy, goes to the stylist who frees up first', async () => {
    await busyBoth(10); // Farah's customer needs 10 more minutes
    const e = await eWalkInOk(await newCustomer());
    expect(e.stylist.id).toBe(T.anjali);
    expect(e.wait_minutes).toBe(35);
  });

  it('counts down as clients ahead are served', async () => {
    const { a, f } = await busyBoth();
    const customer = await newCustomer();
    const e = await eWalkInOk(customer);
    await act(e.stylist.id === T.anjali ? a.id : f.id, 'finish');
    const r = await ctx.app.inject({ method: 'GET', url: `/v1/queue/${e.id}`, headers: auth(customer) });
    expect(r.json().entry).toMatchObject({ people_ahead: 0, e_walk_in: true });
  });

  it('is not affected by the desk-added walk-ins flag', async () => {
    const w = await deskWalkIn('Desk guest', T.anjali);
    expect(w.e_walk_in).toBe(false);
    const d = await dashboard();
    expect(d.entries.find((x: { id: string }) => x.id === w.id).e_walk_in).toBe(false);
  });

  it('a normal app join (no e_walk_in) is still available and not flagged', async () => {
    const r = await ctx.app.inject({
      method: 'POST', url: `/v1/salons/${SLUG}/queue`, headers: auth(await newCustomer()),
      payload: { service_ids: [SERVICE], location: NEAR },
    });
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json().entry.e_walk_in).toBe(false);
  });
});

describe('E Walk-In: a specific stylist', () => {
  it('requests that stylist by name and keeps the E Walk-In flag', async () => {
    const e = await eWalkInOk(await newCustomer(), T.farah);
    expect(e).toMatchObject({ e_walk_in: true, any_stylist: false, requested_stylist_id: T.farah });
    expect(e.stylist.id).toBe(T.farah);
  });

  it('shows the wait and clients ahead for that stylist', async () => {
    await busyBoth();
    await eWalkInOk(await newCustomer('First'), T.farah); // waits behind the chair
    const second = await eWalkInOk(await newCustomer('Second'), T.farah);
    expect(second.stylist.id).toBe(T.farah);
    expect(second.people_ahead).toBe(2);
    expect(second.wait_minutes).toBe(70); // 30 + 5 + 30 + 5
  });

  it('refuses a stylist who does not offer the service', async () => {
    const r = await eWalkIn(await newCustomer(), T.rahul);
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe('STYLIST_DOES_NOT_OFFER');
  });
});

describe('E Walk-In: what the customer sees before joining', () => {
  it('reports free stylists when a chair is free', async () => {
    const c = await cards();
    expect(c.e_walk_in).toMatchObject({ enabled: true, free_now: 2, all_busy: false });
    expect(c.e_walk_in.next_slot).toMatchObject({ wait_minutes: 0, people_ahead: 0 });
    expect(c.stylists.every((s: { e_walk_in_enabled: boolean }) => s.e_walk_in_enabled)).toBe(true);
  });

  it('reports all busy with the countdown target when nobody is free', async () => {
    await busyBoth();
    const c = await cards();
    expect(c.e_walk_in).toMatchObject({ enabled: true, free_now: 0, all_busy: true });
    expect(c.e_walk_in.next_slot).toMatchObject({ wait_minutes: 35, people_ahead: 1 });
    const target = new Date(c.e_walk_in.next_slot.est_start_at).getTime();
    expect(target - ctx.clock.now().getTime()).toBe(35 * 60_000);
  });

  it('the countdown tracks the soonest stylist', async () => {
    await busyBoth(10);
    const c = await cards();
    expect(c.e_walk_in.next_slot.wait_minutes).toBe(35);
  });

  it('is null (not busy, not free) until services are chosen', async () => {
    const r = await ctx.app.inject({ method: 'GET', url: `/v1/salons/${SLUG}/stylists` });
    await expectContract('GET', '/v1/salons/{slug}/stylists', 200, r.json());
    expect(r.json().e_walk_in).toMatchObject({ all_busy: null, next_slot: null, free_now: 0 });
  });
});

describe('E Walk-In: desk controls', () => {
  it('the desk can switch E Walk-In off and on for the whole salon', async () => {
    const off = await patchSettings(desk, { e_walk_in_enabled: false });
    expect(off.statusCode, off.body).toBe(200);
    await expectContract('PATCH', '/v1/dashboard/{slug}/settings', 200, off.json());
    expect(off.json().settings.e_walk_in_enabled).toBe(false);

    const token = await newCustomer();
    const refused = await eWalkIn(token);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe('E_WALK_IN_DISABLED');

    expect((await cards()).e_walk_in.enabled).toBe(false);
    const detail = await ctx.app.inject({ method: 'GET', url: `/v1/salons/${SLUG}` });
    await expectContract('GET', '/v1/salons/{slug}', 200, detail.json());
    expect(detail.json().salon.e_walk_in_enabled).toBe(false);

    expect((await patchSettings(desk, { e_walk_in_enabled: true })).statusCode).toBe(200);
    await eWalkInOk(token);
  });

  it('the owner can switch it too, a stylist cannot', async () => {
    expect((await patchSettings(owner, { e_walk_in_enabled: false })).statusCode).toBe(200);
    expect((await patchSettings(anjali, { e_walk_in_enabled: true })).statusCode).toBe(403);
  });

  it('a receptionist can only change the pause and E Walk-In switches', async () => {
    expect((await patchSettings(desk, { buffer_minutes: 10 })).statusCode).toBe(403);
    expect((await patchSettings(desk, { joins_paused: true, e_walk_in_enabled: false })).statusCode).toBe(200);
  });

  it('turning it off leaves people already in the queue alone', async () => {
    const token = await newCustomer();
    const e = await eWalkInOk(token);
    await patchSettings(desk, { e_walk_in_enabled: false });
    const r = await ctx.app.inject({ method: 'GET', url: `/v1/queue/${e.id}`, headers: auth(token) });
    expect(r.json().entry.status).toBe('waiting');
  });

  it('a pause on joins still applies to E Walk-In', async () => {
    await patchSettings(desk, { joins_paused: true });
    const r = await eWalkIn(await newCustomer());
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe('JOINS_PAUSED');
  });

  it('takes a stylist out of the random pool and out of named requests', async () => {
    const r = await setPool(desk, T.farah, false);
    expect(r.statusCode, r.body).toBe(200);
    await expectContract('PUT', '/v1/dashboard/{slug}/stylists/{stylistId}/e-walk-in', 200, r.json());
    expect(r.json().stylist).toMatchObject({ id: T.farah, e_walk_in_enabled: false });

    // Random picks only Anjali, even with the random number pointing at the end of the range.
    setRandom(() => 0.99);
    const one = await eWalkInOk(await newCustomer('One'));
    const two = await eWalkInOk(await newCustomer('Two'));
    expect([one.stylist.id, two.stylist.id]).toEqual([T.anjali, T.anjali]);
    expect(two.people_ahead).toBe(1);

    const named = await eWalkIn(await newCustomer('Three'), T.farah);
    expect(named.statusCode).toBe(409);
    expect(named.json().error.code).toBe('STYLIST_NOT_E_WALK_IN');

    const c = await cards();
    expect(c.stylists.find((s: { id: string }) => s.id === T.farah).e_walk_in_enabled).toBe(false);
    expect(c.e_walk_in.free_now).toBe(0); // Anjali now has a line; Farah is not counted
  });

  it('the desk can still add a walk-in for a stylist who is out of E Walk-In', async () => {
    await setPool(desk, T.farah, false);
    const w = await deskWalkIn('Desk guest', T.farah);
    expect(w.stylist.id).toBe(T.farah);
  });

  it('customers already in that stylist\'s line stay', async () => {
    const token = await newCustomer();
    const e = await eWalkInOk(token, T.farah);
    await setPool(desk, T.farah, false);
    const r = await ctx.app.inject({ method: 'GET', url: `/v1/queue/${e.id}`, headers: auth(token) });
    expect(r.json().entry).toMatchObject({ status: 'waiting', stylist: { id: T.farah } });
  });

  it('with nobody in the pool a random join is refused', async () => {
    await setPool(desk, T.anjali, false);
    await setPool(desk, T.farah, false);
    const r = await eWalkIn(await newCustomer());
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe('NO_STYLIST_AVAILABLE');
    expect((await cards()).e_walk_in).toMatchObject({ free_now: 0, all_busy: null, next_slot: null });
  });

  it('putting a stylist back brings them into the pool', async () => {
    await setPool(desk, T.farah, false);
    await setPool(desk, T.farah, true);
    setRandom(() => 0.99);
    expect((await eWalkInOk(await newCustomer())).stylist.id).toBe(T.farah);
  });

  it('a stylist can change only their own setting', async () => {
    expect((await setPool(anjali, T.farah, false)).statusCode).toBe(403);
    const own = await setPool(anjali, T.anjali, false);
    expect(own.statusCode, own.body).toBe(200);
    expect(own.json().stylist.e_walk_in_enabled).toBe(false);
  });

  it('rejects an unknown stylist and a bad body', async () => {
    expect((await setPool(desk, '00000000-0000-4000-8000-0000000009ff', false)).statusCode).toBe(404);
    const bad = await ctx.app.inject({
      method: 'PUT', url: `/v1/dashboard/${SLUG}/stylists/${T.farah}/e-walk-in`, headers: auth(desk), payload: { enabled: 'no' },
    });
    expect(bad.statusCode).toBe(400);
  });

  it('shows up on the dashboard board and the stylist admin list, and is logged', async () => {
    await setPool(desk, T.farah, false);
    const d = await dashboard();
    expect(d.stylists.find((s: { id: string }) => s.id === T.farah).e_walk_in_enabled).toBe(false);
    expect(d.stylists.find((s: { id: string }) => s.id === T.anjali).e_walk_in_enabled).toBe(true);
    expect(d.salon.e_walk_in_enabled).toBe(true);

    const admin = await ctx.app.inject({ method: 'GET', url: `/v1/dashboard/${SLUG}/stylists`, headers: auth(owner) });
    await expectContract('GET', '/v1/dashboard/{slug}/stylists', 200, admin.json());
    expect(admin.json().stylists.find((s: { id: string }) => s.id === T.farah).e_walk_in_enabled).toBe(false);

    const { rows } = await ctx.db.query(`SELECT type FROM queue_events WHERE stylist_id = $1 AND type LIKE 'e_walk_in_%'`, [T.farah]);
    expect(rows.map((r) => r.type)).toEqual(['e_walk_in_off']);
  });
});

describe('E Walk-In: desk view and report', () => {
  it('flags E Walk-In customers on the dashboard and counts them in the report', async () => {
    const e = await eWalkInOk(await newCustomer('App customer'));
    await deskWalkIn('Desk guest', T.anjali);
    const d = await dashboard();
    const flagged = d.entries.filter((x: { e_walk_in: boolean }) => x.e_walk_in);
    expect(flagged.map((x: { id: string }) => x.id)).toEqual([e.id]);

    const rep = await ctx.app.inject({ method: 'GET', url: `/v1/dashboard/${SLUG}/reports/accuracy`, headers: auth(desk) });
    expect(rep.statusCode, rep.body).toBe(200);
    await expectContract('GET', '/v1/dashboard/{slug}/reports/accuracy', 200, rep.json());
    expect(rep.json().summary).toMatchObject({ joined: 2, via_app: 1, via_e_walk_in: 1 });
  });

  it('the desk can move an E Walk-In customer to another stylist', async () => {
    const token = await newCustomer();
    const e = await eWalkInOk(token, T.anjali);
    const r = await ctx.app.inject({
      method: 'PATCH', url: `/v1/dashboard/${SLUG}/queue/${e.id}`, headers: auth(desk), payload: { stylist_id: T.farah },
    });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().entry).toMatchObject({ stylist: { id: T.farah }, e_walk_in: true });
  });
});
