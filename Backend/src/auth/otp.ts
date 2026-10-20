import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import type { Config } from '../config.js';
import { type Db, withTx } from '../db.js';
import { AppError, badRequest, tooMany } from '../errors.js';
import type { OtpProvider } from '../messaging/types.js';
import { normalizeIndianMobile } from '../phone.js';

export interface CustomerRow {
  id: string;
  phone: string;
  name: string | null;
}

export class OtpService {
  constructor(
    private readonly db: Db,
    private readonly provider: OtpProvider,
    private readonly cfg: Pick<
      Config,
      'OTP_HMAC_SECRET' | 'OTP_TTL_SECONDS' | 'OTP_MAX_VERIFY_ATTEMPTS' | 'OTP_RESEND_COOLDOWN_SECONDS' | 'OTP_MAX_PER_HOUR'
    >,
    private readonly now: () => Date,
    private readonly opts: { log?: (msg: string) => void; exposeProviderErrors?: boolean; exposeDevCode?: boolean } = {},
  ) {}

  private hash(phone: string, code: string) {
    return createHmac('sha256', this.cfg.OTP_HMAC_SECRET).update(`${phone}:${code}`).digest('hex');
  }

  static phoneOrThrow(raw: string): string {
    const phone = normalizeIndianMobile(raw);
    if (!phone) throw badRequest('INVALID_PHONE', 'Enter a valid 10-digit Indian mobile number');
    return phone;
  }

  async request(rawPhone: string, ip: string | undefined) {
    const phone = OtpService.phoneOrThrow(rawPhone);
    const now = this.now();

    const { rows } = await this.db.query<{ last_at: Date | null; hour_count: number }>(
      `SELECT max(created_at) AS last_at,
              count(*) FILTER (WHERE created_at > $2::timestamptz - interval '1 hour')::int AS hour_count
         FROM otp_challenges WHERE phone = $1`,
      [phone, now],
    );
    const { last_at, hour_count } = rows[0]!;
    if (last_at) {
      const wait = Math.ceil(this.cfg.OTP_RESEND_COOLDOWN_SECONDS - (now.getTime() - last_at.getTime()) / 1000);
      if (wait > 0) throw tooMany('OTP_RESEND_TOO_SOON', `Please wait ${wait}s before requesting another code`, { retry_after_seconds: wait });
    }
    if (hour_count >= this.cfg.OTP_MAX_PER_HOUR) {
      throw tooMany('OTP_TOO_MANY_REQUESTS', 'Too many codes requested for this number. Try again in an hour.');
    }

    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const expiresAt = new Date(now.getTime() + this.cfg.OTP_TTL_SECONDS * 1000);
    let channel: string;
    try {
      ({ channel } = await this.provider.sendOtp(phone, code, { ttlMinutes: Math.round(this.cfg.OTP_TTL_SECONDS / 60) }));
    } catch (err) {
      const reason = (err as Error).message;
      this.opts.log?.(`OTP delivery to ${phone} failed: ${reason}`);
      // Provider details help while setting up locally; customers only see the generic message.
      throw new AppError(
        502,
        'OTP_DELIVERY_FAILED',
        'We could not send the code. Please try again.',
        this.opts.exposeProviderErrors ? { reason } : undefined,
      );
    }
    // Only the newest challenge for a phone is ever valid.
    await withTx(this.db, async (tx) => {
      await tx.query(`UPDATE otp_challenges SET consumed_at = $2 WHERE phone = $1 AND consumed_at IS NULL`, [phone, now]);
      await tx.query(
        `INSERT INTO otp_challenges (phone, code_hash, channel, expires_at, requested_ip, created_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [phone, this.hash(phone, code), channel, expiresAt, ip ?? null, now],
      );
    });
    return {
      phone,
      channel,
      expires_in_seconds: this.cfg.OTP_TTL_SECONDS,
      resend_after_seconds: this.cfg.OTP_RESEND_COOLDOWN_SECONDS,
      // Demo hosting only: when nothing was actually sent (dev provider), hand the code to the website.
      ...(this.opts.exposeDevCode && channel === 'dev' ? { demo_code: code } : {}),
    };
  }

  /** Returns the signed-in customer (created on first sign-in) or throws. */
  async verify(rawPhone: string, code: string): Promise<{ customer: CustomerRow; isNew: boolean }> {
    const phone = OtpService.phoneOrThrow(rawPhone);
    if (!/^\d{6}$/.test(code)) throw badRequest('OTP_INVALID', 'The code is 6 digits');
    const now = this.now();

    // Failed attempts must be committed even though we then reject, so the
    // transaction returns an outcome and we throw after it commits.
    const outcome = await withTx(this.db, async (tx) => {
      const { rows } = await tx.query<{ id: string; code_hash: string; attempts: number; expires_at: Date }>(
        `SELECT id, code_hash, attempts, expires_at FROM otp_challenges
          WHERE phone = $1 AND consumed_at IS NULL
          ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
        [phone],
      );
      const ch = rows[0];
      if (!ch || ch.expires_at <= now) return { kind: 'expired' as const };
      if (ch.attempts >= this.cfg.OTP_MAX_VERIFY_ATTEMPTS) return { kind: 'locked' as const };
      const ok = timingSafeEqual(Buffer.from(ch.code_hash, 'hex'), Buffer.from(this.hash(phone, code), 'hex'));
      if (!ok) {
        await tx.query(`UPDATE otp_challenges SET attempts = attempts + 1 WHERE id = $1`, [ch.id]);
        return { kind: 'wrong' as const, left: this.cfg.OTP_MAX_VERIFY_ATTEMPTS - ch.attempts - 1 };
      }
      await tx.query(`UPDATE otp_challenges SET consumed_at = $2, attempts = attempts + 1 WHERE id = $1`, [ch.id, now]);
      const { rows: c } = await tx.query<CustomerRow & { inserted: boolean }>(
        `INSERT INTO customers (phone, created_at, updated_at, last_login_at) VALUES ($1, $2, $2, $2)
         ON CONFLICT (phone) DO UPDATE SET last_login_at = EXCLUDED.last_login_at
         RETURNING id, phone, name, (xmax = 0) AS inserted`,
        [phone, now],
      );
      const { inserted, ...customer } = c[0]!;
      return { kind: 'ok' as const, customer, isNew: inserted };
    });

    switch (outcome.kind) {
      case 'ok':
        return { customer: outcome.customer, isNew: outcome.isNew };
      case 'expired':
        throw badRequest('OTP_EXPIRED', 'This code has expired. Request a new one.');
      case 'locked':
        throw tooMany('OTP_LOCKED', 'Too many wrong attempts. Request a new code.');
      case 'wrong':
        if (outcome.left <= 0) throw tooMany('OTP_LOCKED', 'Too many wrong attempts. Request a new code.');
        throw badRequest('OTP_INVALID', 'That code is not right', { attempts_left: outcome.left });
    }
  }
}
