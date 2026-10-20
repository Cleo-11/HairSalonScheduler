import type { CalledAlert, Notifier, OtpProvider, TurnAlert } from './types.js';
import { ProviderError } from './types.js';

export interface VobizConfig {
  baseUrl: string; // https://api.vobiz.ai/api/v1
  authId: string;
  authToken: string;
  channelId: string;
  wabaId: string;
  language: string;
  otpTemplate: string;
  turnAlertTemplate?: string;
  calledTemplate?: string;
  timeoutMs?: number;
}

type Component = Record<string, unknown>;

/**
 * WhatsApp through Vobiz's messaging API:
 *   POST {baseUrl}/messaging/messages   (X-Auth-ID / X-Auth-Token headers)
 * Every message is a Meta-approved template.
 *
 * Template variables (create these in Meta Business Manager):
 *  - OTP: an *authentication* template. Meta's format takes the code as the
 *    body parameter and again as the copy-code button parameter.
 *  - Turn alert (utility): {{1}} name, {{2}} salon, {{3}} stylist, {{4}} minutes.
 *  - Called (utility):     {{1}} name, {{2}} stylist, {{3}} salon, {{4}} grace minutes.
 *
 * Status: written against Vobiz's public docs; not yet exercised against a
 * live account. Verify the button payload on the first real send.
 */
export class VobizWhatsApp implements OtpProvider, Notifier {
  readonly channel = 'whatsapp';

  constructor(
    private readonly cfg: VobizConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async sendOtp(to: string, code: string) {
    await this.sendTemplate(to, this.cfg.otpTemplate, [
      { type: 'body', parameters: [{ type: 'text', text: code }] },
      { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: code }] },
    ]);
    return { channel: 'whatsapp' };
  }

  async sendTurnAlert(to: string, a: TurnAlert) {
    if (!this.cfg.turnAlertTemplate) throw new ProviderError('vobiz', 'VOBIZ_TURN_ALERT_TEMPLATE not configured', false);
    await this.sendTemplate(to, this.cfg.turnAlertTemplate, [
      { type: 'body', parameters: textParams(a.customerName ?? 'there', a.salonName, a.stylistName, String(a.minutesUntilStart)) },
    ]);
  }

  async sendCalled(to: string, a: CalledAlert) {
    if (!this.cfg.calledTemplate) throw new ProviderError('vobiz', 'VOBIZ_CALLED_TEMPLATE not configured', false);
    await this.sendTemplate(to, this.cfg.calledTemplate, [
      { type: 'body', parameters: textParams(a.customerName ?? 'there', a.stylistName, a.salonName, String(a.graceMinutes)) },
    ]);
  }

  /** Exposed for tests. */
  buildRequest(to: string, template: string, components: Component[]) {
    return {
      url: `${this.cfg.baseUrl.replace(/\/$/, '')}/messaging/messages`,
      init: {
        method: 'POST',
        headers: {
          'X-Auth-ID': this.cfg.authId,
          'X-Auth-Token': this.cfg.authToken,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          channel_id: this.cfg.channelId,
          waba_id: this.cfg.wabaId,
          to,
          type: 'template',
          template: { name: template, language: { code: this.cfg.language }, components },
        }),
      },
    };
  }

  private async sendTemplate(to: string, template: string, components: Component[]) {
    const { url, init } = this.buildRequest(to, template, components);
    let res: Response;
    try {
      res = await this.fetchImpl(url, { ...init, signal: AbortSignal.timeout(this.cfg.timeoutMs ?? 10_000) });
    } catch (err) {
      throw new ProviderError('vobiz', `network error: ${(err as Error).message}`, true);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new ProviderError('vobiz', `HTTP ${res.status} ${body.slice(0, 300)}`, res.status >= 500 || res.status === 429);
    }
  }
}

const textParams = (...values: string[]) => values.map((text) => ({ type: 'text', text }));
