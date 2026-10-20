'use client';

import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useStaff } from '@/components/staff';
import { Card, cx, ErrorBox, Field, inputBase, Spinner } from '@/components/ui';
import { api, type S } from '@/lib/api';

type Report = S['AccuracyReport'];

function todayIST() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
}

export default function ReportPage() {
  const { slug, token } = useStaff();
  const [date, setDate] = useState(todayIST);
  const q = useQuery({
    queryKey: ['report', slug, date],
    queryFn: () => api<Report>(`/v1/dashboard/${slug}/reports/accuracy`, { token, query: { date } }),
  });
  const s = q.data?.summary;
  const err = s?.mean_abs_error_minutes;

  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold">How accurate were our waits?</h1>
          <p className="text-sm text-muted">Compares the start time each customer was shown when they joined with when they actually sat down.</p>
        </div>
        <Field label="Day">
          <input type="date" className={inputBase + ' h-11 w-44'} value={date} max={todayIST()} onChange={(e) => setDate(e.target.value)} />
        </Field>
      </div>
      <ErrorBox error={q.error} />
      {q.isLoading && (
        <div className="grid place-items-center py-10 text-muted">
          <Spinner />
        </div>
      )}
      {s && (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Stat label="Average gap" value={err === null || err === undefined ? '–' : `${err} min`} tone={err == null ? undefined : err <= 10 ? 'ok' : 'warn'} hint="Target: under 10 min" />
            <Stat label="Within 10 min" value={s.pct_within_10_min === null ? '–' : `${s.pct_within_10_min}%`} />
            <Stat label="Served" value={`${s.served} of ${s.joined}`} hint={`${s.via_app} joined from the app, ${s.via_e_walk_in} through E Walk-In`} />
            <Stat label="No-shows / left" value={`${s.no_shows} / ${s.left_queue}`} />
          </div>
          {s.mean_signed_error_minutes !== null && (
            <p className="text-sm text-muted">
              {s.mean_signed_error_minutes > 0
                ? `On average customers started ${s.mean_signed_error_minutes} min later than promised.`
                : s.mean_signed_error_minutes < 0
                  ? `On average customers started ${-s.mean_signed_error_minutes} min earlier than promised.`
                  : 'On average customers started right on time.'}{' '}
              Average actual wait: {s.mean_actual_wait_minutes ?? '–'} min.
            </p>
          )}
          <Card>
            <div className="border-b border-line px-4 py-3 font-semibold">By stylist</div>
            {q.data!.by_stylist.length === 0 ? (
              <div className="p-4 text-sm text-muted">Nobody served this day.</div>
            ) : (
              <table className="w-full text-sm">
                <thead className="text-left text-muted">
                  <tr>
                    <th className="px-4 py-2 font-medium">Stylist</th>
                    <th className="px-4 py-2 text-right font-medium">Served</th>
                    <th className="px-4 py-2 text-right font-medium">Average gap</th>
                    <th className="px-4 py-2 text-right font-medium">Vs booked time</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {q.data!.by_stylist.map((r) => (
                    <tr key={r.stylist_id}>
                      <td className="px-4 py-2.5 font-medium">{r.display_name}</td>
                      <td className="px-4 py-2.5 text-right tabular">{r.served}</td>
                      <td className="px-4 py-2.5 text-right tabular">{r.mean_abs_error_minutes ?? '–'} min</td>
                      <td className={cx('px-4 py-2.5 text-right tabular', (r.mean_overrun_minutes ?? 0) > 5 && 'font-semibold text-warn')}>
                        {r.mean_overrun_minutes === null
                          ? '–'
                          : r.mean_overrun_minutes >= 0
                            ? `${r.mean_overrun_minutes} min over`
                            : `${-r.mean_overrun_minutes} min under`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
          <p className="text-xs text-muted">
            If a stylist regularly runs over, raise their time for that service in Settings → Stylists. Estimates improve straight away.
          </p>
        </>
      )}
    </div>
  );
}

function Stat({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: 'ok' | 'warn' }) {
  return (
    <Card className="p-4">
      <div className="text-sm text-muted">{label}</div>
      <div className={cx('mt-1 text-2xl font-bold tabular', tone === 'ok' && 'text-ok', tone === 'warn' && 'text-warn')}>{value}</div>
      {hint && <div className="mt-0.5 text-xs text-muted">{hint}</div>}
    </Card>
  );
}
