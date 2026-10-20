import type { DatabaseError } from 'pg';
import { type Db, type Tx, lockSalon, withTx } from '../db.js';
import { AppError, badRequest, conflict, forbidden, notFound } from '../errors.js';
import type { Notifier } from '../messaging/types.js';
import { RealtimeHub } from '../realtime.js';
import { type SalonRow, salonById } from '../salons/repo.js';
import { type StylistStatus, minutesBetween, minutesFor, pickAnyAvailable, pickRandomAvailable, quoteAll } from './estimator.js';
import { type SalonState, engineContext, loadSalonState } from './state.js';

export type Effect =
  | { kind: 'turn_alert'; to: string; customerName: string | null; salonName: string; stylistName: string; minutes: number }
  | { kind: 'called'; to: string; customerName: string | null; salonName: string; stylistName: string; grace: number };

export interface StaffActor {
  salon: SalonRow;
  staffUserId: string;
  role: 'owner' | 'receptionist' | 'stylist';
  stylistId: string | null;
}

export type EntryAction = 'call' | 'start' | 'finish' | 'no_show' | 'requeue' | 'cancel';

const ACTIVE = `('waiting', 'called', 'in_service')`;

const UNIQUE_CONFLICTS: Record<string, [string, string]> = {
  queue_entries_one_in_service: ['STYLIST_BUSY', 'This stylist is already serving someone. Finish that service first.'],
  queue_entries_one_called: ['STYLIST_ALREADY_CALLING', 'This stylist has already called a customer.'],
  queue_entries_one_active_per_customer: ['ALREADY_IN_QUEUE', 'You are already in the queue at this salon.'],
};

export interface JoinInput {
  salon: SalonRow;
  serviceIds: string[];
  stylistId: string | null;
  source: 'app' | 'walk_in';
  /**
   * E Walk-In join from the app. With no `stylistId` a stylist is picked at random from
   * those taking part in E Walk-In; with one, that stylist is requested by name.
   */
  eWalkIn?: boolean;
  customerId: string | null;
  guestName?: string | null;
  guestPhone?: string | null;
  location?: { lat: number; lng: number } | null;
  actor: string;
}

export class QueueService {
  constructor(
    private readonly db: Db,
    private readonly notifier: Notifier,
    private readonly now: () => Date,
    private readonly opts: { maxActivePerCustomer: number; log: (msg: string) => void; random?: () => number },
  ) {}

  /**
   * Every queue change goes through here: one transaction, holding the
   * salon's advisory lock, then a full recalculation of estimates, a
   * realtime NOTIFY (delivered on commit), and messages sent after commit.
   */
  async mutate<T>(salonId: string, fn: (tx: Tx, now: Date, salon: SalonRow, effects: Effect[]) => Promise<T>) {
    const effects: Effect[] = [];
    let out: { result: T; state: SalonState };
    try {
      out = await withTx(this.db, async (tx) => {
        await lockSalon(tx, salonId);
        const now = this.now();
        const salon = await salonById(tx, salonId);
        const result = await fn(tx, now, salon, effects);
        const state = await this.recalc(tx, await salonById(tx, salonId), now, effects);
        await RealtimeHub.notifyInTx(tx, salonId);
        return { result, state };
      });
    } catch (err) {
      const pgErr = err as DatabaseError;
      if (pgErr.code === '23505' && pgErr.constraint && UNIQUE_CONFLICTS[pgErr.constraint]) {
        const [code, msg] = UNIQUE_CONFLICTS[pgErr.constraint]!;
        throw conflict(code, msg);
      }
      throw err;
    }
    await this.runEffects(effects);
    return out;
  }

  /** Recompute every estimate in the salon, persist it, and queue turn-near alerts. */
  async recalc(tx: Tx, salon: SalonRow, now: Date, effects: Effect[]): Promise<SalonState> {
    const state = await loadSalonState(tx, salon, now);
    const ids: string[] = [];
    const ests: Date[] = [];
    for (const [id, est] of state.estimates) {
      ids.push(id);
      ests.push(est.startAt);
    }
    if (ids.length) {
      await tx.query(
        `UPDATE queue_entries e
            SET est_start_at = v.est,
                initial_est_start_at = COALESCE(e.initial_est_start_at, v.est)
           FROM unnest($1::uuid[], $2::timestamptz[]) AS v(id, est)
          WHERE e.id = v.id`,
        [ids, ests],
      );
    }
    // Entries whose stylist went off have no estimate any more.
    await tx.query(
      `UPDATE queue_entries SET est_start_at = NULL
        WHERE salon_id = $1 AND status IN ('waiting', 'called') AND NOT (id = ANY($2::uuid[]))`,
      [salon.id, ids],
    );

    const threshold = salon.turn_alert_minutes;
    if (threshold > 0) {
      for (const e of state.entries) {
        const est = state.estimates.get(e.id);
        if (e.status !== 'waiting' || e.turnAlertSentAt || !e.customerPhone || !est) continue;
        if (est.waitMinutes > threshold) continue;
        // Customers who joined with a short wait are already here; don't message them.
        const initial = e.initialEstStartAt ?? est.startAt;
        if (minutesBetween(e.joinedAt, initial) <= threshold) continue;
        await tx.query(`UPDATE queue_entries SET turn_alert_sent_at = $2 WHERE id = $1`, [e.id, now]);
        e.turnAlertSentAt = now;
        effects.push({
          kind: 'turn_alert',
          to: e.customerPhone,
          customerName: e.customerName,
          salonName: salon.name,
          stylistName: state.stylists.find((s) => s.id === e.stylistId)?.displayName ?? 'your stylist',
          minutes: est.waitMinutes,
        });
        await logEvent(tx, salon.id, e.id, e.stylistId, 'turn_alert_sent', 'system', { wait_minutes: est.waitMinutes }, now);
      }
    }
    return state;
  }

  private async runEffects(effects: Effect[]) {
    for (const fx of effects) {
      try {
        if (fx.kind === 'turn_alert') {
          await this.notifier.sendTurnAlert(fx.to, {
            customerName: fx.customerName,
            salonName: fx.salonName,
            stylistName: fx.stylistName,
            minutesUntilStart: fx.minutes,
          });
        } else {
          await this.notifier.sendCalled(fx.to, {
            customerName: fx.customerName,
            salonName: fx.salonName,
            stylistName: fx.stylistName,
            graceMinutes: fx.grace,
          });
        }
      } catch (err) {
        // A failed WhatsApp message must never undo a queue change.
        this.opts.log(`notification ${fx.kind} failed: ${(err as Error).message}`);
      }
    }
  }

  // ------------------------------------------------------------------ join

  async join(input: JoinInput) {
    const serviceIds = [...new Set(input.serviceIds)];
    if (serviceIds.length === 0) throw badRequest('NO_SERVICES', 'Choose at least one service');

    return this.mutate(input.salon.id, async (tx, now, salon) => {
      const isApp = input.source === 'app';
      const eWalkIn = input.eWalkIn === true;
      if (eWalkIn && !salon.e_walk_in_enabled) {
        throw conflict('E_WALK_IN_DISABLED', 'E Walk-In is not available at this salon right now');
      }

      // Services must exist, be active and belong to this salon.
      const { rows: services } = await tx.query<{ id: string; name: string; price_paise: number }>(
        `SELECT id, name, price_paise FROM services WHERE salon_id = $1 AND is_active AND id = ANY($2::uuid[])`,
        [salon.id, serviceIds],
      );
      if (services.length !== serviceIds.length) throw badRequest('INVALID_SERVICES', 'One or more services are not available here');

      let customerId = input.customerId;
      if (!customerId && input.guestPhone) {
        const { rows } = await tx.query<{ id: string }>(
          `INSERT INTO customers (phone, name, created_at, updated_at) VALUES ($1, $2, $3, $3)
           ON CONFLICT (phone) DO UPDATE SET name = COALESCE(customers.name, EXCLUDED.name)
           RETURNING id`,
          [input.guestPhone, input.guestName ?? null, now],
        );
        customerId = rows[0]!.id;
      }

      if (customerId) {
        const { rows } = await tx.query<{ id: string; salon_id: string }>(
          `SELECT id, salon_id FROM queue_entries WHERE customer_id = $1 AND status IN ${ACTIVE} ORDER BY joined_at`,
          [customerId],
        );
        const here = rows.find((r) => r.salon_id === salon.id);
        if (here || rows.length >= this.opts.maxActivePerCustomer) {
          throw conflict('ALREADY_IN_QUEUE', 'Already in a queue. Leave it first to join again.', {
            entry_id: (here ?? rows[0])!.id,
          });
        }
      }

      let distance: number | null = null;
      if (input.location) {
        const { rows } = await tx.query<{ d: number }>(
          `SELECT round(ST_Distance(location, ST_SetSRID(ST_MakePoint($2, $3), 4326)::geography))::int AS d
             FROM salons WHERE id = $1`,
          [salon.id, input.location.lng, input.location.lat],
        );
        distance = rows[0]!.d;
        if (isApp && salon.join_radius_m !== null && distance > salon.join_radius_m) {
          throw new AppError(403, 'TOO_FAR_FROM_SALON', 'You need to be near the salon to join its queue', {
            distance_m: distance,
            max_distance_m: salon.join_radius_m,
          });
        }
      }

      const state = await loadSalonState(tx, salon, now);
      if (isApp) {
        if (salon.joins_paused) throw conflict('JOINS_PAUSED', 'The salon is not taking new customers right now');
        if (!state.open.isOpenNow) {
          throw conflict('SALON_CLOSED', 'The salon is closed', { next_open_at: state.open.nextOpenAt?.toISOString() ?? null });
        }
      }

      const ctx = engineContext(state);
      const quotes = quoteAll(state.stylists, state.entries, serviceIds, ctx);
      let quote;
      if (input.stylistId) {
        const stylist = state.stylists.find((s) => s.id === input.stylistId);
        if (!stylist) throw notFound('Stylist');
        if (minutesFor(stylist, serviceIds) === null) {
          throw badRequest('STYLIST_DOES_NOT_OFFER', `${stylist.displayName} does not do all of the chosen services`);
        }
        if (eWalkIn && !stylist.eWalkIn) {
          throw conflict('STYLIST_NOT_E_WALK_IN', `${stylist.displayName} is not taking E Walk-In clients right now`);
        }
        quote = quotes.find((q) => q.stylistId === stylist.id);
        if (!quote) throw conflict('STYLIST_UNAVAILABLE', `${stylist.displayName} is not working right now`);
      } else if (eWalkIn) {
        const pool = new Set(state.stylists.filter((s) => s.eWalkIn).map((s) => s.id));
        quote = pickRandomAvailable(quotes.filter((q) => pool.has(q.stylistId)), this.opts.random);
        if (!quote) throw conflict('NO_STYLIST_AVAILABLE', 'No stylist who does these services is taking E Walk-In clients right now');
      } else {
        quote = pickAnyAvailable(state.stylists, quotes);
        if (!quote) throw conflict('NO_STYLIST_AVAILABLE', 'No stylist who does these services is working right now');
      }
      if (isApp && (!state.open.todayClosesAt || quote.startAt >= state.open.todayClosesAt)) {
        throw conflict('WOULD_EXCEED_CLOSING', 'The queue is too long to fit you in before closing today', {
          closes_at: state.open.todayClosesAt?.toISOString() ?? null,
        });
      }

      const stylist = state.stylists.find((s) => s.id === quote.stylistId)!;
      const { rows: pos } = await tx.query<{ p: number }>(
        `SELECT COALESCE(max(position), 0) + 1 AS p FROM queue_entries WHERE stylist_id = $1 AND status IN ${ACTIVE}`,
        [stylist.id],
      );
      const { rows: ins } = await tx.query<{ id: string }>(
        `INSERT INTO queue_entries
           (salon_id, customer_id, guest_name, source, join_mode, requested_stylist_id, stylist_id, position, joined_at, join_distance_m)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
        [
          salon.id, customerId, input.guestName ?? null, input.source, eWalkIn ? 'e_walk_in' : 'standard',
          input.stylistId, stylist.id, pos[0]!.p, now, distance,
        ],
      );
      const entryId = ins[0]!.id;
      for (const s of services) {
        await tx.query(
          `INSERT INTO queue_entry_services (queue_entry_id, salon_id, service_id, name_snapshot, minutes_snapshot, price_paise_snapshot)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [entryId, salon.id, s.id, s.name, stylist.serviceMinutes.get(s.id)!, s.price_paise],
        );
      }
      await logEvent(tx, salon.id, entryId, stylist.id, 'joined', input.actor, {
        source: input.source,
        e_walk_in: eWalkIn,
        any_stylist: input.stylistId === null,
        quoted_wait_minutes: quote.waitMinutes,
      }, now);
      return entryId;
    });
  }

  // ------------------------------------------------------------------ customer

  async leave(entryId: string, customerId: string) {
    const { rows } = await this.db.query<{ salon_id: string }>(
      `SELECT salon_id FROM queue_entries WHERE id = $1 AND customer_id = $2`,
      [entryId, customerId],
    );
    if (!rows[0]) throw notFound('Queue entry');
    return this.mutate(rows[0].salon_id, async (tx, now, salon) => {
      const e = await lockEntry(tx, salon.id, entryId);
      if (e.status !== 'waiting' && e.status !== 'called') {
        throw conflict('CANNOT_LEAVE', e.status === 'in_service' ? 'Your service has already started' : 'You are no longer in the queue');
      }
      await tx.query(`UPDATE queue_entries SET status = 'left', ended_at = $2 WHERE id = $1`, [entryId, now]);
      await logEvent(tx, salon.id, entryId, e.stylist_id, 'left', `customer:${customerId}`, {}, now);
      return entryId;
    });
  }

  // ------------------------------------------------------------------ staff

  async entryAction(actor: StaffActor, entryId: string, action: EntryAction) {
    return this.mutate(actor.salon.id, async (tx, now, salon, effects) => {
      const e = await lockEntry(tx, salon.id, entryId);
      assertStylistScope(actor, e.stylist_id);
      const by = `staff:${actor.staffUserId}`;
      const from = e.status;
      const need = (...ok: string[]) => {
        if (!ok.includes(from)) throw conflict('INVALID_TRANSITION', `Cannot ${action.replace('_', ' ')} a customer who is ${from.replace('_', ' ')}`);
      };

      switch (action) {
        case 'call': {
          need('waiting');
          await assertStylistWorking(tx, e.stylist_id);
          await tx.query(`UPDATE queue_entries SET status = 'called', called_at = $2 WHERE id = $1`, [entryId, now]);
          const info = await contactInfo(tx, entryId);
          if (info.phone) {
            effects.push({
              kind: 'called',
              to: info.phone,
              customerName: info.name,
              salonName: salon.name,
              stylistName: info.stylist_name,
              grace: salon.noshow_grace_minutes,
            });
          }
          break;
        }
        case 'start':
          need('waiting', 'called');
          await assertStylistWorking(tx, e.stylist_id);
          await tx.query(`UPDATE queue_entries SET status = 'in_service', started_at = $2 WHERE id = $1`, [entryId, now]);
          await tx.query(`UPDATE stylists SET status = 'busy', break_until = NULL WHERE id = $1`, [e.stylist_id]);
          break;
        case 'finish':
          need('in_service');
          await tx.query(`UPDATE queue_entries SET status = 'done', finished_at = $2 WHERE id = $1`, [entryId, now]);
          await tx.query(`UPDATE stylists SET status = 'available' WHERE id = $1 AND status = 'busy'`, [e.stylist_id]);
          break;
        case 'no_show':
          need('waiting', 'called');
          await tx.query(`UPDATE queue_entries SET status = 'no_show', ended_at = $2 WHERE id = $1`, [entryId, now]);
          break;
        case 'cancel':
          need('waiting', 'called');
          await tx.query(`UPDATE queue_entries SET status = 'cancelled', ended_at = $2 WHERE id = $1`, [entryId, now]);
          break;
        case 'requeue':
          need('waiting', 'called');
          await moveToBack(tx, entryId, e.stylist_id);
          break;
      }
      await logEvent(tx, salon.id, entryId, e.stylist_id, action, by, { from }, now);
      return entryId;
    });
  }

  async extend(actor: StaffActor, entryId: string, minutes: number) {
    return this.mutate(actor.salon.id, async (tx, now, salon) => {
      const e = await lockEntry(tx, salon.id, entryId);
      assertStylistScope(actor, e.stylist_id);
      if (e.status !== 'in_service') throw conflict('INVALID_TRANSITION', 'Only a running service can be extended');
      await tx.query(`UPDATE queue_entries SET extra_minutes = LEAST(extra_minutes + $2, 600) WHERE id = $1`, [entryId, minutes]);
      await logEvent(tx, salon.id, entryId, e.stylist_id, 'extended', `staff:${actor.staffUserId}`, { minutes }, now);
      return entryId;
    });
  }

  /** Reassign to another stylist and/or move within the stylist's line (1 = next up). */
  async updateEntry(actor: StaffActor, entryId: string, patch: { stylistId?: string; position?: number }) {
    return this.mutate(actor.salon.id, async (tx, now, salon) => {
      const e = await lockEntry(tx, salon.id, entryId);
      if (e.status !== 'waiting' && e.status !== 'called') {
        throw conflict('INVALID_TRANSITION', 'Only waiting customers can be moved');
      }
      let stylistId = e.stylist_id;
      if (patch.stylistId && patch.stylistId !== e.stylist_id) {
        const state = await loadSalonState(tx, salon, now);
        const target = state.stylists.find((s) => s.id === patch.stylistId);
        if (!target) throw notFound('Stylist');
        if (target.status === 'off') throw conflict('STYLIST_UNAVAILABLE', `${target.displayName} is not working right now`);
        const { rows } = await tx.query<{ service_id: string }>(
          `SELECT service_id FROM queue_entry_services WHERE queue_entry_id = $1`,
          [entryId],
        );
        if (minutesFor(target, rows.map((r) => r.service_id)) === null) {
          throw badRequest('STYLIST_DOES_NOT_OFFER', `${target.displayName} does not do all of this customer's services`);
        }
        stylistId = target.id;
        await tx.query(`UPDATE queue_entries SET stylist_id = $2, status = 'waiting', called_at = NULL WHERE id = $1`, [entryId, stylistId]);
        await resnapshotMinutes(tx, salon.id, entryId);
        if (patch.position === undefined) await moveToBack(tx, entryId, stylistId, { countSkip: false });
        await logEvent(tx, salon.id, entryId, stylistId, 'reassigned', `staff:${actor.staffUserId}`, { from: e.stylist_id }, now);
      }
      if (patch.position !== undefined) {
        await placeAt(tx, entryId, stylistId, patch.position);
        await logEvent(tx, salon.id, entryId, stylistId, 'reordered', `staff:${actor.staffUserId}`, { position: patch.position }, now);
      }
      return entryId;
    });
  }

  async setStylistStatus(actor: StaffActor, stylistId: string, status: StylistStatus, breakMinutes?: number) {
    return this.mutate(actor.salon.id, async (tx, now, salon) => {
      assertStylistScope(actor, stylistId);
      const { rows } = await tx.query<{ id: string }>(
        `SELECT id FROM stylists WHERE id = $1 AND salon_id = $2 AND is_active FOR UPDATE`,
        [stylistId, salon.id],
      );
      if (!rows[0]) throw notFound('Stylist');
      const { rows: running } = await tx.query(
        `SELECT 1 FROM queue_entries WHERE stylist_id = $1 AND status = 'in_service'`,
        [stylistId],
      );
      if ((status === 'off' || status === 'break') && running.length) {
        throw conflict('STYLIST_HAS_ACTIVE_SERVICE', 'Finish the current service first');
      }
      const breakUntil = status === 'break' ? new Date(now.getTime() + (breakMinutes ?? 15) * 60_000) : null;
      await tx.query(`UPDATE stylists SET status = $2, break_until = $3 WHERE id = $1`, [stylistId, status, breakUntil]);
      await logEvent(tx, salon.id, null, stylistId, `stylist_${status}`, `staff:${actor.staffUserId}`, { break_minutes: breakMinutes ?? null }, now);

      if (status === 'off') await this.redistributeAnyStylist(tx, salon, stylistId, now, actor);
      return stylistId;
    });
  }

  /**
   * When a stylist goes off, customers who chose "any available" move to the
   * stylist who can take them soonest. Customers who asked for this stylist
   * by name stay put (shown with stylist_available=false for the desk).
   */
  private async redistributeAnyStylist(tx: Tx, salon: SalonRow, offStylistId: string, now: Date, actor: StaffActor) {
    const { rows } = await tx.query<{ id: string }>(
      `SELECT id FROM queue_entries
        WHERE stylist_id = $1 AND status IN ('waiting', 'called') AND requested_stylist_id IS NULL
        ORDER BY status = 'called' DESC, position`,
      [offStylistId],
    );
    for (const { id } of rows) {
      const state = await loadSalonState(tx, salon, now);
      const { rows: svc } = await tx.query<{ service_id: string }>(
        `SELECT service_id FROM queue_entry_services WHERE queue_entry_id = $1`,
        [id],
      );
      const others = state.stylists.filter((s) => s.id !== offStylistId);
      const best = pickAnyAvailable(others, quoteAll(others, state.entries, svc.map((r) => r.service_id), engineContext(state)));
      if (!best) continue;
      await tx.query(`UPDATE queue_entries SET stylist_id = $2, status = 'waiting', called_at = NULL WHERE id = $1`, [id, best.stylistId]);
      await resnapshotMinutes(tx, salon.id, id);
      await moveToBack(tx, id, best.stylistId, { countSkip: false });
      await logEvent(tx, salon.id, id, best.stylistId, 'reassigned', `staff:${actor.staffUserId}`, { from: offStylistId, reason: 'stylist_off' }, now);
    }
  }

  // ------------------------------------------------------------------ background

  /** Apply the no-show grace period to called customers. Called by the sweeper. */
  async expireNoShows(salonId: string) {
    return this.mutate(salonId, async (tx, now, salon) => {
      const { rows } = await tx.query<{ id: string; stylist_id: string; skip_count: number }>(
        `SELECT id, stylist_id, skip_count FROM queue_entries
          WHERE salon_id = $1 AND status = 'called' AND called_at <= $2::timestamptz - make_interval(mins => $3)
          FOR UPDATE`,
        [salon.id, now, salon.noshow_grace_minutes],
      );
      for (const e of rows) {
        if (salon.noshow_policy === 'requeue_once' && e.skip_count === 0) {
          await moveToBack(tx, e.id, e.stylist_id);
          await logEvent(tx, salon.id, e.id, e.stylist_id, 'requeue', 'system', { reason: 'grace_expired' }, now);
        } else {
          await tx.query(`UPDATE queue_entries SET status = 'no_show', ended_at = $2 WHERE id = $1`, [e.id, now]);
          await logEvent(tx, salon.id, e.id, e.stylist_id, 'no_show', 'system', { reason: 'grace_expired' }, now);
        }
      }
      return rows.length;
    });
  }

  /** Recalculate (and push) without changing anything, e.g. after settings edits. */
  async touch(salonId: string, fn?: (tx: Tx, now: Date, salon: SalonRow) => Promise<void>) {
    return this.mutate(salonId, async (tx, now, salon) => {
      if (fn) await fn(tx, now, salon);
      return null;
    });
  }
}

// ------------------------------------------------------------------ helpers

interface LockedEntry {
  id: string;
  status: string;
  stylist_id: string;
  customer_id: string | null;
}

async function lockEntry(tx: Tx, salonId: string, entryId: string): Promise<LockedEntry> {
  const { rows } = await tx.query<LockedEntry>(
    `SELECT id, status, stylist_id, customer_id FROM queue_entries WHERE id = $1 AND salon_id = $2 FOR UPDATE`,
    [entryId, salonId],
  );
  if (!rows[0]) throw notFound('Queue entry');
  return rows[0];
}

function assertStylistScope(actor: StaffActor, stylistId: string) {
  if (actor.role === 'stylist' && actor.stylistId !== stylistId) {
    throw forbidden('Stylists can only manage their own customers');
  }
}

async function assertStylistWorking(tx: Tx, stylistId: string) {
  const { rows } = await tx.query<{ status: string; is_active: boolean }>(
    `SELECT status, is_active FROM stylists WHERE id = $1`,
    [stylistId],
  );
  if (!rows[0]?.is_active || rows[0].status === 'off') {
    throw conflict('STYLIST_OFF', 'This stylist is off. Reassign the customer first.');
  }
}

async function contactInfo(tx: Tx, entryId: string) {
  const { rows } = await tx.query<{ phone: string | null; name: string | null; stylist_name: string }>(
    `SELECT c.phone, COALESCE(c.name, e.guest_name) AS name, st.display_name AS stylist_name
       FROM queue_entries e JOIN stylists st ON st.id = e.stylist_id LEFT JOIN customers c ON c.id = e.customer_id
      WHERE e.id = $1`,
    [entryId],
  );
  return rows[0]!;
}

async function moveToBack(tx: Tx, entryId: string, stylistId: string, opts: { countSkip?: boolean } = {}) {
  await tx.query(
    `UPDATE queue_entries SET status = 'waiting', called_at = NULL,
            skip_count = skip_count + $3::int,
            position = (SELECT COALESCE(max(position), 0) + 1 FROM queue_entries
                         WHERE stylist_id = $2 AND status IN ${ACTIVE} AND id <> $1)
      WHERE id = $1`,
    [entryId, stylistId, opts.countSkip === false ? 0 : 1],
  );
}

/** Put an entry at a 1-based place in its stylist's line and renumber the line. */
async function placeAt(tx: Tx, entryId: string, stylistId: string, place: number) {
  const { rows } = await tx.query<{ id: string }>(
    `SELECT id FROM queue_entries
      WHERE stylist_id = $1 AND status IN ('waiting', 'called') AND id <> $2
      ORDER BY status = 'called' DESC, position`,
    [stylistId, entryId],
  );
  const ids = rows.map((r) => r.id);
  const index = Math.max(0, Math.min(place - 1, ids.length));
  ids.splice(index, 0, entryId);
  await tx.query(
    `UPDATE queue_entries e SET position = v.ord
       FROM unnest($1::uuid[]) WITH ORDINALITY AS v(id, ord) WHERE e.id = v.id`,
    [ids],
  );
}

/** Re-read each booked service's duration for the entry's current stylist (prices stay as agreed). */
export async function resnapshotMinutes(tx: Tx, salonId: string, entryId?: string) {
  await tx.query(
    `UPDATE queue_entry_services qes
        SET minutes_snapshot = COALESCE(ss.custom_minutes, sv.default_minutes)
       FROM queue_entries e
       JOIN services sv ON sv.salon_id = e.salon_id
       LEFT JOIN stylist_services ss ON ss.stylist_id = e.stylist_id AND ss.service_id = sv.id
      WHERE qes.queue_entry_id = e.id AND sv.id = qes.service_id
        AND e.salon_id = $1 AND e.status IN ('waiting', 'called')
        AND ($2::uuid IS NULL OR e.id = $2)`,
    [salonId, entryId ?? null],
  );
}

export async function logEvent(
  tx: Tx,
  salonId: string,
  entryId: string | null,
  stylistId: string | null,
  type: string,
  actor: string,
  data: Record<string, unknown>,
  at: Date,
) {
  await tx.query(
    `INSERT INTO queue_events (salon_id, queue_entry_id, stylist_id, type, actor, data, at) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [salonId, entryId, stylistId, type, actor, data, at],
  );
}
