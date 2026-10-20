import type { Config } from '../config.js';
import { DevMessenger } from './dev.js';
import { MetaWhatsApp } from './meta.js';
import type { Notifier, OtpProvider } from './types.js';
import { VobizWhatsApp } from './vobiz.js';

export interface Messaging {
  otp: OtpProvider;
  notifier: Notifier;
}

function requireSettings(provider: string, required: Record<string, string | undefined>) {
  const missing = Object.entries(required).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) throw new Error(`${provider} provider selected but not configured: ${missing.join(', ')}`);
}

function vobizFromConfig(cfg: Config): VobizWhatsApp {
  requireSettings('Vobiz', {
    VOBIZ_AUTH_ID: cfg.VOBIZ_AUTH_ID,
    VOBIZ_AUTH_TOKEN: cfg.VOBIZ_AUTH_TOKEN,
    VOBIZ_CHANNEL_ID: cfg.VOBIZ_CHANNEL_ID,
    VOBIZ_WABA_ID: cfg.VOBIZ_WABA_ID,
    VOBIZ_OTP_TEMPLATE: cfg.VOBIZ_OTP_TEMPLATE,
  });
  return new VobizWhatsApp({
    baseUrl: cfg.VOBIZ_API_BASE_URL,
    authId: cfg.VOBIZ_AUTH_ID!,
    authToken: cfg.VOBIZ_AUTH_TOKEN!,
    channelId: cfg.VOBIZ_CHANNEL_ID!,
    wabaId: cfg.VOBIZ_WABA_ID!,
    language: cfg.VOBIZ_TEMPLATE_LANGUAGE,
    otpTemplate: cfg.VOBIZ_OTP_TEMPLATE!,
    turnAlertTemplate: cfg.VOBIZ_TURN_ALERT_TEMPLATE,
    calledTemplate: cfg.VOBIZ_CALLED_TEMPLATE,
  });
}

function metaFromConfig(cfg: Config): MetaWhatsApp {
  requireSettings('Meta WhatsApp', {
    META_WA_ACCESS_TOKEN: cfg.META_WA_ACCESS_TOKEN,
    META_WA_PHONE_NUMBER_ID: cfg.META_WA_PHONE_NUMBER_ID,
  });
  return new MetaWhatsApp({
    accessToken: cfg.META_WA_ACCESS_TOKEN!,
    phoneNumberId: cfg.META_WA_PHONE_NUMBER_ID!,
    apiVersion: cfg.META_WA_API_VERSION,
    language: cfg.META_WA_TEMPLATE_LANGUAGE,
    otpTemplate: cfg.META_WA_OTP_TEMPLATE || undefined,
    turnAlertTemplate: cfg.META_WA_TURN_ALERT_TEMPLATE || undefined,
    calledTemplate: cfg.META_WA_CALLED_TEMPLATE || undefined,
  });
}

/** Wire providers from config. To add SMS later: build it here and wrap with FallbackOtpProvider. */
export function createMessaging(cfg: Config, dev: DevMessenger = new DevMessenger()): Messaging {
  const uses = (p: string) => cfg.OTP_PROVIDER === p || cfg.NOTIFY_PROVIDER === p;
  const providers: Record<string, OtpProvider & Notifier> = { dev };
  if (uses('vobiz')) providers.vobiz = vobizFromConfig(cfg);
  if (uses('meta')) providers.meta = metaFromConfig(cfg);
  return { otp: providers[cfg.OTP_PROVIDER]!, notifier: providers[cfg.NOTIFY_PROVIDER]! };
}

export { DevMessenger } from './dev.js';
export * from './types.js';
