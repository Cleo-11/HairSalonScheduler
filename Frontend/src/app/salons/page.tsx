'use client';

import { useQuery } from '@tanstack/react-query';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { CustomerMenu } from '@/components/CustomerMenu';
import { Badge, Button, Card, cx, EmptyState, ErrorBox, MobileShell, Notice, Spinner } from '@/components/ui';
import { api, type SalonSummary } from '@/lib/api';
import { dayAndTime, distance } from '@/lib/format';
import { type LatLng, requestLocation } from '@/lib/hooks';

const SalonMap = dynamic(() => import('@/components/SalonMap'), {
  ssr: false,
  loading: () => (
    <div className="grid h-full place-items-center text-muted">
      <Spinner />
    </div>
  ),
});

type LocState = { kind: 'asking' } | { kind: 'ok'; loc: LatLng } | { kind: 'denied' };

export default function SalonsPage() {
  const router = useRouter();
  const [loc, setLoc] = useState<LocState>({ kind: 'asking' });
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    requestLocation()
      .then((l) => setLoc({ kind: 'ok', loc: l }))
      .catch(() => setLoc({ kind: 'denied' }));
  }, []);

  const point = loc.kind === 'ok' ? loc.loc : null;
  const salons = useQuery({
    queryKey: ['salons', point?.lat, point?.lng],
    enabled: loc.kind !== 'asking',
    queryFn: () =>
      api<{ salons: SalonSummary[] }>('/v1/salons', { query: { lat: point?.lat, lng: point?.lng, limit: 20 } }).then((r) => r.salons),
  });

  const list = salons.data ?? [];
  // With only one salon, pre-select it.
  useEffect(() => {
    if (list.length >= 1 && !selected) setSelected(list[0]!.slug);
  }, [list, selected]);
  const current = list.find((s) => s.slug === selected) ?? null;

  return (
    <MobileShell
      right={<CustomerMenu />}
      footer={
        current && (
          <div>
            <SalonBlocker salon={current} />
            <Button
              size="lg"
              className="w-full"
              disabled={!current.accepting_joins || !current.e_walk_in_enabled || current.within_join_radius === false}
              onClick={() => router.push(`/s/${current.slug}`)}
            >
              Continue with {current.name}
            </Button>
          </div>
        )
      }
    >
      <h1 className="text-xl font-bold">{list.length === 1 ? 'Your salon' : 'Salons near you'}</h1>

      {loc.kind === 'denied' && (
        <Notice tone="warn" className="mt-3" title="Location is off">
          Showing all salons instead. Turn on location to see what&apos;s nearest.
        </Notice>
      )}

      {loc.kind !== 'denied' && (
        <div className="-mx-4 mt-3 h-56 overflow-hidden border-y border-line sm:mx-0 sm:rounded-2xl sm:border">
          {loc.kind === 'asking' ? (
            <div className="grid h-full place-items-center text-sm text-muted">Finding your location…</div>
          ) : (
            <SalonMap salons={list} selected={selected} onSelect={setSelected} userLocation={point} />
          )}
        </div>
      )}

      <ErrorBox error={salons.error} className="mt-4" />
      {salons.isLoading && (
        <div className="grid place-items-center py-10 text-muted">
          <Spinner />
        </div>
      )}
      {salons.isSuccess && list.length === 0 && (
        <EmptyState icon="💈" title="No salons nearby yet">
          We&apos;re starting with a few salons. Check back soon.
        </EmptyState>
      )}

      <ul className="mt-4 space-y-3">
        {list.map((s) => (
          <li key={s.id}>
            <button className="w-full text-left" onClick={() => setSelected(s.slug)} aria-pressed={s.slug === selected}>
              <Card className={cx('p-4 transition-colors', s.slug === selected && 'border-brand ring-2 ring-brand/20')}>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="font-semibold">{s.name}</div>
                    <div className="mt-0.5 truncate text-sm text-muted">{s.address}</div>
                  </div>
                  {s.distance_m !== null && <div className="shrink-0 text-sm font-medium text-muted">{distance(s.distance_m)}</div>}
                </div>
                <div className="mt-2 flex flex-wrap gap-2">
                  {s.accepting_joins && !s.e_walk_in_enabled ? (
                    <Badge tone="warn">E Walk-In is off</Badge>
                  ) : s.accepting_joins ? (
                    <Badge tone="ok">● Open · E Walk-In available</Badge>
                  ) : s.is_open_now ? (
                    <Badge tone="warn">Not taking new joins</Badge>
                  ) : (
                    <Badge tone="off">Closed{s.next_open_at ? ` · opens ${dayAndTime(s.next_open_at)}` : ''}</Badge>
                  )}
                  {s.within_join_radius === false && <Badge tone="warn">Too far to join</Badge>}
                </div>
              </Card>
            </button>
          </li>
        ))}
      </ul>
      <p className="mt-6 text-center text-xs text-muted">
        Staff? <Link href="/staff/login" className="font-semibold text-brand">Sign in to the dashboard</Link>
      </p>
    </MobileShell>
  );
}

function SalonBlocker({ salon }: { salon: SalonSummary }) {
  if (!salon.is_open_now)
    return (
      <p className="mb-2 text-center text-sm text-muted">
        Closed now{salon.next_open_at ? ` · opens ${dayAndTime(salon.next_open_at)}` : ''}
      </p>
    );
  if (!salon.accepting_joins) return <p className="mb-2 text-center text-sm text-muted">The salon has paused new joins for now.</p>;
  if (!salon.e_walk_in_enabled)
    return <p className="mb-2 text-center text-sm text-muted">E Walk-In is switched off at this salon for now.</p>;
  if (salon.within_join_radius === false)
    return <p className="mb-2 text-center text-sm text-muted">You need to be near the salon to join its queue.</p>;
  return null;
}
