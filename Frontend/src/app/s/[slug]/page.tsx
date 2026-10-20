'use client';

import { useQuery } from '@tanstack/react-query';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { CustomerMenu } from '@/components/CustomerMenu';
import { Badge, Button, Card, Checkbox, cx, ErrorBox, MobileShell, Notice, Spinner } from '@/components/ui';
import { api, type SalonDetail, type Service } from '@/lib/api';
import { dayAndTime, minutes, plural, rupees } from '@/lib/format';

const pickKey = (slug: string) => `kataar.services.${slug}`;

export default function ServicesPage() {
  const { slug } = useParams<{ slug: string }>();
  const router = useRouter();
  const salon = useQuery({
    queryKey: ['salon', slug],
    queryFn: () => api<{ salon: SalonDetail }>(`/v1/salons/${slug}`).then((r) => r.salon),
  });
  const services = useQuery({
    queryKey: ['services', slug],
    queryFn: () => api<{ services: Service[] }>(`/v1/salons/${slug}/services`).then((r) => r.services),
  });

  const [picked, setPicked] = useState<string[]>([]);
  useEffect(() => {
    try {
      const saved = JSON.parse(sessionStorage.getItem(pickKey(slug)) ?? '[]');
      if (Array.isArray(saved)) setPicked(saved);
    } catch {
      /* ignore */
    }
  }, [slug]);
  useEffect(() => {
    try {
      sessionStorage.setItem(pickKey(slug), JSON.stringify(picked));
    } catch {
      /* ignore */
    }
  }, [slug, picked]);

  const chosen = useMemo(() => (services.data ?? []).filter((s) => picked.includes(s.id)), [services.data, picked]);
  const totalMin = chosen.reduce((a, s) => a + s.default_minutes, 0);
  const totalPrice = chosen.reduce((a, s) => a + s.price_paise, 0);
  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  const s = salon.data;

  return (
    <MobileShell
      back="/salons"
      title={s?.name ?? 'Services'}
      right={<CustomerMenu />}
      footer={
        <div className="flex items-center gap-3">
          <div className="min-w-0 flex-1">
            {chosen.length ? (
              <>
                <div className="text-sm font-semibold">{plural(chosen.length, 'service')} · about {minutes(totalMin)}</div>
                <div className="text-sm text-muted">{rupees(totalPrice)} · pay at the salon</div>
              </>
            ) : (
              <div className="text-sm text-muted">Choose one or more services</div>
            )}
          </div>
          <Button
            size="lg"
            disabled={!chosen.length || (s ? !s.accepting_joins || !s.e_walk_in_enabled : false)}
            onClick={() => router.push(`/s/${slug}/stylist?services=${picked.join(',')}`)}
          >
            Continue
          </Button>
        </div>
      }
    >
      <ErrorBox error={salon.error ?? services.error} />
      {s && (
        <div className="mb-4">
          <div className="text-sm text-muted">{s.address}</div>
          {!s.is_open_now ? (
            <Notice tone="off" className="mt-3" title="The salon is closed right now">
              {s.next_open_at ? `Opens ${dayAndTime(s.next_open_at, s.timezone)}. You can look at the menu meanwhile.` : 'Check back later.'}
            </Notice>
          ) : s.joins_paused ? (
            <Notice tone="warn" className="mt-3" title="Not taking new customers right now">
              The desk has paused the queue for a bit. Try again shortly.
            </Notice>
          ) : !s.e_walk_in_enabled ? (
            <Notice tone="warn" className="mt-3" title="E Walk-In is switched off right now">
              The desk isn&apos;t taking E Walk-In clients at the moment. Please check at the salon.
            </Notice>
          ) : null}
        </div>
      )}
      <h1 className="text-xl font-bold">What would you like today?</h1>
      {services.isLoading && (
        <div className="grid place-items-center py-10 text-muted">
          <Spinner />
        </div>
      )}
      <ul className="mt-4 space-y-2.5">
        {services.data?.map((sv) => {
          const on = picked.includes(sv.id);
          return (
            <li key={sv.id}>
              <button className="w-full text-left" onClick={() => toggle(sv.id)} aria-pressed={on}>
                <Card className={cx('flex items-center gap-3 p-4 transition-colors', on && 'border-brand bg-brand-soft/40')}>
                  <Checkbox checked={on} />
                  <div className="min-w-0 flex-1">
                    <div className="font-semibold">{sv.name}</div>
                    {sv.description && <div className="mt-0.5 text-sm text-muted">{sv.description}</div>}
                    <div className="mt-1.5">
                      <Badge>about {minutes(sv.default_minutes)}</Badge>
                    </div>
                  </div>
                  <div className="shrink-0 font-semibold tabular">{rupees(sv.price_paise)}</div>
                </Card>
              </button>
            </li>
          );
        })}
      </ul>
    </MobileShell>
  );
}
