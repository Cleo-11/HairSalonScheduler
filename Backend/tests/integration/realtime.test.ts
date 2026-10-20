import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { createPool, type Db } from '../../src/db.js';
import { DevMessenger } from '../../src/messaging/dev.js';
import { RealtimeHub } from '../../src/realtime.js';
import { seedDemo, DEMO } from '../../src/seed.js';
import { TEST_DATABASE_URL } from '../global-setup.js';
import { auth, expectContract, FakeClock, testConfig } from '../helpers.js';

let db: Db;
let hub: RealtimeHub;
let baseUrl: string;
let close: () => Promise<void>;
let deskToken: string;

beforeAll(async () => {
  db = createPool(TEST_DATABASE_URL);
  await seedDemo(db);
  hub = new RealtimeHub(TEST_DATABASE_URL);
  await hub.start();
  const m = new DevMessenger(() => {});
  const clock = new FakeClock();
  const { app } = await buildApp({ config: testConfig(), db, hub, messaging: { otp: m, notifier: m }, now: clock.now });
  await app.listen({ port: 0, host: '127.0.0.1' });
  baseUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  const login = await fetch(`${baseUrl}/v1/staff/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: DEMO.staff.receptionist.email, password: DEMO.defaultPassword }),
  });
  deskToken = (await login.json()).token;
  close = async () => {
    await app.close();
    await hub.stop();
    await db.end();
  };
});
afterAll(() => close());

/** Read SSE events from a stream until `count` queue events have arrived. */
async function readEvents(res: Response, count: number, timeoutMs = 5000) {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const events: unknown[] = [];
  let buf = '';
  const deadline = Date.now() + timeoutMs;
  while (events.length < count && Date.now() < deadline) {
    const { value, done } = await Promise.race([
      reader.read(),
      new Promise<{ value: undefined; done: true }>((r) => setTimeout(() => r({ value: undefined, done: true }), deadline - Date.now())),
    ]);
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const data = block.split('\n').find((l) => l.startsWith('data: '));
      if (block.includes('event: queue') && data) events.push(JSON.parse(data.slice(6)));
    }
  }
  await reader.cancel();
  return events;
}

describe('live updates', () => {
  it('delivers NOTIFY from a committed queue change to subscribers', async () => {
    const got: string[] = [];
    const unsub = hub.subscribe(DEMO.salon.id, (id) => got.push(id));
    await fetch(`${baseUrl}/v1/dashboard/${DEMO.salon.slug}/walk-ins`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...auth(deskToken) },
      body: JSON.stringify({ name: 'Hub test', service_ids: [DEMO.services.mensCut] }),
    });
    for (let i = 0; i < 50 && got.length === 0; i++) await new Promise((r) => setTimeout(r, 20));
    unsub();
    expect(got).toContain(DEMO.salon.id);
  });

  it('streams a snapshot on connect and another after each change, with no personal data', async () => {
    const res = await fetch(`${baseUrl}/v1/salons/${DEMO.salon.slug}/events`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const eventsPromise = readEvents(res, 2);
    await new Promise((r) => setTimeout(r, 200));
    await fetch(`${baseUrl}/v1/dashboard/${DEMO.salon.slug}/walk-ins`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...auth(deskToken) },
      body: JSON.stringify({ name: 'Secret Name', phone: '9876500000', service_ids: [DEMO.services.mensCut] }),
    });
    const events = await eventsPromise;
    expect(events).toHaveLength(2);
    for (const e of events) await expectContract('GET', '/v1/salons/{slug}/events', 200, e);
    const text = JSON.stringify(events);
    expect(text).not.toContain('Secret Name');
    expect(text).not.toContain('9876500000');
    const total = (e: any) => e.stylists.reduce((a: number, s: { queue_length: number }) => a + s.queue_length, 0);
    expect(total(events[1])).toBe(total(events[0]) + 1);
  });

  it('pushes the desk\'s E Walk-In switch to open screens', async () => {
    const setSwitch = (enabled: boolean) =>
      fetch(`${baseUrl}/v1/dashboard/${DEMO.salon.slug}/settings`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', ...auth(deskToken) },
        body: JSON.stringify({ e_walk_in_enabled: enabled }),
      });
    const res = await fetch(`${baseUrl}/v1/salons/${DEMO.salon.slug}/events`);
    // A late notification from an earlier test can add an extra event, so read a little longer
    // and check the order: the connect snapshot says on, the last one says off.
    const eventsPromise = readEvents(res, 3, 1500);
    await new Promise((r) => setTimeout(r, 200));
    expect((await setSwitch(false)).status).toBe(200);
    const events = (await eventsPromise) as { e_walk_in_enabled: boolean }[];
    expect((await setSwitch(true)).status).toBe(200);
    expect(events.length).toBeGreaterThanOrEqual(2);
    for (const e of events) await expectContract('GET', '/v1/salons/{slug}/events', 200, e);
    expect(events[0]!.e_walk_in_enabled).toBe(true);
    expect(events.at(-1)!.e_walk_in_enabled).toBe(false);
  });

  it('returns 404 for an unknown salon', async () => {
    const res = await fetch(`${baseUrl}/v1/salons/nope/events`);
    expect(res.status).toBe(404);
  });
});
