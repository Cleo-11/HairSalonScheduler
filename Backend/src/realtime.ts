import pg from 'pg';

type Listener = (salonId: string) => void;

const CHANNEL = 'salon_events';

/**
 * Fan-out of "salon X changed" signals.
 * Writers call notifyInTx() inside their transaction; Postgres delivers the
 * NOTIFY only on commit, to every app instance LISTENing. Each instance then
 * pushes to its own SSE subscribers. No extra infrastructure needed.
 */
export class RealtimeHub {
  private listeners = new Map<string, Set<Listener>>();
  private client: pg.Client | null = null;

  constructor(private readonly connectionString: string, private readonly log: (m: string) => void = () => {}) {}

  async start() {
    this.client = new pg.Client({ connectionString: this.connectionString });
    this.client.on('notification', (msg) => {
      if (msg.channel === CHANNEL && msg.payload) this.dispatch(msg.payload);
    });
    this.client.on('error', (err) => this.log(`realtime listener error: ${err.message}`));
    await this.client.connect();
    await this.client.query(`LISTEN ${CHANNEL}`);
  }

  async stop() {
    await this.client?.end().catch(() => {});
    this.client = null;
  }

  static async notifyInTx(q: pg.ClientBase | pg.Pool, salonId: string) {
    await q.query(`SELECT pg_notify($1, $2)`, [CHANNEL, salonId]);
  }

  subscribe(salonId: string, fn: Listener): () => void {
    let set = this.listeners.get(salonId);
    if (!set) this.listeners.set(salonId, (set = new Set()));
    set.add(fn);
    return () => {
      set!.delete(fn);
      if (set!.size === 0) this.listeners.delete(salonId);
    };
  }

  subscriberCount(salonId: string) {
    return this.listeners.get(salonId)?.size ?? 0;
  }

  private dispatch(salonId: string) {
    for (const fn of this.listeners.get(salonId) ?? []) {
      try {
        fn(salonId);
      } catch (err) {
        this.log(`realtime subscriber error: ${(err as Error).message}`);
      }
    }
  }
}
