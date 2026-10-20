'use client';

import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { WalkInSheet } from '@/components/WalkInSheet';
import { canDesk, useStaff } from '@/components/staff';
import { Avatar, Badge, Button, Card, cx, EmptyState, ErrorBox, LiveIndicator, Sheet, Spinner, StylistStatusBadge } from '@/components/ui';
import { api, type Dashboard, type DashboardEntry, type StylistBoardItem, type StylistStatus } from '@/lib/api';
import { dayAndTime, minutes, rupees, time, waitRange } from '@/lib/format';
import { useNow, useSalonEvents } from '@/lib/hooks';

export default function DashboardPage() {
  const { slug, token, role, stylistId } = useStaff();
  const key = ['dashboard', slug];
  const q = useQuery({
    queryKey: key,
    queryFn: () => api<Dashboard>(`/v1/dashboard/${slug}`, { token }),
    refetchInterval: 30_000,
  });
  const live = useSalonEvents(slug, [key]);
  const [walkIn, setWalkIn] = useState(false);
  const [filter, setFilter] = useState<'all' | 'e_walk_in'>('all');

  if (q.isLoading)
    return (
      <div className="grid place-items-center py-20 text-muted">
        <Spinner className="size-6" />
      </div>
    );
  if (!q.data) return <ErrorBox error={q.error} />;

  const d = q.data;
  const isStylist = role === 'stylist';
  const mine = isStylist ? d.entries.filter((e) => e.stylist.id === stylistId) : d.entries;
  const eWalkInCount = mine.filter((e) => e.e_walk_in).length;
  const entries = filter === 'e_walk_in' ? mine.filter((e) => e.e_walk_in) : mine;
  const stylists = isStylist ? d.stylists.filter((s) => s.id === stylistId) : d.stylists;

  return (
    <div className="space-y-5">
      <SalonBar d={d} live={live} eWalkInCount={d.entries.filter((e) => e.e_walk_in).length} onWalkIn={canDesk(role) ? () => setWalkIn(true) : undefined} />

      {isStylist && !stylistId && (
        <Card className="p-4 text-sm text-muted">Your login isn&apos;t linked to a stylist yet. Ask the owner to link it.</Card>
      )}

      <section aria-label="Stylists">
        <div className={cx('grid gap-3', isStylist ? 'grid-cols-1' : 'grid-cols-1 sm:grid-cols-2 xl:grid-cols-4')}>
          {stylists.map((s) => (
            <StylistCardView key={s.id} stylist={s} current={d.entries.find((e) => e.id === s.current_entry_id)} />
          ))}
        </div>
      </section>

      <section aria-label="Queue">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-baseline gap-3">
            <h2 className="text-lg font-bold">{isStylist ? 'My customers' : 'Queue'}</h2>
            <span className="text-sm text-muted">{entries.length ? `${entries.length} ${filter === 'e_walk_in' ? 'E Walk-In' : 'in the salon'}` : ''}</span>
          </div>
          <div role="group" aria-label="Filter the queue" className="flex gap-1 rounded-xl bg-surface-2 p-1 text-sm font-semibold">
            {([['all', `All (${mine.length})`], ['e_walk_in', `E Walk-In (${eWalkInCount})`]] as const).map(([value, label]) => (
              <button
                key={value}
                aria-pressed={filter === value}
                onClick={() => setFilter(value)}
                className={cx('rounded-lg px-3 py-1.5', filter === value ? 'bg-surface shadow-sm' : 'text-muted hover:text-ink')}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        {entries.length === 0 ? (
          <Card>
            <EmptyState icon="🪑" title={filter === 'e_walk_in' ? 'No E Walk-In clients' : d.salon.is_open_now ? 'Nobody waiting' : 'The salon is closed'}>
              {filter === 'e_walk_in'
                ? 'Customers who join from the app with E Walk-In show up here.'
                : d.salon.is_open_now
                ? 'New customers appear here the moment they join from their phone.'
                : d.salon.next_open_at
                  ? `Opens ${dayAndTime(d.salon.next_open_at)}. You can still add walk-ins.`
                  : ''}
            </EmptyState>
          </Card>
        ) : (
          <div className="space-y-2">
            {entries.map((e) => (
              <EntryRow key={e.id} entry={e} dashboard={d} />
            ))}
          </div>
        )}
      </section>

      {walkIn && <WalkInSheet onClose={() => setWalkIn(false)} />}
    </div>
  );
}

// ------------------------------------------------------------------ header bar

function SalonBar({
  d,
  live,
  eWalkInCount,
  onWalkIn,
}: {
  d: Dashboard;
  live: 'connecting' | 'live' | 'reconnecting';
  eWalkInCount: number;
  onWalkIn?: () => void;
}) {
  const { call, role } = useStaff();
  const s = d.salon;
  const [busy, setBusy] = useState(false);
  return (
    <Card className="flex flex-wrap items-center gap-x-4 gap-y-3 p-4">
      <div className="min-w-0">
        <div className="text-lg font-bold">{s.name}</div>
        <div className="mt-0.5 flex flex-wrap items-center gap-2 text-sm">
          {s.is_open_now ? (
            <Badge tone="ok">● Open · closes {time(s.today_closes_at)}</Badge>
          ) : (
            <Badge tone="off">Closed{s.next_open_at ? ` · opens ${dayAndTime(s.next_open_at)}` : ''}</Badge>
          )}
          {s.joins_paused && <Badge tone="warn">New joins paused</Badge>}
          {s.e_walk_in_enabled ? (
            <Badge tone="brand">E Walk-In on · {eWalkInCount} in line</Badge>
          ) : (
            <Badge tone="warn">E Walk-In off</Badge>
          )}
          <LiveIndicator state={live} />
        </div>
      </div>
      <div className="ml-auto flex flex-wrap items-center gap-2">
        {canDesk(role) && (
          <label className="flex cursor-pointer items-center gap-2 rounded-xl border border-line px-3 py-2 text-sm font-medium">
            <input
              type="checkbox"
              className="size-4 accent-[var(--brand)]"
              checked={s.joins_paused}
              disabled={busy}
              onChange={async (e) => {
                setBusy(true);
                await call('/settings', {
                  method: 'PATCH',
                  body: { joins_paused: e.target.checked },
                  success: e.target.checked ? 'New joins paused' : 'Taking new joins again',
                });
                setBusy(false);
              }}
            />
            Pause new joins
          </label>
        )}
        {canDesk(role) && (
          <label className="flex cursor-pointer items-center gap-2 rounded-xl border border-line px-3 py-2 text-sm font-medium">
            <input
              type="checkbox"
              className="size-4 accent-[var(--brand)]"
              checked={s.e_walk_in_enabled}
              disabled={busy}
              onChange={async (e) => {
                setBusy(true);
                await call('/settings', {
                  method: 'PATCH',
                  body: { e_walk_in_enabled: e.target.checked },
                  success: e.target.checked ? 'E Walk-In is on' : 'E Walk-In is off. Customers already in line keep their place',
                });
                setBusy(false);
              }}
            />
            E Walk-In
          </label>
        )}
        {onWalkIn && (
          <Button onClick={onWalkIn} size="md">
            + Add walk-in
          </Button>
        )}
      </div>
    </Card>
  );
}

// ------------------------------------------------------------------ stylist cards

function StylistCardView({ stylist: s, current }: { stylist: StylistBoardItem; current?: DashboardEntry }) {
  const { call, role, stylistId } = useStaff();
  const now = useNow(15_000);
  const canChange = canDesk(role) || s.id === stylistId;
  const set = (status: StylistStatus, break_minutes?: number) =>
    call(`/stylists/${s.id}/status`, {
      method: 'PUT',
      body: { status, break_minutes },
      success: `${s.display_name}: ${status === 'break' ? `break ${break_minutes} min` : status}`,
    });

  let currentLine: React.ReactNode = null;
  if (current) {
    const left = current.est_end_at ? Math.round((new Date(current.est_end_at).getTime() - now) / 60_000) : null;
    currentLine = (
      <div className="mt-3 rounded-xl bg-surface-2 px-3 py-2 text-sm">
        <div className="font-semibold">✂ {current.display_name}</div>
        <div className="text-muted">
          {current.services.map((x) => x.name).join(' + ')}
          {left !== null && (left > 0 ? ` · ${left} min left` : ' · finishing')}
        </div>
      </div>
    );
  }

  return (
    <Card className={cx('p-4', s.status === 'off' && 'opacity-70')}>
      <div className="flex items-start gap-3">
        <Avatar name={s.display_name} muted={s.status === 'off'} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <span className="truncate font-semibold">{s.display_name}</span>
            <StylistStatusBadge status={s.status} />
          </div>
          <div className="mt-0.5 text-sm text-muted">
            {s.status === 'off'
              ? 'Not working'
              : s.status === 'break' && s.break_until
                ? `Back at ${time(s.break_until)} · ${s.queue_length} in line`
                : `${s.queue_length} in line${s.next_free_at ? ` · free ${time(s.next_free_at)}` : ''}`}
          </div>
        </div>
      </div>
      {currentLine}
      {s.status !== 'off' && !s.e_walk_in_enabled && (
        <div className="mt-3">
          <Badge tone="warn">Not taking E Walk-In</Badge>
        </div>
      )}
      {canChange && (
        <label
          className="mt-3 flex cursor-pointer items-center gap-2 text-sm"
          title="Out of E Walk-In means no random picks and no requests by name. Customers already in line stay."
        >
          <input
            type="checkbox"
            className="size-4 accent-[var(--brand)]"
            checked={s.e_walk_in_enabled}
            onChange={(e) =>
              call(`/stylists/${s.id}/e-walk-in`, {
                method: 'PUT',
                body: { enabled: e.target.checked },
                success: `${s.display_name}: ${e.target.checked ? 'taking E Walk-In clients' : 'out of E Walk-In'}`,
              })
            }
          />
          <span className="font-medium">Takes E Walk-In</span>
        </label>
      )}
      {canChange && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {s.status !== 'available' && s.status !== 'busy' && (
            <Button size="sm" variant="secondary" onClick={() => set('available')}>
              {s.status === 'off' ? 'Start shift' : 'Back from break'}
            </Button>
          )}
          {s.status !== 'off' && !current && (
            <>
              {s.status !== 'break' && (
                <>
                  <Button size="sm" variant="secondary" onClick={() => set('break', 15)}>
                    Break 15
                  </Button>
                  <Button size="sm" variant="secondary" onClick={() => set('break', 30)}>
                    Break 30
                  </Button>
                </>
              )}
              <Button size="sm" variant="ghost" onClick={() => set('off')}>
                End shift
              </Button>
            </>
          )}
        </div>
      )}
    </Card>
  );
}

// ------------------------------------------------------------------ queue rows

function EntryRow({ entry: e, dashboard: d }: { entry: DashboardEntry; dashboard: Dashboard }) {
  const { call, role, stylistId, settings } = useStaff();
  const desk = canDesk(role);
  const mine = e.stylist.id === stylistId;
  const canServe = desk || mine;
  const [more, setMore] = useState(false);
  const [moveOpen, setMoveOpen] = useState(false);
  const now = useNow(1000);
  const act = (a: string, success?: string, body?: unknown) => call(`/queue/${e.id}/${a}`, { body, success });

  // Position within this stylist's line (for move up/down).
  const line = d.entries.filter((x) => x.stylist.id === e.stylist.id && (x.status === 'waiting' || x.status === 'called'));
  const idx = line.findIndex((x) => x.id === e.id);

  const needsReassign = !e.stylist_available && e.status !== 'in_service';
  const graceEnds = e.status === 'called' && e.called_at ? new Date(e.called_at).getTime() + (settings?.noshow_grace_minutes ?? 5) * 60_000 : null;
  const graceLeft = graceEnds ? Math.max(0, Math.round((graceEnds - now) / 1000)) : null;
  const serviceLeft = e.status === 'in_service' && e.est_end_at ? Math.round((new Date(e.est_end_at).getTime() - now) / 60_000) : null;

  return (
    <Card
      className={cx(
        'flex flex-wrap items-center gap-x-4 gap-y-3 p-3 sm:p-4',
        e.status === 'called' && 'border-accent bg-accent-soft/60',
        e.status === 'in_service' && 'border-brand/40 bg-brand-soft/30',
        needsReassign && 'border-warn bg-warn-soft/60',
      )}
    >
      <div className="flex min-w-[220px] flex-1 items-center gap-3">
        <Avatar name={e.display_name} size="sm" />
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="font-semibold">{e.display_name}</span>
            {e.e_walk_in ? (
              <Badge tone="brand">E Walk-In</Badge>
            ) : (
              <Badge tone={e.source === 'app' ? 'brand' : 'neutral'}>{e.source === 'app' ? 'App' : 'Walk-in'}</Badge>
            )}
            {e.phone_masked && <span className="text-xs text-muted tabular">{e.phone_masked}</span>}
          </div>
          <div className="mt-0.5 truncate text-sm text-muted">
            {e.services.map((s) => s.name).join(' + ')} · {minutes(e.total_minutes)} · {rupees(e.total_price_paise)}
          </div>
        </div>
      </div>

      <div className="min-w-[120px] text-sm">
        <div className="font-medium">
          {e.stylist.display_name}
          {e.any_stylist && (
            <Badge tone="neutral" className="ml-1.5">
              {e.e_walk_in ? 'Random' : 'Any'}
            </Badge>
          )}
        </div>
        {needsReassign ? (
          <div className="font-semibold text-warn">Needs reassigning</div>
        ) : e.status === 'in_service' ? (
          <div className={cx('tabular', serviceLeft !== null && serviceLeft < 0 ? 'text-accent' : 'text-muted')}>
            {serviceLeft === null ? 'In service' : serviceLeft >= 0 ? `${serviceLeft} min left` : `${-serviceLeft} min over`}
          </div>
        ) : e.status === 'called' ? (
          <div className="font-semibold text-accent tabular">
            Called · {graceLeft !== null ? `${Math.floor(graceLeft / 60)}:${String(graceLeft % 60).padStart(2, '0')}` : ''}
          </div>
        ) : (
          <div className="text-muted tabular">
            {waitRange(e.wait_range_minutes)}
            {e.est_start_at && e.wait_minutes ? ` · ${time(e.est_start_at)}` : ''}
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        {needsReassign && desk && (
          <Button size="sm" variant="primary" onClick={() => setMoveOpen(true)}>
            Move to…
          </Button>
        )}
        {!needsReassign && canServe && e.status === 'waiting' && (
          <>
            <Button size="sm" variant="secondary" onClick={() => act('call', `Called ${e.display_name}`)}>
              Call
            </Button>
            <Button size="sm" onClick={() => act('start', `${e.display_name} in the chair`)}>
              Start
            </Button>
          </>
        )}
        {!needsReassign && canServe && e.status === 'called' && (
          <Button size="sm" onClick={() => act('start', `${e.display_name} in the chair`)}>
            Start
          </Button>
        )}
        {canServe && e.status === 'in_service' && (
          <>
            <Button size="sm" variant="secondary" onClick={() => act('extend', 'Added 5 min', { minutes: 5 })}>
              +5
            </Button>
            <Button size="sm" variant="secondary" onClick={() => act('extend', 'Added 10 min', { minutes: 10 })}>
              +10
            </Button>
            <Button size="sm" onClick={() => act('finish', `${e.display_name} done`)}>
              Finish
            </Button>
          </>
        )}
        {desk && e.status !== 'in_service' && (
          <Button size="sm" variant="ghost" aria-label="More actions" onClick={() => setMore(true)}>
            ⋯
          </Button>
        )}
      </div>

      <Sheet open={more} onClose={() => setMore(false)} title={e.display_name}>
        <div className="grid gap-2">
          {idx > 0 && (
            <Button variant="secondary" onClick={() => (setMore(false), call(`/queue/${e.id}`, { method: 'PATCH', body: { position: idx } }))}>
              ↑ Move up
            </Button>
          )}
          {idx >= 0 && idx < line.length - 1 && (
            <Button variant="secondary" onClick={() => (setMore(false), call(`/queue/${e.id}`, { method: 'PATCH', body: { position: idx + 2 } }))}>
              ↓ Move down
            </Button>
          )}
          <Button variant="secondary" onClick={() => (setMore(false), setMoveOpen(true))}>
            Move to another stylist
          </Button>
          <Button variant="secondary" onClick={() => (setMore(false), act('requeue', `${e.display_name} moved to the back`))}>
            Skip · send to back of line
          </Button>
          <Button variant="secondary" onClick={() => (setMore(false), act('no-show', `${e.display_name} marked no-show`))}>
            Mark no-show
          </Button>
          <Button variant="danger" onClick={() => (setMore(false), act('cancel', `${e.display_name} removed`))}>
            Remove from queue
          </Button>
        </div>
      </Sheet>

      <Sheet open={moveOpen} onClose={() => setMoveOpen(false)} title={`Move ${e.display_name} to…`}>
        <div className="grid gap-2">
          {d.stylists
            .filter((s) => s.id !== e.stylist.id && s.status !== 'off')
            .map((s) => (
              <button
                key={s.id}
                className="flex items-center gap-3 rounded-xl border border-line p-3 text-left hover:bg-surface-2"
                onClick={async () => {
                  setMoveOpen(false);
                  await call(`/queue/${e.id}`, { method: 'PATCH', body: { stylist_id: s.id }, success: `Moved to ${s.display_name}` });
                }}
              >
                <Avatar name={s.display_name} size="sm" />
                <div className="flex-1">
                  <div className="font-semibold">{s.display_name}</div>
                  <div className="text-sm text-muted">
                    {s.queue_length} in line{s.next_free_at ? ` · free ${time(s.next_free_at)}` : ''}
                  </div>
                </div>
                <StylistStatusBadge status={s.status} />
              </button>
            ))}
          <p className="text-xs text-muted">They go to the end of that stylist&apos;s line. Only stylists who do all their services can take them.</p>
        </div>
      </Sheet>
    </Card>
  );
}
