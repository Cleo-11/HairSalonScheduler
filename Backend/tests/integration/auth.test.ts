import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeApp, nextPhone, signInCustomer, signInStaff, auth, expectContract, DEMO, type TestCtx } from '../helpers.js';

let ctx: TestCtx;
beforeAll(async () => {
  ctx = await makeApp();
});
afterAll(() => ctx.close());

const request = (phone: string) => ctx.app.inject({ method: 'POST', url: '/v1/auth/otp/request', payload: { phone } });
const verify = (phone: string, code: string) =>
  ctx.app.inject({ method: 'POST', url: '/v1/auth/otp/verify', payload: { phone, code } });

describe('customer OTP sign-in', () => {
  it('sends a code, verifies it, creates the customer and asks for a name once', async () => {
    const phone = nextPhone();
    const r1 = await request(phone.replace('+91', '').replace(/(\d{5})/, '$1 '));
    expect(r1.statusCode).toBe(200);
    await expectContract('POST', '/v1/auth/otp/request', 200, r1.json());
    expect(r1.json()).toMatchObject({ phone, channel: 'dev', expires_in_seconds: 300 });

    const code = ctx.messenger.lastOtp(phone)!;
    expect(code).toMatch(/^\d{6}$/);
    const r2 = await verify(phone, code);
    expect(r2.statusCode).toBe(200);
    await expectContract('POST', '/v1/auth/otp/verify', 200, r2.json());
    expect(r2.json()).toMatchObject({ is_new: true, customer: { phone, name: null, needs_name: true } });

    const token = r2.json().token;
    const me = await ctx.app.inject({ method: 'PATCH', url: '/v1/me', headers: auth(token), payload: { name: '  Asha  ' } });
    expect(me.json().customer).toMatchObject({ name: 'Asha', needs_name: false });
    await expectContract('PATCH', '/v1/me', 200, me.json());

    // Returning user: not new, name kept.
    ctx.clock.advance(1);
    await request(phone);
    const again = await verify(phone, ctx.messenger.lastOtp(phone)!);
    expect(again.json()).toMatchObject({ is_new: false, customer: { name: 'Asha', needs_name: false } });
  });

  it('stores only a hash of the code', async () => {
    const phone = nextPhone();
    await request(phone);
    const code = ctx.messenger.lastOtp(phone)!;
    const { rows } = await ctx.db.query(`SELECT code_hash FROM otp_challenges WHERE phone = $1`, [phone]);
    expect(rows[0].code_hash).not.toContain(code);
    expect(rows[0].code_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('counts wrong attempts and locks after five', async () => {
    const phone = nextPhone();
    await request(phone);
    const good = ctx.messenger.lastOtp(phone)!;
    const bad = good === '000000' ? '111111' : '000000';
    for (let left = 4; left >= 1; left--) {
      const r = await verify(phone, bad);
      expect(r.statusCode).toBe(400);
      expect(r.json().error).toMatchObject({ code: 'OTP_INVALID', details: { attempts_left: left } });
    }
    expect((await verify(phone, bad)).json().error.code).toBe('OTP_LOCKED');
    const locked = await verify(phone, good);
    expect(locked.statusCode).toBe(429);
    expect(locked.json().error.code).toBe('OTP_LOCKED');
  });

  it('expires codes', async () => {
    const phone = nextPhone();
    await request(phone);
    ctx.clock.advance(6);
    const r = await verify(phone, ctx.messenger.lastOtp(phone)!);
    expect(r.json().error.code).toBe('OTP_EXPIRED');
  });

  it('only the newest code works, and a code works once', async () => {
    const phone = nextPhone();
    await request(phone);
    const first = ctx.messenger.lastOtp(phone)!;
    ctx.clock.advance(1);
    await request(phone);
    const second = ctx.messenger.lastOtp(phone)!;
    if (first !== second) expect((await verify(phone, first)).statusCode).toBe(400);
    expect((await verify(phone, second)).statusCode).toBe(200);
    expect((await verify(phone, second)).json().error.code).toBe('OTP_EXPIRED');
  });

  it('enforces the resend cooldown and hourly cap', async () => {
    const phone = nextPhone();
    await request(phone);
    const soon = await request(phone);
    expect(soon.statusCode).toBe(429);
    expect(soon.json().error).toMatchObject({ code: 'OTP_RESEND_TOO_SOON', details: { retry_after_seconds: 30 } });
    for (let i = 0; i < 4; i++) {
      ctx.clock.advance(1);
      expect((await request(phone)).statusCode).toBe(200);
    }
    ctx.clock.advance(1);
    expect((await request(phone)).json().error.code).toBe('OTP_TOO_MANY_REQUESTS');
    ctx.clock.advance(60);
    expect((await request(phone)).statusCode).toBe(200);
  });

  it('rejects invalid numbers', async () => {
    const r = await request('12345');
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe('INVALID_PHONE');
    await expectContract('POST', '/v1/auth/otp/request', 400, r.json());
  });

  it('reports delivery failure without leaving a usable challenge', async () => {
    const original = ctx.messenger.sendOtp.bind(ctx.messenger);
    ctx.messenger.sendOtp = async () => {
      throw new Error('whatsapp down');
    };
    const phone = nextPhone();
    const r = await request(phone);
    ctx.messenger.sendOtp = original;
    expect(r.statusCode).toBe(502);
    expect(r.json().error).toMatchObject({ code: 'OTP_DELIVERY_FAILED', details: { reason: 'whatsapp down' } });
    const { rows } = await ctx.db.query(`SELECT 1 FROM otp_challenges WHERE phone = $1`, [phone]);
    expect(rows).toHaveLength(0);
  });

  it('protects /v1/me', async () => {
    expect((await ctx.app.inject({ method: 'GET', url: '/v1/me' })).statusCode).toBe(401);
    const staffToken = await signInStaff(ctx, DEMO.staff.owner.email);
    expect((await ctx.app.inject({ method: 'GET', url: '/v1/me', headers: auth(staffToken) })).statusCode).toBe(401);
    const { token } = await signInCustomer(ctx);
    const r = await ctx.app.inject({ method: 'GET', url: '/v1/me', headers: auth(token) });
    await expectContract('GET', '/v1/me', 200, r.json());
  });
});

describe('demo mode: sign-in code shown on the page', () => {
  it('is never in the response by default', async () => {
    const r = await request(nextPhone());
    expect(r.statusCode).toBe(200);
    expect(r.json()).not.toHaveProperty('demo_code');
  });

  it('returns the code that was just issued when DEMO_MODE is on, and it signs in', async () => {
    const demo = await makeApp({ config: { DEMO_MODE: 'true' }, seed: false });
    try {
      const phone = nextPhone();
      const r = await demo.app.inject({ method: 'POST', url: '/v1/auth/otp/request', payload: { phone } });
      expect(r.statusCode).toBe(200);
      await expectContract('POST', '/v1/auth/otp/request', 200, r.json());
      expect(r.json().demo_code).toBe(demo.messenger.lastOtp(phone));
      const v = await demo.app.inject({ method: 'POST', url: '/v1/auth/otp/verify', payload: { phone, code: r.json().demo_code } });
      expect(v.statusCode).toBe(200);
    } finally {
      await demo.close();
    }
  });

  it('never returns a code that a real provider sent', async () => {
    const demo = await makeApp({ config: { DEMO_MODE: 'true' }, seed: false });
    try {
      const real = Object.assign(Object.create(demo.messenger), {
        sendOtp: async () => ({ channel: 'whatsapp' }),
      });
      const { OtpService } = await import('../../src/auth/otp.js');
      const svc = new OtpService(demo.db, real, demo.deps.config, demo.clock.now, { exposeDevCode: true });
      expect(await svc.request(nextPhone(), undefined)).not.toHaveProperty('demo_code');
    } finally {
      await demo.close();
    }
  });
});

describe('staff login', () => {
  it('returns a token and memberships', async () => {
    const r = await ctx.app.inject({
      method: 'POST',
      url: '/v1/staff/auth/login',
      payload: { email: 'Anjali@Demo-Salon.test', password: DEMO.defaultPassword },
    });
    expect(r.statusCode).toBe(200);
    await expectContract('POST', '/v1/staff/auth/login', 200, r.json());
    expect(r.json().memberships).toEqual([
      expect.objectContaining({ salon_slug: DEMO.salon.slug, role: 'stylist', stylist_id: DEMO.stylists.anjali }),
    ]);
    const me = await ctx.app.inject({ method: 'GET', url: '/v1/staff/me', headers: auth(r.json().token) });
    await expectContract('GET', '/v1/staff/me', 200, me.json());
  });

  it('gives the same error for a wrong password and an unknown email', async () => {
    const a = await ctx.app.inject({ method: 'POST', url: '/v1/staff/auth/login', payload: { email: DEMO.staff.owner.email, password: 'nope' } });
    const b = await ctx.app.inject({ method: 'POST', url: '/v1/staff/auth/login', payload: { email: 'ghost@x.test', password: 'nope' } });
    expect(a.statusCode).toBe(401);
    expect(a.json()).toEqual(b.json());
  });

  it('a customer token cannot open the dashboard', async () => {
    const { token } = await signInCustomer(ctx);
    const r = await ctx.app.inject({ method: 'GET', url: `/v1/dashboard/${DEMO.salon.slug}`, headers: auth(token) });
    expect(r.statusCode).toBe(401);
  });
});

describe('CORS', () => {
  it.each(['PATCH', 'PUT', 'DELETE'])('allows %s from the website', async (method) => {
    const r = await ctx.app.inject({
      method: 'OPTIONS',
      url: '/v1/me',
      headers: { origin: 'http://localhost:3001', 'access-control-request-method': method, 'access-control-request-headers': 'authorization,content-type' },
    });
    expect(r.statusCode).toBe(204);
    expect(String(r.headers['access-control-allow-methods'])).toContain(method);
  });
});

describe('rate limiting', () => {
  it('limits OTP requests per IP when enabled', async () => {
    const limited = await makeApp({ config: { RATE_LIMIT_ENABLED: 'true' }, seed: false });
    try {
      const codes: number[] = [];
      for (let i = 0; i < 11; i++) {
        const r = await limited.app.inject({ method: 'POST', url: '/v1/auth/otp/request', payload: { phone: '12' } });
        codes.push(r.statusCode);
      }
      expect(codes.slice(0, 10).every((c) => c === 400)).toBe(true);
      expect(codes[10]).toBe(429);
    } finally {
      await limited.close();
    }
  });
});
