'use client';

import { useNow } from '@/lib/hooks';
import { plural, time, waitRange } from '@/lib/format';
import { Badge, Card, cx } from './ui';

/** 12:34, or 1:05:09 once it is an hour or more away. */
export function formatCountdown(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${String(m).padStart(2, '0')}:${sec}`;
}

/** Seconds left until `to`, ticking every second (0 once it has passed). */
export function useSecondsUntil(to: string | null | undefined): number | null {
  const now = useNow(1000);
  if (!to) return null;
  return Math.max(0, Math.ceil((new Date(to).getTime() - now) / 1000));
}

/** Live countdown to a slot. Shows `doneLabel` once the time has been reached. */
export function Countdown({
  to,
  size = 'md',
  doneLabel = 'Any moment now',
}: {
  to: string | null | undefined;
  size?: 'sm' | 'md' | 'xl';
  doneLabel?: string;
}) {
  const left = useSecondsUntil(to);
  if (left === null) return null;
  const mins = Math.ceil(left / 60);
  return (
    <span
      role="timer"
      aria-label={left === 0 ? doneLabel : `${plural(mins, 'minute')} left`}
      className={cx('font-bold tabular leading-tight', size === 'xl' ? 'text-5xl tracking-tight' : size === 'md' ? 'text-2xl' : 'text-base')}
    >
      {left === 0 ? <span className={size === 'xl' ? 'text-3xl' : 'text-lg'}>{doneLabel}</span> : formatCountdown(left)}
    </span>
  );
}

export interface SlotInfo {
  est_start_at: string;
  wait_minutes: number;
  people_ahead: number;
}

/**
 * What E Walk-In would give you right now, before you join: either "a chair is free" or a live
 * countdown to the next slot with the number of clients ahead. Works for a random pick and for a
 * stylist you chose.
 */
export function SlotPanel({
  mode,
  name,
  freeNow,
  slot,
}: {
  mode: 'random' | 'chosen';
  name?: string;
  freeNow?: number;
  slot: SlotInfo | null;
}) {
  if (!slot) return null;

  if (slot.wait_minutes === 0) {
    const title =
      mode === 'chosen'
        ? `${name} is free right now`
        : (freeNow ?? 0) > 1
          ? `${freeNow} stylists are free right now`
          : 'A stylist is free right now';
    return (
      <Card className="mb-4 border-ok/30 bg-ok-soft p-4">
        <div className="flex items-start gap-3">
          <span aria-hidden className="text-2xl">
            🟢
          </span>
          <div>
            <div className="font-semibold text-ok">{title}</div>
            <div className="mt-0.5 text-sm text-ink/80">
              {mode === 'chosen'
                ? "Join now and you'll be seated straight away."
                : "Join now and we'll assign one of them to you at random."}
            </div>
          </div>
        </div>
      </Card>
    );
  }

  return (
    <Card className="mb-4 border-warn/30 bg-warn-soft p-4 text-center">
      <div className="text-sm font-semibold text-warn">
        {mode === 'chosen' ? `${name} is busy` : 'All stylists are busy'}
      </div>
      <div className="mt-1 text-xs uppercase tracking-wide text-muted">Next slot opens in</div>
      <div className="mt-1">
        <Countdown to={slot.est_start_at} />
      </div>
      <div className="mt-2 flex flex-wrap items-center justify-center gap-2 text-sm">
        <span className="rounded-full bg-surface px-3 py-1 font-medium">
          {plural(slot.people_ahead, 'client')} ahead of you
        </span>
        <span className="text-muted tabular">around {time(slot.est_start_at)}</span>
      </div>
    </Card>
  );
}

/** Headline for a customer who is waiting in the E Walk-In line. */
export function EWalkInHero({
  waitRange: range,
  startAt,
  peopleAhead,
}: {
  waitRange: { low: number; high: number } | null;
  startAt: string | null;
  peopleAhead: number;
}) {
  const next = peopleAhead === 0;
  return (
    <Card className={cx('p-6 text-center', next && 'border-brand bg-brand-soft/50')}>
      <Badge tone="brand">E Walk-In</Badge>
      <div className="mt-3 text-sm font-semibold uppercase tracking-wide text-muted">{next ? "You're next" : 'Your slot opens in'}</div>
      <div className="mt-2">
        <Countdown to={startAt} size="xl" />
      </div>
      {startAt && (
        <div className="mt-2 text-sm text-muted tabular">
          around {time(startAt)}
          {range ? ` · usually ${waitRange(range)}` : ''}
        </div>
      )}
      <div className="mt-4 inline-flex items-center gap-2 rounded-full bg-surface-2 px-4 py-2 text-sm font-semibold">
        {next ? 'Nobody ahead of you' : `${plural(peopleAhead, 'client')} ahead of you`}
      </div>
      <p className="mt-3 text-xs text-muted">
        {next ? 'Please stay close. You’ll be called soon.' : 'The count goes down as each client is finished. Times can shift a little.'}
      </p>
    </Card>
  );
}
