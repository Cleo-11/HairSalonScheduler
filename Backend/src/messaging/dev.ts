import type { CalledAlert, Notifier, OtpProvider, TurnAlert } from './types.js';

export type DevMessage =
  | { kind: 'otp'; to: string; code: string; at: Date }
  | { kind: 'turn_alert'; to: string; alert: TurnAlert; at: Date }
  | { kind: 'called'; to: string; alert: CalledAlert; at: Date };

/**
 * Development provider: prints messages to the log instead of sending them,
 * and keeps an in-memory outbox so tests can read the OTP.
 * Refused in production by loadConfig().
 */
export class DevMessenger implements OtpProvider, Notifier {
  readonly channel = 'dev';
  readonly outbox: DevMessage[] = [];

  constructor(private readonly log: (msg: string) => void = (m) => console.log(m)) {}

  async sendOtp(to: string, code: string, opts: { ttlMinutes: number }) {
    this.outbox.push({ kind: 'otp', to, code, at: new Date() });
    this.log(`[dev-otp] ${to}: your code is ${code} (valid ${opts.ttlMinutes} min)`);
    return { channel: 'dev' };
  }

  async sendTurnAlert(to: string, alert: TurnAlert) {
    this.outbox.push({ kind: 'turn_alert', to, alert, at: new Date() });
    this.log(`[dev-whatsapp] ${to}: your turn with ${alert.stylistName} is in about ${alert.minutesUntilStart} min`);
  }

  async sendCalled(to: string, alert: CalledAlert) {
    this.outbox.push({ kind: 'called', to, alert, at: new Date() });
    this.log(`[dev-whatsapp] ${to}: ${alert.stylistName} is ready for you, please come in within ${alert.graceMinutes} min`);
  }

  lastOtp(to: string): string | undefined {
    for (let i = this.outbox.length - 1; i >= 0; i--) {
      const m = this.outbox[i]!;
      if (m.kind === 'otp' && m.to === to) return m.code;
    }
    return undefined;
  }
}
