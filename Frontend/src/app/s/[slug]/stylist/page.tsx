'use client';

import { useQuery } from '@tanstack/react-query';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { CustomerMenu } from '@/components/CustomerMenu';
import { Avatar, Badge, Button, Card, cx, EmptyState, MobileShell, Notice, Spinner, StylistStatusBadge } from '@/components/ui';
import { SlotPanel, type SlotInfo } from '@/components/EWalkIn';
import { WaitDisplay } from '@/components/WaitDisplay';
import { api, ApiError, type CustomerEntry, type EWalkInStatus, isApiError, type StylistCard } from '@/lib/api';
import { dayAndTime, minutes, plural, time } from '@/lib/format';
import { cachedLocation, requestLocation, useSalonEvents } from '@/lib/hooks';
import { customerSession, useCustomerSession } from '@/lib/session';

interface StylistsResponse {
  stylists: StylistCard[];
  e_walk_in: EWalkInStatus;
  is_open_now: boolean;
  accepting_joins: boolean;
  next_open_at: string | null;
  today_closes_at: string | null;
}

export default function StylistPage() {
  return (
    <Suspense>
      <ChooseStylist />
    </Suspense>
  );
}

function ChooseStylist() {
  const { slug } = useParams<{ slug: string }>();
  const serviceIds = (useSearchParams().get('services') ?? '').split(',').filter(Boolean);
  const router = useRouter();
  const session = useCustomerSession();
  // 'random' = let the salon assign a stylist; otherwise the id of the stylist asked for by name.
  const [choice, setChoice] = useState<string>('random');
  const [joining, setJoining] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  const key = ['stylists', slug, serviceIds.join(',')];
  const q = useQuery({
    queryKey: key,
    enabled: serviceIds.length > 0,
    queryFn: () => api<StylistsResponse>(`/v1/salons/${slug}/stylists`, { query: { service_ids: serviceIds.join(',') } }),
    refetchInterval: 30_000,
  });
  useSalonEvents(slug, [key]);

  const here = `/s/${slug}/stylist?services=${serviceIds.join(',')}`;

  async function join() {
    setError(null);
    if (!session) {
      router.push(`/login?next=${encodeURIComponent(here)}`);
      return;
    }
    if (session.customer.needs_name) {
      router.push(`/name?next=${encodeURIComponent(here)}`);
      return;
    }
    setJoining(true);
    // Location lets the salon refuse joins from far away. If it's off, join anyway.
    let location = cachedLocation();
    if (!location) location = await requestLocation(4000).catch(() => null);
    try {
      const { entry } = await api<{ entry: CustomerEntry }>(`/v1/salons/${slug}/queue`, {
        token: session.token,
        body: { service_ids: serviceIds, stylist_id: choice === 'random' ? null : choice, e_walk_in: true, location },
      });
      try {
        sessionStorage.removeItem(`kataar.services.${slug}`);
      } catch {
        /* ignore */
      }
      router.replace(`/queue/${entry.id}`);
    } catch (e) {
      if (isApiError(e, 'ALREADY_IN_QUEUE') && e.details?.entry_id) {
        router.replace(`/queue/${e.details.entry_id}`);
        return;
      }
      if (isApiError(e) && e.status === 401) {
        customerSession.set(null);
        router.push(`/login?next=${encodeURIComponent(here)}`);
        return;
      }
      setError(e as ApiError);
      setJoining(false);
      q.refetch();
    }
  }

  const data = q.data;
  const eWalkIn = data?.e_walk_in;
  const selectedCard = choice === 'random' ? null : data?.stylists.find((s) => s.id === choice);
  const canPick = (s: StylistCard) => s.available && s.e_walk_in_enabled;
  const canJoin =
    !!data?.accepting_joins && !!eWalkIn?.enabled && (choice === 'random' ? !!eWalkIn.next_slot : !!selectedCard && canPick(selectedCard));
  // What the customer would get with the current choice: a free chair, or a countdown and clients ahead.
  const slot: SlotInfo | null =
    choice === 'random'
      ? eWalkIn?.next_slot ?? null
      : selectedCard && canPick(selectedCard) && selectedCard.est_start_at
        ? { est_start_at: selectedCard.est_start_at, wait_minutes: selectedCard.wait_minutes ?? 0, people_ahead: selectedCard.queue_length }
        : null;

  return (
    <MobileShell
      back={`/s/${slug}`}
      title="E Walk-In"
      right={<CustomerMenu />}
      footer={
        <div className="space-y-2">
          {error && <JoinError error={error} />}
          <Button size="lg" className="w-full" disabled={!canJoin} loading={joining} onClick={join}>
            {session ? 'Join E Walk-In' : 'Sign in to join'}
          </Button>
        </div>
      }
    >
      {serviceIds.length === 0 && (
        <EmptyState icon="✂️" title="No services chosen">
          Go back and pick at least one service.
        </EmptyState>
      )}
      {q.isLoading && (
        <div className="grid place-items-center py-10 text-muted">
          <Spinner />
        </div>
      )}
      {data && !data.is_open_now && (
        <Notice tone="off" title="The salon is closed" className="mb-4">
          {data.next_open_at ? `Opens ${dayAndTime(data.next_open_at)}.` : ''}
        </Notice>
      )}
      {data && data.is_open_now && !data.accepting_joins && (
        <Notice tone="warn" title="Not taking new customers right now" className="mb-4">
          The desk has paused new joins. Try again in a few minutes.
        </Notice>
      )}

      {data && data.is_open_now && data.accepting_joins && eWalkIn && !eWalkIn.enabled && (
        <Notice tone="warn" title="E Walk-In is switched off right now" className="mb-4">
          The desk isn&apos;t taking E Walk-In clients at the moment. Please check at the salon.
        </Notice>
      )}
      {data && eWalkIn?.enabled && (
        <>
          <h1 className="text-xl font-bold">Join the walk-in line from your phone</h1>
          <p className="mb-4 mt-1 text-sm text-muted">
            Pick a stylist yourself, or let us assign one. We&apos;ll show how many clients are ahead of you and count down to your slot.
          </p>
          <SlotPanel mode={choice === 'random' ? 'random' : 'chosen'} name={selectedCard?.display_name} freeNow={eWalkIn.free_now} slot={slot} />
        </>
      )}

      {data && (
        <ul className="space-y-2.5">
          <li>
            <OptionCard selected={choice === 'random'} disabled={!eWalkIn?.next_slot} onClick={() => setChoice('random')}>
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="font-semibold">Assign me a stylist</div>
                  <div className="mt-0.5 text-sm text-muted">
                    {eWalkIn?.next_slot
                      ? "Not sure who to pick? We'll choose one of the stylists who can take you first."
                      : 'Nobody who does these services is taking E Walk-In clients now'}
                  </div>
                </div>
                <Badge tone="brand">Random</Badge>
              </div>
              {eWalkIn?.next_slot && (
                <div className="mt-3">
                  <WaitDisplay range={eWalkIn.next_slot.wait_range_minutes} startAt={eWalkIn.next_slot.est_start_at} />
                </div>
              )}
            </OptionCard>
          </li>
          {data.stylists.map((s) => (
            <li key={s.id}>
              <OptionCard selected={choice === s.id} disabled={!canPick(s)} onClick={() => setChoice(s.id)}>
                <div className="flex items-start gap-3">
                  <Avatar name={s.display_name} muted={!canPick(s)} />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-semibold">{s.display_name}</span>
                      <StylistStatusBadge status={s.status} />
                    </div>
                    {canPick(s) ? (
                      <div className="mt-0.5 text-sm text-muted">
                        {s.queue_length ? `${plural(s.queue_length, 'client')} ahead` : 'Nobody waiting'}
                        {s.minutes ? ` · takes ${minutes(s.minutes)}` : ''}
                        {s.status === 'break' && s.break_until ? ` · back at ${time(s.break_until)}` : ''}
                      </div>
                    ) : (
                      <div className="mt-0.5 text-sm text-muted">
                        {s.available ? 'Not taking E Walk-In clients right now' : 'Not working right now'}
                      </div>
                    )}
                  </div>
                  {canPick(s) && (
                    <div className="shrink-0 text-right">
                      <WaitDisplay range={s.wait_range_minutes} startAt={s.est_start_at} />
                    </div>
                  )}
                </div>
              </OptionCard>
            </li>
          ))}
        </ul>
      )}
      {data && (
        <p className="mt-5 text-center text-xs text-muted">
          Waits are estimates and update live. You&apos;ll pay at the salon.
        </p>
      )}
    </MobileShell>
  );
}

function OptionCard({ selected, disabled, onClick, children }: { selected: boolean; disabled?: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button className="w-full text-left disabled:cursor-not-allowed" disabled={disabled} onClick={onClick} aria-pressed={selected}>
      <Card className={cx('p-4 transition-colors', selected && !disabled && 'border-brand ring-2 ring-brand/20', disabled && 'opacity-55')}>
        {children}
      </Card>
    </button>
  );
}

function JoinError({ error }: { error: ApiError }) {
  const extra =
    error.code === 'TOO_FAR_FROM_SALON' && error.details?.max_distance_m
      ? ` You need to be within ${Math.round(Number(error.details.max_distance_m) / 100) / 10} km.`
      : error.code === 'SALON_CLOSED' && error.details?.next_open_at
        ? ` Opens ${dayAndTime(String(error.details.next_open_at))}.`
        : error.code === 'WOULD_EXCEED_CLOSING' && error.details?.closes_at
          ? ` The salon closes at ${time(String(error.details.closes_at))}. Try another stylist or come back tomorrow.`
          : '';
  return (
    <div role="alert" className="rounded-xl bg-danger-soft px-4 py-3 text-sm text-danger">
      {error.message.replace(/\.?$/, '.')}{extra}
    </div>
  );
}
