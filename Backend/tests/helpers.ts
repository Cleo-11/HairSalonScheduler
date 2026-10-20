import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import SwaggerParser from '@apidevtools/swagger-parser';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import type { FastifyInstance } from 'fastify';
import { expect } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { buildApp, type Deps } from '../src/app.js';
import { type Config, loadConfig } from '../src/config.js';
import { createPool, type Db } from '../src/db.js';
import { DevMessenger } from '../src/messaging/dev.js';
import { DEMO, seedDemo } from '../src/seed.js';
import { TEST_DATABASE_URL } from './global-setup.js';

export { DEMO };

/** A controllable clock. Starts Tuesday 29 Sep 2026, 12:00 IST (salon open 10:00-21:00). */
export class FakeClock {
  t: number;
  constructor(iso = '2026-09-29T06:30:00Z') {
    this.t = Date.parse(iso);
  }
  now = () => new Date(this.t);
  advance(minutes: number) {
    this.t += minutes * 60_000;
  }
  set(iso: string) {
    this.t = Date.parse(iso);
  }
}

export function testConfig(overrides: Record<string, string> = {}): Config {
  return loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: TEST_DATABASE_URL,
    JWT_SECRET: 'test-jwt-secret-0123456789abcdef0123456789',
    OTP_HMAC_SECRET: 'test-otp-secret-0123456789abcdef0123456789',
    RATE_LIMIT_ENABLED: 'false',
    ...overrides,
  });
}

export interface TestCtx {
  app: FastifyInstance;
  deps: Deps;
  db: Db;
  clock: FakeClock;
  messenger: DevMessenger;
  close: () => Promise<void>;
}

export async function makeApp(opts: { config?: Record<string, string>; seed?: boolean } = {}): Promise<TestCtx> {
  const db = createPool(TEST_DATABASE_URL);
  if (opts.seed !== false) await seedDemo(db);
  const clock = new FakeClock();
  const messenger = new DevMessenger(() => {});
  const { app, deps } = await buildApp({
    config: testConfig(opts.config),
    db,
    messaging: { otp: messenger, notifier: messenger },
    now: clock.now,
  });
  await app.ready();
  return {
    app, deps, db, clock, messenger,
    close: async () => {
      await app.close();
      await db.end();
    },
  };
}

let phoneCounter = 0;
/** A unique, valid Indian mobile number per call. */
export function nextPhone(): string {
  phoneCounter++;
  return `+9198${String(Date.now() % 1_000_000).padStart(6, '0').slice(0, 4)}${String(phoneCounter).padStart(4, '0')}`;
}

/** Sign a customer in via OTP (and set a name unless name === null). */
export async function signInCustomer(ctx: TestCtx, name: string | null = 'Test Customer', phone = nextPhone()) {
  const r1 = await ctx.app.inject({ method: 'POST', url: '/v1/auth/otp/request', payload: { phone } });
  expect(r1.statusCode, r1.body).toBe(200);
  const code = ctx.messenger.lastOtp(phone)!;
  const r2 = await ctx.app.inject({ method: 'POST', url: '/v1/auth/otp/verify', payload: { phone, code } });
  expect(r2.statusCode, r2.body).toBe(200);
  const { token, customer } = r2.json();
  if (name) {
    const r3 = await ctx.app.inject({ method: 'PATCH', url: '/v1/me', headers: auth(token), payload: { name } });
    expect(r3.statusCode, r3.body).toBe(200);
  }
  return { token, customerId: customer.id as string, phone };
}

export async function signInStaff(ctx: TestCtx, email: string, password: string = DEMO.defaultPassword) {
  const r = await ctx.app.inject({ method: 'POST', url: '/v1/staff/auth/login', payload: { email, password } });
  expect(r.statusCode, r.body).toBe(200);
  return r.json().token as string;
}

export const auth = (token: string) => ({ authorization: `Bearer ${token}` });

// ------------------------------------------------------------------ contract checks

const specPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../openapi.yaml');
export const rawSpec = parseYaml(readFileSync(specPath, 'utf8'));
let ajvPromise: Promise<{ ajv: Ajv2020; spec: any }> | null = null;

async function ajvWithSpec() {
  ajvPromise ??= (async () => {
    const spec: any = await SwaggerParser.dereference(structuredClone(rawSpec));
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    (addFormats as unknown as (a: Ajv2020) => void)(ajv);
    return { ajv, spec };
  })();
  return ajvPromise;
}

/**
 * Assert a response body matches the OpenAPI response schema for that
 * operation and status. Keeps the spec honest for the frontend.
 */
export async function expectContract(method: string, specPathKey: string, status: number, body: unknown) {
  const { ajv, spec } = await ajvWithSpec();
  const op = spec.paths[specPathKey]?.[method.toLowerCase()];
  if (!op) throw new Error(`No ${method} ${specPathKey} in openapi.yaml`);
  const res = op.responses[String(status)];
  if (!res) throw new Error(`No ${status} response for ${method} ${specPathKey} in openapi.yaml`);
  const schema = res.content?.['application/json']?.schema ?? res.content?.['text/event-stream']?.schema;
  const validate = ajv.compile(schema);
  const ok = validate(body);
  if (!ok) {
    throw new Error(
      `${method} ${specPathKey} ${status} does not match openapi.yaml:\n${JSON.stringify(validate.errors, null, 2)}\nbody: ${JSON.stringify(body, null, 2).slice(0, 2000)}`,
    );
  }
}

export async function expectSchema(schemaName: string, body: unknown) {
  const { ajv, spec } = await ajvWithSpec();
  const validate = ajv.compile(spec.components.schemas[schemaName]);
  if (!validate(body)) throw new Error(`${schemaName} mismatch: ${JSON.stringify(validate.errors, null, 2)}`);
}
