import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().default(3000),
  HOST: z.string().default('0.0.0.0'),
  DATABASE_URL: z.string().min(1),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  OTP_HMAC_SECRET: z.string().min(32, 'OTP_HMAC_SECRET must be at least 32 characters'),
  CORS_ORIGINS: z.string().default('*'),
  // 'dev' prints codes to the log; 'meta' sends WhatsApp through Meta's Cloud API
  // directly (free test number for local testing); 'vobiz' sends WhatsApp through Vobiz.
  OTP_PROVIDER: z.enum(['dev', 'meta', 'vobiz']).default('dev'),
  NOTIFY_PROVIDER: z.enum(['dev', 'meta', 'vobiz']).default('dev'),
  // Demo hosting without WhatsApp: lets the dev providers run in production, returns the sign-in
  // code in the API response so the website can show it, and seeds the demo salon on first boot.
  // Anyone can then sign in as any phone number, so never use this with real customers.
  DEMO_MODE: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  // Password for the demo staff logins when seeding on boot (required in DEMO_MODE).
  SEED_STAFF_PASSWORD: z.string().min(8, 'SEED_STAFF_PASSWORD must be at least 8 characters').optional(),
  META_WA_ACCESS_TOKEN: z.string().optional(),
  META_WA_PHONE_NUMBER_ID: z.string().optional(),
  META_WA_API_VERSION: z.string().default('v23.0'),
  META_WA_TEMPLATE_LANGUAGE: z.string().default('en'),
  // Leave the template names empty to send plain text instead (works on the free test
  // number once the recipient has messaged it within the last 24 hours).
  META_WA_OTP_TEMPLATE: z.string().optional(),
  META_WA_TURN_ALERT_TEMPLATE: z.string().optional(),
  META_WA_CALLED_TEMPLATE: z.string().optional(),
  VOBIZ_API_BASE_URL: z.string().default('https://api.vobiz.ai/api/v1'),
  VOBIZ_AUTH_ID: z.string().optional(),
  VOBIZ_AUTH_TOKEN: z.string().optional(),
  VOBIZ_CHANNEL_ID: z.string().optional(),
  VOBIZ_WABA_ID: z.string().optional(),
  VOBIZ_TEMPLATE_LANGUAGE: z.string().default('en'),
  VOBIZ_OTP_TEMPLATE: z.string().optional(),
  VOBIZ_TURN_ALERT_TEMPLATE: z.string().optional(),
  VOBIZ_CALLED_TEMPLATE: z.string().optional(),
  OTP_TTL_SECONDS: z.coerce.number().int().default(300),
  OTP_MAX_VERIFY_ATTEMPTS: z.coerce.number().int().default(5),
  OTP_RESEND_COOLDOWN_SECONDS: z.coerce.number().int().default(30),
  OTP_MAX_PER_HOUR: z.coerce.number().int().default(5),
  CUSTOMER_TOKEN_TTL: z.string().default('30d'),
  STAFF_TOKEN_TTL: z.string().default('12h'),
  MAX_ACTIVE_ENTRIES_PER_CUSTOMER: z.coerce.number().int().default(1),
  RATE_LIMIT_ENABLED: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),
  // How often the background sweeper checks no-show grace periods and turn alerts.
  SWEEP_INTERVAL_MS: z.coerce.number().int().default(30_000),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid configuration:\n${msg}`);
  }
  const cfg = parsed.data;
  if (cfg.NODE_ENV === 'production' && !cfg.DEMO_MODE && (cfg.OTP_PROVIDER === 'dev' || cfg.NOTIFY_PROVIDER === 'dev')) {
    throw new Error(
      'The dev OTP/notification provider prints codes to the log and must not run in production. ' +
        'For a public demo without WhatsApp, set DEMO_MODE=true.',
    );
  }
  if (cfg.DEMO_MODE && cfg.NODE_ENV === 'production' && !cfg.SEED_STAFF_PASSWORD) {
    throw new Error('DEMO_MODE in production needs SEED_STAFF_PASSWORD (the password for the demo staff logins).');
  }
  return cfg;
}
