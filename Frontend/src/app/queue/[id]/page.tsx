'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { CustomerMenu } from '@/components/CustomerMenu';
import { EWalkInHero } from '@/components/EWalkIn';
import { Button, Card, cx, ErrorBox, FullPageSpinner, LiveIndicator, MobileShell, Sheet } from '@/components/ui';
import { WaitDisplay } from '@/components/WaitDisplay';
import { api, type CustomerEntry, isApiError } from '@/lib/api';
import { minutes, plural, rupees, time } from '@/lib/format';
import { useNow, useSalonEvents } from '@/lib/hooks';
import { customerSession, useCustomerSession } from '@/lib/session';

export default function QueueStatusPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const session = useCustomerSession();
  const qc = useQueryClient();
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [leaveError, setLeaveError] = useState<unknown>(null);

  useEffect(() => {
    if (session === null) router.replace(`/login?next=/queue/${id}`);
  }, [session, router, id]);

  const key = ['entry', id];
  const q = useQuery({
    queryKey: key,
    enabled: !!session,
    queryFn: () => api<{ entry: CustomerEntry }>(`/v1/queue/${id}`, { token: session!.token }).then((r) => r.entry),
    refetchInterval: 30_000, // estimates move with the clock, even when nothing else happens
  });
  const e = q.data;
  const active = e && ['waiting', 'called', 'in_service'].includes(e.status);
  const live = useSalonEvents(active ? e.salon.slug : null, [key]);

  useEffect(() => {
    if (isApiError(q.error) && q.error.status === 401) {
      customerSession.set(null);
      router.replace(`/login?next=/queue/${id}`);
    }
  }, [q.error, router, id]);

  async function leave() {
    if (!session) return;
    setLeaving(true);
    setLeaveError(null);
    try {
      const { entry } = await api<{ entry: CustomerEntry }>(`/v1/queue/${id}/leave`, { method: 'POST', token: session.token });
      qc.setQueryData(key, entry);
      setConfirmLeave(false);
    } catch (err) {
      setLeaveError(err);
    } finally {
      setLeaving(false);
    }
  }

  if (!session || (q.isLoading && !e)) return <FullPageSpinner />;
  if (!e)
    return (
      <MobileShell back="/salons" title="Queue">
        <ErrorBox error={q.error} />
      </MobileShell>
    );

  return (
    <MobileShell
      title={e.salon.name}
      right={
        <div className="flex items-center gap-3">
          {active && <LiveIndicator state={live} />}
          <CustomerMenu />
        </div>
      }
    >
      <StatusHero entry={e} />

      <Card className="mt-4 divide-y divide-line">
        <Row label="Stylist">
          {e.stylist.display_name}
          {e.e_walk_in ? (
            <span className="ml-1 text-muted">{e.any_stylist ? '(assigned for you)' : '(your choice)'}</span>
          ) : (
            e.any_stylist && <span className="ml-1 text-muted">(first available)</span>
          )}
        </Row>
        <Row label="Services">
          <ul className="text-right">
            {e.services.map((s) => (
              <li key={s.service_id}>{s.name}</li>
            ))}
          </ul>
        </Row>
        <Row label="Time">about {minutes(e.total_minutes)}</Row>
        <Row label="Price">
          {rupees(e.total_price_paise)} <span className="text-muted">· pay at the salon</span>
        </Row>
        <Row label="Salon">{e.salon.name}</Row>
      </Card>

      {e.status === 'waiting' && (
        <p className="mt-4 flex items-start gap-2 rounded-xl bg-surface-2 px-4 py-3 text-sm text-muted">
          <span aria-hidden>💬</span>
          We&apos;ll WhatsApp you when you&apos;re about 10 minutes away, so you can step out for a bit.
        </p>
      )}

      {(e.status === 'waiting' || e.status === 'called') && (
        <div className="mt-6 text-center">
          <Button variant="danger" onClick={() => setConfirmLeave(true)}>
            Leave the queue
          </Button>
        </div>
      )}

      {!active && (
        <div className="mt-6">
          <Link href={`/s/${e.salon.slug}`}>
            <Button variant="secondary" size="lg" className="w-full">
              {e.status === 'done' ? 'Book another visit' : 'Join again'}
            </Button>
          </Link>
        </div>
      )}

      <Sheet open={confirmLeave} onClose={() => setConfirmLeave(false)} title="Leave the queue?">
        <p className="text-muted">You&apos;ll lose your place. If you come back, you&apos;ll join at the end of the line.</p>
        <ErrorBox error={leaveError} className="mt-3" />
        <div className="mt-5 grid grid-cols-2 gap-3">
          <Button variant="secondary" onClick={() => setConfirmLeave(false)}>
            Stay in queue
          </Button>
          <Button variant="danger" loading={leaving} onClick={leave}>
            Leave
          </Button>
        </div>
      </Sheet>
    </MobileShell>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 px-4 py-3 text-sm">
      <span className="text-muted">{label}</span>
      <span className="text-right font-medium">{children}</span>
    </div>
  );
}

function StatusHero({ entry: e }: { entry: CustomerEntry }) {
  const now = useNow(1000);

  if (e.status === 'called') {
    const deadline = e.called_at ? new Date(e.called_at).getTime() + e.noshow_grace_minutes * 60_000 : null;
    const left = deadline ? Math.max(0, Math.round((deadline - now) / 1000)) : null;
    return (
      <Card className="border-accent bg-accent-soft p-6 text-center">
        <div className="text-4xl" aria-hidden>
          🔔
        </div>
        <h1 className="mt-3 text-2xl font-bold text-accent">{e.stylist.display_name} is ready for you</h1>
        <p className="mt-2 text-ink">Please come to the chair.</p>
        {left !== null && (
          <p className="mt-4 text-sm text-muted">
            Please come in within{' '}
            <span className="font-bold tabular text-ink">
              {Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')}
            </span>{' '}
            or your turn may move back.
          </p>
        )}
      </Card>
    );
  }

  if (e.status === 'in_service') {
    return (
      <Hero icon="✂️" title="You're in the chair">
        {e.est_end_at ? `Should be done around ${time(e.est_end_at)}.` : 'Enjoy!'}
      </Hero>
    );
  }
  if (e.status === 'done') return <Hero icon="✨" title="All done, thank you!">Hope you love it. See you next time.</Hero>;
  if (e.status === 'left') return <Hero icon="👋" title="You left the queue">Your place has been given to the next person.</Hero>;
  if (e.status === 'no_show')
    return <Hero icon="⌛" title="We missed you">You weren&apos;t there when called, so your turn was given away. You can join again.</Hero>;
  if (e.status === 'cancelled') return <Hero icon="🚫" title="Removed from the queue">The salon removed this visit. Please ask at the desk.</Hero>;

  // waiting
  if (!e.stylist_available) {
    return (
      <Card className="bg-warn-soft p-6 text-center">
        <div className="text-4xl" aria-hidden>
          ⏸️
        </div>
        <h1 className="mt-3 text-xl font-bold">{e.stylist.display_name} isn&apos;t available any more</h1>
        <p className="mt-2 text-sm">The desk will move you to another stylist. You keep your place; we&apos;ll update this screen.</p>
      </Card>
    );
  }
  if (e.e_walk_in) {
    return <EWalkInHero waitRange={e.wait_range_minutes ?? null} startAt={e.est_start_at} peopleAhead={e.people_ahead ?? 0} />;
  }
  const next = e.people_ahead === 0;
  return (
    <Card className={cx('p-6 text-center', next && 'border-brand bg-brand-soft/50')}>
      <div className="text-sm font-semibold uppercase tracking-wide text-muted">{next ? "You're next" : 'Your wait'}</div>
      <div className="mt-2">
        <WaitDisplay range={e.wait_range_minutes} startAt={e.est_start_at} size="xl" />
      </div>
      <div className="mt-4 inline-flex items-center gap-2 rounded-full bg-surface-2 px-3 py-1.5 text-sm font-medium">
        {next ? 'Nobody ahead of you' : `${plural(e.people_ahead ?? 0, 'client')} ahead of you`}
      </div>
      {next && <p className="mt-3 text-sm text-muted">Please stay close. You&apos;ll be called soon.</p>}
    </Card>
  );
}

function Hero({ icon, title, children }: { icon: string; title: string; children: React.ReactNode }) {
  return (
    <Card className="p-6 text-center">
      <div className="text-4xl" aria-hidden>
        {icon}
      </div>
      <h1 className="mt-3 text-2xl font-bold">{title}</h1>
      <p className="mt-2 text-muted">{children}</p>
    </Card>
  );
}
