/**
 * Provider layer for everything that leaves the building as a message.
 * Sign-in only ever talks to OtpProvider and the queue only talks to
 * Notifier, so WhatsApp (Vobiz) can be joined by SMS (e.g. MSG91) or a
 * voice fallback without touching auth or queue code.
 */

export interface OtpProvider {
  /** Resolves with the channel that delivered it ('dev', 'whatsapp', 'sms', ...), stored on the challenge row. */
  sendOtp(toE164: string, code: string, opts: { ttlMinutes: number }): Promise<{ channel: string }>;
}

export interface TurnAlert {
  customerName: string | null;
  salonName: string;
  stylistName: string;
  minutesUntilStart: number;
}

export interface CalledAlert {
  customerName: string | null;
  salonName: string;
  stylistName: string;
  graceMinutes: number;
}

export interface Notifier {
  readonly channel: string;
  sendTurnAlert(toE164: string, alert: TurnAlert): Promise<void>;
  sendCalled(toE164: string, alert: CalledAlert): Promise<void>;
}

export class ProviderError extends Error {
  constructor(
    public readonly provider: string,
    message: string,
    public readonly retryable: boolean,
  ) {
    super(`${provider}: ${message}`);
  }
}

/** Try providers in order, e.g. WhatsApp first, then SMS. Records which one delivered. */
export class FallbackOtpProvider implements OtpProvider {
  constructor(private readonly providers: OtpProvider[]) {
    if (providers.length === 0) throw new Error('FallbackOtpProvider needs at least one provider');
  }
  async sendOtp(to: string, code: string, opts: { ttlMinutes: number }) {
    let lastErr: unknown;
    for (const p of this.providers) {
      try {
        return await p.sendOtp(to, code, opts);
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr;
  }
}
