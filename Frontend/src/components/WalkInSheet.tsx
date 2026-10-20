'use client';

import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api, type Service, type StylistCard } from '@/lib/api';
import { minutes, rupees, waitRange } from '@/lib/format';
import { useStaff } from './staff';
import { Button, Checkbox, cx, Field, inputClass, Sheet, StylistStatusBadge } from './ui';

export function WalkInSheet({ onClose }: { onClose: () => void }) {
  const { slug, call } = useStaff();
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [stylist, setStylist] = useState<string>('any');
  const [busy, setBusy] = useState(false);

  const services = useQuery({
    queryKey: ['services', slug],
    queryFn: () => api<{ services: Service[] }>(`/v1/salons/${slug}/services`).then((r) => r.services),
  });
  const quotes = useQuery({
    queryKey: ['stylists', slug, picked.join(',')],
    enabled: picked.length > 0,
    queryFn: () =>
      api<{ stylists: StylistCard[]; any_available: { stylist_id: string; wait_range_minutes: { low: number; high: number } } | null }>(
        `/v1/salons/${slug}/stylists`,
        { query: { service_ids: picked.join(',') } },
      ),
  });

  const chosen = (services.data ?? []).filter((s) => picked.includes(s.id));
  const anyName = quotes.data?.any_available ? quotes.data.stylists.find((s) => s.id === quotes.data!.any_available!.stylist_id)?.display_name : null;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    const r = await call('/walk-ins', {
      body: { name: name.trim(), phone: phone.trim() || null, service_ids: picked, stylist_id: stylist === 'any' ? null : stylist },
      success: `${name.trim()} added to the queue`,
    });
    setBusy(false);
    if (r) onClose();
  }

  return (
    <Sheet open onClose={onClose} title="Add a walk-in" wide>
      <form onSubmit={submit} className="space-y-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name">
            <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} required autoFocus maxLength={80} />
          </Field>
          <Field label="Mobile (optional)" hint="Adds WhatsApp alerts and links their app account.">
            <input className={inputClass} inputMode="tel" placeholder="98765 43210" value={phone} onChange={(e) => setPhone(e.target.value)} />
          </Field>
        </div>

        <div>
          <div className="mb-1.5 text-sm font-medium">Services</div>
          <div className="grid gap-2 sm:grid-cols-2">
            {services.data?.map((s) => {
              const on = picked.includes(s.id);
              return (
                <button
                  type="button"
                  key={s.id}
                  onClick={() => setPicked((p) => (on ? p.filter((x) => x !== s.id) : [...p, s.id]))}
                  className={cx('flex items-center gap-3 rounded-xl border p-3 text-left', on ? 'border-brand bg-brand-soft/40' : 'border-line')}
                  aria-pressed={on}
                >
                  <Checkbox checked={on} />
                  <span className="flex-1 text-sm font-medium">{s.name}</span>
                  <span className="text-sm text-muted tabular">{rupees(s.price_paise)}</span>
                </button>
              );
            })}
          </div>
        </div>

        {picked.length > 0 && (
          <div>
            <div className="mb-1.5 text-sm font-medium">Stylist</div>
            <div className="grid gap-2 sm:grid-cols-2">
              <StylistOption selected={stylist === 'any'} onClick={() => setStylist('any')}>
                <span className="font-semibold">Any available</span>
                <span className="text-sm text-muted">
                  {quotes.data?.any_available ? `${waitRange(quotes.data.any_available.wait_range_minutes)} · ${anyName}` : 'Nobody free for these'}
                </span>
              </StylistOption>
              {quotes.data?.stylists.map((s) => (
                <StylistOption key={s.id} selected={stylist === s.id} disabled={!s.available} onClick={() => setStylist(s.id)}>
                  <span className="flex items-center justify-between gap-2">
                    <span className="font-semibold">{s.display_name}</span>
                    <StylistStatusBadge status={s.status} />
                  </span>
                  <span className="text-sm text-muted">
                    {s.available ? `${waitRange(s.wait_range_minutes)} · ${minutes(s.minutes ?? 0)}` : 'Not working'}
                  </span>
                </StylistOption>
              ))}
            </div>
          </div>
        )}

        <div className="flex items-center justify-between gap-3 border-t border-line pt-4">
          <div className="text-sm text-muted">
            {chosen.length
              ? `${chosen.length} service${chosen.length > 1 ? 's' : ''} · ${rupees(chosen.reduce((a, s) => a + s.price_paise, 0))}`
              : 'Pick at least one service'}
          </div>
          <Button type="submit" disabled={!name.trim() || !picked.length} loading={busy}>
            Add to queue
          </Button>
        </div>
      </form>
    </Sheet>
  );
}

function StylistOption({ selected, disabled, onClick, children }: { selected: boolean; disabled?: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      aria-pressed={selected}
      className={cx(
        'flex flex-col gap-0.5 rounded-xl border p-3 text-left disabled:opacity-50',
        selected && !disabled ? 'border-brand ring-2 ring-brand/20' : 'border-line',
      )}
    >
      {children}
    </button>
  );
}
