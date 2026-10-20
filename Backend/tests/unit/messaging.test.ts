import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { createMessaging } from '../../src/messaging/index.js';
import { DevMessenger } from '../../src/messaging/dev.js';
import { FallbackOtpProvider, type OtpProvider, ProviderError } from '../../src/messaging/types.js';
import { VobizWhatsApp } from '../../src/messaging/vobiz.js';
import { MetaWhatsApp } from '../../src/messaging/meta.js';

const cfg = {
  baseUrl: 'https://api.vobiz.ai/api/v1',
  authId: 'MA_TEST',
  authToken: 'tok',
  channelId: 'chan-1',
  wabaId: '123',
  language: 'en',
  otpTemplate: 'salon_otp',
  turnAlertTemplate: 'turn_near',
  calledTemplate: 'called_in',
};

describe('VobizWhatsApp', () => {
  it('sends the OTP as an authentication template with the copy-code button', async () => {
    const fetchMock = vi.fn(async () => new Response('{"id":"m1","status":"pending"}', { status: 201 }));
    const v = new VobizWhatsApp(cfg, fetchMock as unknown as typeof fetch);
    await expect(v.sendOtp('+919876543210', '123456')).resolves.toEqual({ channel: 'whatsapp' });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.vobiz.ai/api/v1/messaging/messages');
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({ 'X-Auth-ID': 'MA_TEST', 'X-Auth-Token': 'tok' });
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({
      channel_id: 'chan-1',
      waba_id: '123',
      to: '+919876543210',
      type: 'template',
      template: { name: 'salon_otp', language: { code: 'en' } },
    });
    expect(body.template.components).toEqual([
      { type: 'body', parameters: [{ type: 'text', text: '123456' }] },
      { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: '123456' }] },
    ]);
  });

  it('fills the turn-alert template variables in order', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 201 }));
    const v = new VobizWhatsApp(cfg, fetchMock as unknown as typeof fetch);
    await v.sendTurnAlert('+919876543210', { customerName: 'Asha', salonName: 'Demo', stylistName: 'Rahul', minutesUntilStart: 8 });
    const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body.template.name).toBe('turn_near');
    expect(body.template.components[0].parameters.map((p: { text: string }) => p.text)).toEqual(['Asha', 'Demo', 'Rahul', '8']);
  });

  it('marks 5xx and 429 as retryable, 4xx as not', async () => {
    const mk = (status: number) =>
      new VobizWhatsApp(cfg, (async () => new Response('nope', { status })) as unknown as typeof fetch);
    await expect(mk(503).sendOtp('+919876543210', '111111')).rejects.toMatchObject({ retryable: true });
    await expect(mk(429).sendOtp('+919876543210', '111111')).rejects.toMatchObject({ retryable: true });
    await expect(mk(400).sendOtp('+919876543210', '111111')).rejects.toMatchObject({ retryable: false });
  });

  it('wraps network errors', async () => {
    const v = new VobizWhatsApp(cfg, (async () => {
      throw new Error('ECONNRESET');
    }) as unknown as typeof fetch);
    await expect(v.sendOtp('+919876543210', '111111')).rejects.toBeInstanceOf(ProviderError);
  });
});

describe('FallbackOtpProvider', () => {
  it('uses the next provider when the first fails and reports which channel delivered', async () => {
    const broken: OtpProvider = { sendOtp: async () => { throw new ProviderError('whatsapp', 'down', true); } };
    const sms: OtpProvider = { sendOtp: async () => ({ channel: 'sms' }) };
    await expect(new FallbackOtpProvider([broken, sms]).sendOtp('+919876543210', '1', { ttlMinutes: 5 })).resolves.toEqual({ channel: 'sms' });
  });

  it('throws the last error when every provider fails', async () => {
    const broken: OtpProvider = { sendOtp: async () => { throw new Error('x'); } };
    await expect(new FallbackOtpProvider([broken, broken]).sendOtp('+919876543210', '1', { ttlMinutes: 5 })).rejects.toThrow('x');
  });
});

describe('provider wiring', () => {
  const base = {
    DATABASE_URL: 'postgres://x',
    JWT_SECRET: 'x'.repeat(32),
    OTP_HMAC_SECRET: 'y'.repeat(32),
  };

  it('uses the dev messenger by default', () => {
    const m = createMessaging(loadConfig(base));
    expect(m.otp).toBeInstanceOf(DevMessenger);
  });

  it('refuses to select Vobiz without credentials', () => {
    expect(() => createMessaging(loadConfig({ ...base, OTP_PROVIDER: 'vobiz' }))).toThrow(/VOBIZ_AUTH_ID/);
  });

  it('refuses the dev provider in production', () => {
    expect(() => loadConfig({ ...base, NODE_ENV: 'production' })).toThrow(/production/);
  });

  it('allows the dev provider in production only as an explicit demo, with a staff password', () => {
    const prod = { ...base, NODE_ENV: 'production', DEMO_MODE: 'true' };
    expect(() => loadConfig(prod)).toThrow(/SEED_STAFF_PASSWORD/);
    expect(() => loadConfig({ ...prod, SEED_STAFF_PASSWORD: 'short' })).toThrow(/at least 8/);
    expect(loadConfig({ ...prod, SEED_STAFF_PASSWORD: 'a-long-enough-password' }).DEMO_MODE).toBe(true);
  });
});

describe('MetaWhatsApp (Cloud API)', () => {
  const base = { accessToken: 'EAAtoken', phoneNumberId: '1234567890', apiVersion: 'v23.0', language: 'en' };
  const ok = () => vi.fn(async () => new Response('{"messages":[{"id":"wamid.x"}]}', { status: 200 }));
  const sent = (f: ReturnType<typeof ok>) => {
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    return { url, init, body: JSON.parse(init.body as string) };
  };

  it('sends the OTP as plain text when no template is set (test-number mode)', async () => {
    const f = ok();
    const m = new MetaWhatsApp(base, f as unknown as typeof fetch);
    await expect(m.sendOtp('+919876543210', '482913', { ttlMinutes: 5 })).resolves.toEqual({ channel: 'whatsapp' });
    const { url, init, body } = sent(f);
    expect(url).toBe('https://graph.facebook.com/v23.0/1234567890/messages');
    expect(init.headers).toMatchObject({ Authorization: 'Bearer EAAtoken' });
    expect(body).toMatchObject({ messaging_product: 'whatsapp', to: '919876543210', type: 'text' });
    expect(body.text.body).toContain('482913');
    expect(body.text.body).toContain('5 minutes');
  });

  it('uses an authentication template with the copy-code button when configured', async () => {
    const f = ok();
    await new MetaWhatsApp({ ...base, otpTemplate: 'salon_otp' }, f as unknown as typeof fetch).sendOtp('+919876543210', '111222', { ttlMinutes: 5 });
    const { body } = sent(f);
    expect(body.type).toBe('template');
    expect(body.template).toEqual({
      name: 'salon_otp',
      language: { code: 'en' },
      components: [
        { type: 'body', parameters: [{ type: 'text', text: '111222' }] },
        { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: '111222' }] },
      ],
    });
  });

  it('sends turn and called alerts as text or templates', async () => {
    const f1 = ok();
    await new MetaWhatsApp(base, f1 as unknown as typeof fetch).sendCalled('+919876543210', {
      customerName: 'Asha', salonName: 'Demo', stylistName: 'Rahul', graceMinutes: 5,
    });
    expect(sent(f1).body.text.body).toBe('Hi Asha, Rahul at Demo is ready for you. Please come to the chair within 5 minutes.');

    const f2 = ok();
    await new MetaWhatsApp({ ...base, turnAlertTemplate: 'turn_near' }, f2 as unknown as typeof fetch).sendTurnAlert('+919876543210', {
      customerName: null, salonName: 'Demo', stylistName: 'Rahul', minutesUntilStart: 9,
    });
    const b = sent(f2).body;
    expect(b.template.name).toBe('turn_near');
    expect(b.template.components[0].parameters.map((p: { text: string }) => p.text)).toEqual(['there', 'Demo', 'Rahul', '9']);
  });

  it('explains the common setup errors', async () => {
    const fail = (status: number, code: number, message: string) =>
      new MetaWhatsApp(base, (async () =>
        new Response(JSON.stringify({ error: { code, message } }), { status })) as unknown as typeof fetch);
    await expect(fail(400, 131030, 'Recipient phone number not in allowed list').sendOtp('+919876543210', '1', { ttlMinutes: 5 }))
      .rejects.toThrow(/test recipient list/);
    await expect(fail(400, 131047, 'Re-engagement message').sendOtp('+919876543210', '1', { ttlMinutes: 5 }))
      .rejects.toThrow(/last 24 hours/);
    await expect(fail(401, 190, 'Session has expired').sendOtp('+919876543210', '1', { ttlMinutes: 5 }))
      .rejects.toMatchObject({ retryable: false, message: expect.stringMatching(/token has expired/) });
    await expect(fail(503, 2, 'Service unavailable').sendOtp('+919876543210', '1', { ttlMinutes: 5 }))
      .rejects.toMatchObject({ retryable: true });
  });

  it('is selected with OTP_PROVIDER=meta and needs a token and phone number id', () => {
    const env = { DATABASE_URL: 'postgres://x', JWT_SECRET: 'x'.repeat(32), OTP_HMAC_SECRET: 'y'.repeat(32) };
    expect(() => createMessaging(loadConfig({ ...env, OTP_PROVIDER: 'meta' }))).toThrow(/META_WA_ACCESS_TOKEN, META_WA_PHONE_NUMBER_ID/);
    const m = createMessaging(loadConfig({ ...env, OTP_PROVIDER: 'meta', META_WA_ACCESS_TOKEN: 't', META_WA_PHONE_NUMBER_ID: '1' }));
    expect(m.otp).toBeInstanceOf(MetaWhatsApp);
    expect(m.notifier).toBeInstanceOf(DevMessenger);
  });
});
