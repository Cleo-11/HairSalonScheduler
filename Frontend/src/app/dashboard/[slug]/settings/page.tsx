'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { type SalonSettings, useStaff } from '@/components/staff';
import { Badge, Button, Card, Checkbox, cx, ErrorBox, Field, inputBase, inputClass, Notice, Sheet, Spinner } from '@/components/ui';
import { api, type S } from '@/lib/api';
import { rupees } from '@/lib/format';

type Tab = 'services' | 'stylists' | 'hours' | 'queue';
const TABS: { id: Tab; label: string }[] = [
  { id: 'services', label: 'Services' },
  { id: 'stylists', label: 'Stylists' },
  { id: 'hours', label: 'Opening hours' },
  { id: 'queue', label: 'Queue settings' },
];

export default function SettingsPage() {
  const { role } = useStaff();
  const [tab, setTab] = useState<Tab>('services');
  const readOnly = role !== 'owner';
  return (
    <div className="mx-auto max-w-4xl">
      <h1 className="text-xl font-bold">Settings</h1>
      {readOnly && (
        <Notice tone="neutral" className="mt-3">
          Only the owner can change these. You can pause new joins from the queue screen.
        </Notice>
      )}
      <div className="mt-4 flex gap-1 overflow-x-auto border-b border-line" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
            className={cx(
              '-mb-px whitespace-nowrap border-b-2 px-4 py-2.5 text-sm font-semibold',
              tab === t.id ? 'border-brand text-brand' : 'border-transparent text-muted hover:text-ink',
            )}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="mt-5">
        {tab === 'services' && <ServicesTab readOnly={readOnly} />}
        {tab === 'stylists' && <StylistsTab readOnly={readOnly} />}
        {tab === 'hours' && <HoursTab readOnly={readOnly} />}
        {tab === 'queue' && <QueueTab readOnly={readOnly} />}
      </div>
    </div>
  );
}

function useAdmin<T>(path: string, pick: (r: any) => T) {
  const { slug, token } = useStaff();
  return useQuery({ queryKey: ['admin', slug, path], queryFn: () => api<any>(`/v1/dashboard/${slug}${path}`, { token }).then(pick) });
}

function Loading() {
  return (
    <div className="grid place-items-center py-10 text-muted">
      <Spinner />
    </div>
  );
}

// ------------------------------------------------------------------ services

type AdminService = S['ServiceAdmin'];

function ServicesTab({ readOnly }: { readOnly: boolean }) {
  const q = useAdmin<AdminService[]>('/services', (r) => r.services);
  const [editing, setEditing] = useState<AdminService | 'new' | null>(null);
  if (q.isLoading) return <Loading />;
  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <p className="text-sm text-muted">The menu customers pick from. Hidden services stay in history but can&apos;t be booked.</p>
        {!readOnly && <Button onClick={() => setEditing('new')}>+ Add service</Button>}
      </div>
      <ErrorBox error={q.error} />
      <Card className="divide-y divide-line">
        {q.data?.map((s) => (
          <div key={s.id} className={cx('flex items-center gap-4 p-4', !s.is_active && 'opacity-60')}>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 font-semibold">
                {s.name} {!s.is_active && <Badge tone="off">Hidden</Badge>}
              </div>
              {s.description && <div className="text-sm text-muted">{s.description}</div>}
            </div>
            <div className="text-sm text-muted tabular">{s.default_minutes} min</div>
            <div className="w-20 text-right font-semibold tabular">{rupees(s.price_paise)}</div>
            {!readOnly && (
              <Button size="sm" variant="ghost" onClick={() => setEditing(s)}>
                Edit
              </Button>
            )}
          </div>
        ))}
      </Card>
      {editing && <ServiceForm service={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function ServiceForm({ service, onClose }: { service: AdminService | null; onClose: () => void }) {
  const { call, slug } = useStaff();
  const qc = useQueryClient();
  const [f, setF] = useState({
    name: service?.name ?? '',
    description: service?.description ?? '',
    price: service ? String(service.price_paise / 100) : '',
    minutes: service ? String(service.default_minutes) : '30',
    is_active: service?.is_active ?? true,
  });
  const [busy, setBusy] = useState(false);
  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    const body = {
      name: f.name.trim(),
      description: f.description.trim() || null,
      price_paise: Math.round(Number(f.price) * 100),
      default_minutes: Number(f.minutes),
      is_active: f.is_active,
    };
    const r = service
      ? await call(`/services/${service.id}`, { method: 'PATCH', body, success: 'Service saved' })
      : await call('/services', { body, success: 'Service added' });
    setBusy(false);
    if (r) {
      qc.invalidateQueries({ queryKey: ['admin', slug] });
      qc.invalidateQueries({ queryKey: ['services', slug] });
      onClose();
    }
  }
  return (
    <Sheet open onClose={onClose} title={service ? 'Edit service' : 'New service'}>
      <form onSubmit={save} className="space-y-4">
        <Field label="Name">
          <input className={inputClass} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required />
        </Field>
        <Field label="Description (optional)">
          <input className={inputClass} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Price (₹)">
            <input className={inputClass} inputMode="decimal" value={f.price} onChange={(e) => setF({ ...f, price: e.target.value })} required />
          </Field>
          <Field label="Usual time (min)" hint="Each stylist can have their own.">
            <input className={inputClass} type="number" min={1} max={600} value={f.minutes} onChange={(e) => setF({ ...f, minutes: e.target.value })} required />
          </Field>
        </div>
        <label className="flex items-center gap-3 text-sm">
          <input type="checkbox" className="size-4 accent-[var(--brand)]" checked={f.is_active} onChange={(e) => setF({ ...f, is_active: e.target.checked })} />
          Show on the menu
        </label>
        {!service && <p className="text-xs text-muted">New services are offered by every stylist. Change that in the Stylists tab.</p>}
        <Button type="submit" className="w-full" loading={busy}>
          Save
        </Button>
      </form>
    </Sheet>
  );
}

// ------------------------------------------------------------------ stylists

type AdminStylist = S['StylistAdmin'];

function StylistsTab({ readOnly }: { readOnly: boolean }) {
  const stylists = useAdmin<AdminStylist[]>('/stylists', (r) => r.stylists);
  const services = useAdmin<AdminService[]>('/services', (r) => r.services);
  const [editing, setEditing] = useState<AdminStylist | null>(null);
  const [adding, setAdding] = useState(false);
  if (stylists.isLoading || services.isLoading) return <Loading />;
  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <p className="text-sm text-muted">Who does what, and how long each stylist takes.</p>
        {!readOnly && <Button onClick={() => setAdding(true)}>+ Add stylist</Button>}
      </div>
      <ErrorBox error={stylists.error} />
      <div className="grid gap-3 sm:grid-cols-2">
        {stylists.data?.map((st) => (
          <Card key={st.id} className={cx('p-4', !st.is_active && 'opacity-60')}>
            <div className="flex items-center justify-between">
              <div className="font-semibold">
                {st.display_name} {!st.is_active && <Badge tone="off">Inactive</Badge>}
              </div>
              {!readOnly && (
                <Button size="sm" variant="ghost" onClick={() => setEditing(st)}>
                  Edit
                </Button>
              )}
            </div>
            <ul className="mt-2 space-y-1 text-sm">
              {st.services.map((s) => (
                <li key={s.service_id} className="flex justify-between gap-2">
                  <span className="text-muted">{s.name}</span>
                  <span className={cx('tabular', s.custom_minutes !== null && 'font-semibold')}>
                    {s.effective_minutes} min{s.custom_minutes !== null && s.custom_minutes !== s.default_minutes ? ' ★' : ''}
                  </span>
                </li>
              ))}
              {st.services.length === 0 && <li className="text-muted">No services yet</li>}
            </ul>
          </Card>
        ))}
      </div>
      <p className="mt-3 text-xs text-muted">★ = this stylist&apos;s own time, different from the usual.</p>
      {editing && services.data && <StylistForm stylist={editing} services={services.data} onClose={() => setEditing(null)} />}
      {adding && services.data && <NewStylist services={services.data} onClose={() => setAdding(false)} />}
    </div>
  );
}

function StylistForm({ stylist, services, onClose }: { stylist: AdminStylist; services: AdminService[]; onClose: () => void }) {
  const { call, slug } = useStaff();
  const qc = useQueryClient();
  const [name, setName] = useState(stylist.display_name);
  const [active, setActive] = useState(stylist.is_active);
  const [offer, setOffer] = useState<Record<string, string | null>>(() =>
    Object.fromEntries(stylist.services.map((s) => [s.service_id, s.custom_minutes === null ? '' : String(s.custom_minutes)])),
  );
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    const ok1 =
      name !== stylist.display_name || active !== stylist.is_active
        ? await call(`/stylists/${stylist.id}`, { method: 'PATCH', body: { display_name: name.trim(), is_active: active } })
        : true;
    const ok2 = ok1
      ? await call(`/stylists/${stylist.id}/services`, {
          method: 'PUT',
          body: {
            services: Object.entries(offer).map(([service_id, m]) => ({ service_id, custom_minutes: m ? Number(m) : null })),
          },
          success: 'Stylist saved',
        })
      : null;
    setBusy(false);
    qc.invalidateQueries({ queryKey: ['admin', slug] });
    if (ok2) onClose();
  }

  return (
    <Sheet open onClose={onClose} title={`Edit ${stylist.display_name}`} wide>
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Name shown to customers">
            <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <label className="flex items-end gap-3 pb-3 text-sm">
            <input type="checkbox" className="size-4 accent-[var(--brand)]" checked={active} onChange={(e) => setActive(e.target.checked)} />
            Active (works at this salon)
          </label>
        </div>
        <div>
          <div className="mb-1.5 text-sm font-medium">Services and their time</div>
          <div className="divide-y divide-line rounded-xl border border-line">
            {services.map((s) => {
              const on = s.id in offer;
              return (
                <div key={s.id} className="flex items-center gap-3 p-3">
                  <button
                    type="button"
                    className="flex flex-1 items-center gap-3 text-left"
                    onClick={() =>
                      setOffer((o) => {
                        const n = { ...o };
                        if (on) delete n[s.id];
                        else n[s.id] = '';
                        return n;
                      })
                    }
                    aria-pressed={on}
                  >
                    <Checkbox checked={on} />
                    <span className="text-sm font-medium">{s.name}</span>
                  </button>
                  {on && (
                    <input
                      aria-label={`${s.name} minutes`}
                      className={inputBase + ' h-9 w-24 text-right'}
                      type="number"
                      min={1}
                      max={600}
                      placeholder={String(s.default_minutes)}
                      value={offer[s.id] ?? ''}
                      onChange={(e) => setOffer((o) => ({ ...o, [s.id]: e.target.value }))}
                    />
                  )}
                  {on && <span className="w-8 text-xs text-muted">min</span>}
                </div>
              );
            })}
          </div>
          <p className="mt-1.5 text-xs text-muted">Leave the time empty to use the usual time. Waiting customers are updated straight away.</p>
        </div>
        <Button className="w-full" loading={busy} onClick={save}>
          Save
        </Button>
      </div>
    </Sheet>
  );
}

function NewStylist({ services, onClose }: { services: AdminService[]; onClose: () => void }) {
  const { call, slug } = useStaff();
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  return (
    <Sheet open onClose={onClose} title="New stylist">
      <form
        className="space-y-4"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          const r = await call('/stylists', { body: { display_name: name.trim(), service_ids: picked }, success: `${name.trim()} added` });
          setBusy(false);
          qc.invalidateQueries({ queryKey: ['admin', slug] });
          if (r) onClose();
        }}
      >
        <Field label="Name shown to customers">
          <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
        </Field>
        <div className="grid gap-2">
          {services
            .filter((s) => s.is_active)
            .map((s) => {
              const on = picked.includes(s.id);
              return (
                <button
                  type="button"
                  key={s.id}
                  onClick={() => setPicked((p) => (on ? p.filter((x) => x !== s.id) : [...p, s.id]))}
                  className="flex items-center gap-3 rounded-xl border border-line p-3 text-left text-sm"
                >
                  <Checkbox checked={on} /> {s.name}
                </button>
              );
            })}
        </div>
        <p className="text-xs text-muted">New stylists start as &quot;Off&quot;. Start their shift from the queue screen.</p>
        <Button type="submit" className="w-full" loading={busy} disabled={!name.trim()}>
          Add stylist
        </Button>
      </form>
    </Sheet>
  );
}

// ------------------------------------------------------------------ hours

type Interval = { weekday: number; opens: string; closes: string };
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const ORDER = [1, 2, 3, 4, 5, 6, 0];

interface DayForm {
  open: boolean;
  opens: string;
  closes: string;
  hasBreak: boolean;
  breakStart: string;
  breakEnd: string;
}

function toForm(hours: Interval[]): Record<number, DayForm> {
  const out: Record<number, DayForm> = {};
  for (let d = 0; d < 7; d++) {
    const iv = hours.filter((h) => h.weekday === d).sort((a, b) => a.opens.localeCompare(b.opens));
    out[d] = iv.length
      ? {
          open: true,
          opens: iv[0]!.opens,
          closes: iv.at(-1)!.closes,
          hasBreak: iv.length > 1,
          breakStart: iv.length > 1 ? iv[0]!.closes : '14:00',
          breakEnd: iv.length > 1 ? iv[1]!.opens : '15:00',
        }
      : { open: false, opens: '10:00', closes: '21:00', hasBreak: false, breakStart: '14:00', breakEnd: '15:00' };
  }
  return out;
}

function fromForm(f: Record<number, DayForm>): Interval[] {
  const out: Interval[] = [];
  for (let d = 0; d < 7; d++) {
    const x = f[d]!;
    if (!x.open) continue;
    if (x.hasBreak) {
      out.push({ weekday: d, opens: x.opens, closes: x.breakStart }, { weekday: d, opens: x.breakEnd, closes: x.closes });
    } else out.push({ weekday: d, opens: x.opens, closes: x.closes });
  }
  return out;
}

function HoursTab({ readOnly }: { readOnly: boolean }) {
  const { call, slug } = useStaff();
  const qc = useQueryClient();
  const q = useAdmin<{ hours: Interval[]; holidays: { date: string; note: string | null }[]; timezone: string }>('/hours', (r) => r);
  const [form, setForm] = useState<Record<number, DayForm> | null>(null);
  const [busy, setBusy] = useState(false);
  const [hol, setHol] = useState({ date: '', note: '' });
  useEffect(() => {
    if (q.data && !form) setForm(toForm(q.data.hours));
  }, [q.data, form]);
  if (q.isLoading || !form) return <Loading />;
  const set = (d: number, patch: Partial<DayForm>) => setForm({ ...form, [d]: { ...form[d]!, ...patch } });
  const refresh = () => qc.invalidateQueries({ queryKey: ['admin', slug, '/hours'] });

  return (
    <div className="space-y-6">
      <Card className="divide-y divide-line">
        {ORDER.map((d) => {
          const x = form[d]!;
          return (
            <div key={d} className="flex flex-wrap items-center gap-3 p-4">
              <label className="flex w-36 items-center gap-2 font-medium">
                <input type="checkbox" className="size-4 accent-[var(--brand)]" disabled={readOnly} checked={x.open} onChange={(e) => set(d, { open: e.target.checked })} />
                {DAYS[d]}
              </label>
              {x.open ? (
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <TimeInput value={x.opens} onChange={(v) => set(d, { opens: v })} disabled={readOnly} label={`${DAYS[d]} opens`} />
                  <span className="text-muted">to</span>
                  <TimeInput value={x.closes} onChange={(v) => set(d, { closes: v })} disabled={readOnly} label={`${DAYS[d]} closes`} />
                  <label className="ml-2 flex items-center gap-2 text-muted">
                    <input type="checkbox" className="size-4 accent-[var(--brand)]" disabled={readOnly} checked={x.hasBreak} onChange={(e) => set(d, { hasBreak: e.target.checked })} />
                    Break
                  </label>
                  {x.hasBreak && (
                    <>
                      <TimeInput value={x.breakStart} onChange={(v) => set(d, { breakStart: v })} disabled={readOnly} label="Break starts" />
                      <span className="text-muted">–</span>
                      <TimeInput value={x.breakEnd} onChange={(v) => set(d, { breakEnd: v })} disabled={readOnly} label="Break ends" />
                    </>
                  )}
                </div>
              ) : (
                <span className="text-sm text-muted">Closed</span>
              )}
            </div>
          );
        })}
      </Card>
      {!readOnly && (
        <div className="flex justify-end">
          <Button
            loading={busy}
            onClick={async () => {
              setBusy(true);
              await call('/hours', { method: 'PUT', body: { hours: fromForm(form) }, success: 'Opening hours saved' });
              setBusy(false);
              refresh();
            }}
          >
            Save hours
          </Button>
        </div>
      )}

      <div>
        <h3 className="mb-2 font-semibold">Holidays</h3>
        <Card className="divide-y divide-line">
          {q.data?.holidays.length === 0 && <div className="p-4 text-sm text-muted">No upcoming holidays.</div>}
          {q.data?.holidays.map((h) => (
            <div key={h.date} className="flex items-center justify-between p-4 text-sm">
              <span>
                <span className="font-medium">
                  {new Date(h.date + 'T00:00:00').toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })}
                </span>
                {h.note && <span className="text-muted"> · {h.note}</span>}
              </span>
              {!readOnly && (
                <Button size="sm" variant="ghost" onClick={async () => (await call(`/holidays/${h.date}`, { method: 'DELETE', success: 'Holiday removed' }), refresh())}>
                  Remove
                </Button>
              )}
            </div>
          ))}
        </Card>
        {!readOnly && (
          <form
            className="mt-3 flex flex-wrap items-end gap-2"
            onSubmit={async (e) => {
              e.preventDefault();
              const r = await call('/holidays', { body: { date: hol.date, note: hol.note || null }, success: 'Holiday added' });
              if (r) setHol({ date: '', note: '' });
              refresh();
            }}
          >
            <Field label="Date">
              <input className={inputClass} type="date" value={hol.date} onChange={(e) => setHol({ ...hol, date: e.target.value })} required />
            </Field>
            <Field label="Note (optional)">
              <input className={inputClass} placeholder="Diwali" value={hol.note} onChange={(e) => setHol({ ...hol, note: e.target.value })} />
            </Field>
            <Button type="submit" variant="secondary">
              Add holiday
            </Button>
          </form>
        )}
      </div>
    </div>
  );
}

function TimeInput({ value, onChange, disabled, label }: { value: string; onChange: (v: string) => void; disabled?: boolean; label: string }) {
  return (
    <input
      aria-label={label}
      type="time"
      step={900}
      className={inputBase + ' h-9 w-32'}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

// ------------------------------------------------------------------ queue settings

function QueueTab({ readOnly }: { readOnly: boolean }) {
  const { call, slug, settings } = useStaff();
  const qc = useQueryClient();
  const [f, setF] = useState<SalonSettings | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (settings && !f) setF(settings);
  }, [settings, f]);
  if (!f) return <Loading />;
  const num = (k: keyof SalonSettings) => ({
    value: f[k] === null ? '' : String(f[k]),
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value === '' ? null : Number(e.target.value) }),
    disabled: readOnly,
    className: inputClass,
    type: 'number',
  });
  return (
    <form
      className="space-y-5"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        await call('/settings', {
          method: 'PATCH',
          body: {
            name: f.name,
            address: f.address,
            phone: f.phone || null,
            buffer_minutes: f.buffer_minutes,
            noshow_grace_minutes: f.noshow_grace_minutes,
            noshow_policy: f.noshow_policy,
            turn_alert_minutes: f.turn_alert_minutes,
            join_radius_m: f.join_radius_m,
          },
          success: 'Settings saved',
        });
        setBusy(false);
        qc.invalidateQueries({ queryKey: ['settings', slug] });
      }}
    >
      <Card className="grid gap-4 p-5 sm:grid-cols-2">
        <Field label="Salon name">
          <input className={inputClass} value={f.name} disabled={readOnly} onChange={(e) => setF({ ...f, name: e.target.value })} />
        </Field>
        <Field label="Phone">
          <input className={inputClass} value={f.phone ?? ''} disabled={readOnly} onChange={(e) => setF({ ...f, phone: e.target.value })} />
        </Field>
        <div className="sm:col-span-2">
          <Field label="Address">
            <input className={inputClass} value={f.address} disabled={readOnly} onChange={(e) => setF({ ...f, address: e.target.value })} />
          </Field>
        </div>
      </Card>
      <Card className="grid gap-4 p-5 sm:grid-cols-2">
        <Field label="Gap between customers (min)" hint="Cleanup and payment time added after each service.">
          <input {...num('buffer_minutes')} min={0} max={60} />
        </Field>
        <Field label="WhatsApp alert (min before turn)" hint="0 turns the alert off.">
          <input {...num('turn_alert_minutes')} min={0} max={120} />
        </Field>
        <Field label="No-show grace period (min)" hint="Time a called customer has to reach the chair.">
          <input {...num('noshow_grace_minutes')} min={1} max={60} />
        </Field>
        <Field label="When someone doesn't come">
          <select
            className={inputClass}
            disabled={readOnly}
            value={f.noshow_policy}
            onChange={(e) => setF({ ...f, noshow_policy: e.target.value as SalonSettings['noshow_policy'] })}
          >
            <option value="requeue_once">Send to the back once, then mark no-show</option>
            <option value="mark_no_show">Mark no-show straight away</option>
          </select>
        </Field>
        <Field label="Join radius (metres)" hint="Customers further away can't join from the app. Empty = no limit.">
          <input {...num('join_radius_m')} min={50} max={100000} />
        </Field>
      </Card>
      {!readOnly && (
        <div className="flex justify-end">
          <Button type="submit" loading={busy}>
            Save settings
          </Button>
        </div>
      )}
    </form>
  );
}
