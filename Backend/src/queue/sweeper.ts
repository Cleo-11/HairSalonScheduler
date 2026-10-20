import type { Db } from '../db.js';
import type { QueueService } from './service.js';

/**
 * Runs every SWEEP_INTERVAL_MS on each app instance. For every salon with
 * people in the queue it applies the no-show grace period and recalculates,
 * which refreshes estimates as time passes, fires time-based turn alerts and
 * pushes an update to open screens. The per-salon advisory lock makes it
 * safe for several instances to sweep at once.
 */
export class Sweeper {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly db: Db,
    private readonly queue: QueueService,
    private readonly intervalMs: number,
    private readonly log: (m: string) => void,
  ) {}

  start() {
    if (this.intervalMs <= 0 || this.timer) return;
    this.timer = setInterval(() => void this.runOnce(), this.intervalMs);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async runOnce() {
    if (this.running) return;
    this.running = true;
    try {
      const { rows } = await this.db.query<{ salon_id: string }>(
        `SELECT DISTINCT salon_id FROM queue_entries WHERE status IN ('waiting', 'called', 'in_service')`,
      );
      for (const { salon_id } of rows) {
        try {
          await this.queue.expireNoShows(salon_id);
        } catch (err) {
          this.log(`sweep failed for salon ${salon_id}: ${(err as Error).message}`);
        }
      }
    } finally {
      this.running = false;
    }
  }
}
