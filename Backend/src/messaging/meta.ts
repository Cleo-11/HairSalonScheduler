import type { CalledAlert, Notifier, OtpProvider, TurnAlert } from './types.js';
import { ProviderError } from './types.js';

export interface MetaConfig {
  accessToken: string;
  phoneNumberId: string;
  apiVersion: string; // e.g. v23.0
  language: string;
  /** Authentication template. Empty = send the code as plain text. */
  otpTemplate?: string;
  turnAlertTemplate?: string;
  calledTemplate?: string;
  baseUrl?: string; // override for tests
  timeoutMs?: number;
}

type Component = Record<string, unknown>;

/**
 * WhatsApp through Meta's Cloud API directly:
 *   POST https://graph.facebook.com/{version}/{phone-number-id}/messages
 *
 * Two ways to send each message:
 *  - Template (set META_WA_*_TEMPLATE): works any time; needed in production.
 *    Same template variables as the Vobiz adapter.
 *  - Plain text (template not set): only delivered if the recipient has sent
 *    a message to this number in the last 24 hours. That's the easy way to
 *    test locally with Meta's free test number: text it "hi" once a day.
 */
export class MetaWhatsApp implements OtpProvider, Notifier {
  readonly channel = 'whatsapp';

  constructor(
    private readonly cfg: MetaConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async sendOtp(to: string, code: string, opts: { ttlMinutes: number }) {
    if (this.cfg.otpTemplate) {
      await this.send(to, this.template(this.cfg.otpTemplate, [
        { type: 'body', parameters: [{ type: 'text', text: code }] },
        { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: code }] },
      ]));
    } else {
      await this.send(to, this.text(`${code} is your sign-in code. It expires in ${opts.ttlMinutes} minutes. Don't share it with anyone.`));
    }
    return { channel: 'whatsapp' };
  }

  async sendTurnAlert(to: string, a: TurnAlert) {
    const name = a.customerName ?? 'there';
    await this.send(
      to,
      this.cfg.turnAlertTemplate
        ? this.template(this.cfg.turnAlertTemplate, [
            { type: 'body', parameters: textParams(name, a.salonName, a.stylistName, String(a.minutesUntilStart)) },
          ])
        : this.text(`Hi ${name}, your turn at ${a.salonName} with ${a.stylistName} is in about ${a.minutesUntilStart} minutes. Please head back now.`),
    );
  }

  async sendCalled(to: string, a: CalledAlert) {
    const name = a.customerName ?? 'there';
    await this.send(
      to,
      this.cfg.calledTemplate
        ? this.template(this.cfg.calledTemplate, [
            { type: 'body', parameters: textParams(name, a.stylistName, a.salonName, String(a.graceMinutes)) },
          ])
        : this.text(`Hi ${name}, ${a.stylistName} at ${a.salonName} is ready for you. Please come to the chair within ${a.graceMinutes} minutes.`),
    );
  }

  /** Exposed for tests. */
  buildRequest(to: string, message: Record<string, unknown>) {
    const base = (this.cfg.baseUrl ?? 'https://graph.facebook.com').replace(/\/$/, '');
    return {
      url: `${base}/${this.cfg.apiVersion}/${this.cfg.phoneNumberId}/messages`,
      init: {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.cfg.accessToken}`, 'Content-Type': 'application/json' },
        // Meta takes the number without the leading +.
        body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to: to.replace(/^\+/, ''), ...message }),
      },
    };
  }

  private text(body: string) {
    return { type: 'text', text: { preview_url: false, body } };
  }

  private template(name: string, components: Component[]) {
    return { type: 'template', template: { name, language: { code: this.cfg.language }, components } };
  }

  private async send(to: string, message: Record<string, unknown>) {
    const { url, init } = this.buildRequest(to, message);
    let res: Response;
    try {
      res = await this.fetchImpl(url, { ...init, signal: AbortSignal.timeout(this.cfg.timeoutMs ?? 10_000) });
    } catch (err) {
      throw new ProviderError('meta', `network error: ${(err as Error).message}`, true);
    }
    if (!res.ok) {
      const raw = await res.text().catch(() => '');
      let code: number | undefined;
      let msg = raw.slice(0, 300);
      try {
        const e = JSON.parse(raw).error;
        code = e?.code;
        msg = `${e?.message ?? ''}${e?.error_data?.details ? ` (${e.error_data.details})` : ''}`;
      } catch {
        /* not JSON */
      }
      throw new ProviderError('meta', `HTTP ${res.status}${code ? ` code ${code}` : ''}: ${msg}${hint(code)}`, res.status >= 500 || res.status === 429);
    }
  }
}

/** Plain-English next steps for the errors people hit while setting up the test number. */
function hint(code: number | undefined): string {
  switch (code) {
    case 190:
      return ' → The access token has expired. Temporary tokens last about a day; generate a new one in the Meta app (WhatsApp → API Setup) or use a permanent system-user token.';
    case 131030:
      return ' → This number is not on the test recipient list. Add it in the Meta app under WhatsApp → API Setup → "To".';
    case 131047:
      return ' → Plain-text messages need the recipient to have messaged your WhatsApp number in the last 24 hours. Send it any message ("hi") from this phone, or set a template.';
    case 132001:
      return ' → Template not found. Check the template name and language (META_WA_TEMPLATE_LANGUAGE).';
    default:
      return '';
  }
}

const textParams = (...values: string[]) => values.map((text) => ({ type: 'text', text }));
