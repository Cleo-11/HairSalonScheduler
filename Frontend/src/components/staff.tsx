'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { createContext, type ReactNode, useCallback, useContext, useEffect, useState } from 'react';
import { api, isApiError, type Role, type S } from '@/lib/api';
import { time } from '@/lib/format';
import { staffSession, useStaffSession } from '@/lib/session';
import { cx, FullPageSpinner, Logo } from './ui';

export type SalonSettings = S['SalonSettings'];

interface StaffCtx {
  token: string;
  slug: string;
  role: Role;
  stylistId: string | null;
  staffName: string;
  settings: SalonSettings | undefined;
  /** Run a dashboard call, refresh the dashboard, and toast on failure. */
  call: <T = unknown>(path: string, opts?: { method?: 'POST' | 'PUT' | 'PATCH' | 'DELETE'; body?: unknown; success?: string }) => Promise<T | null>;
  toast: (msg: string, tone?: 'ok' | 'error') => void;
}

const Ctx = createContext<StaffCtx | null>(null);
export const useStaff = () => {
  const c = useContext(Ctx);
  if (!c) throw new Error('useStaff outside StaffShell');
  return c;
};

export const canDesk = (role: Role) => role === 'owner' || role === 'receptionist';

/** Guards dashboard pages: requires a staff session with a membership in this salon. */
export function StaffShell({ slug, children, wide = true }: { slug: string; children: ReactNode; wide?: boolean }) {
  const session = useStaffSession();
  const router = useRouter();
  const pathname = usePathname();
  const qc = useQueryClient();
  const [toasts, setToasts] = useState<{ id: number; msg: string; tone: 'ok' | 'error' }[]>([]);

  useEffect(() => {
    if (session === null) router.replace('/staff/login');
  }, [session, router]);

  const membership = session?.profile.memberships.find((m) => m.salon_slug === slug);
  const settings = useQuery({
    queryKey: ['settings', slug],
    enabled: !!session && !!membership,
    queryFn: () => api<{ settings: SalonSettings }>(`/v1/dashboard/${slug}/settings`, { token: session!.token }).then((r) => r.settings),
  });

  useEffect(() => {
    if (isApiError(settings.error) && settings.error.status === 401) {
      staffSession.set(null);
      router.replace('/staff/login');
    }
  }, [settings.error, router]);

  const toast = useCallback((msg: string, tone: 'ok' | 'error' = 'ok') => {
    const id = Math.random();
    setToasts((t) => [...t, { id, msg, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), tone === 'error' ? 6000 : 2500);
  }, []);

  const call = useCallback<StaffCtx['call']>(
    async (path, opts = {}) => {
      try {
        const r = await api<never>(`/v1/dashboard/${slug}${path}`, { method: opts.method ?? 'POST', body: opts.body, token: session!.token });
        qc.invalidateQueries({ queryKey: ['dashboard', slug] });
        if (opts.success) toast(opts.success);
        return r;
      } catch (e) {
        toast(e instanceof Error ? e.message : 'Something went wrong', 'error');
        qc.invalidateQueries({ queryKey: ['dashboard', slug] });
        return null;
      }
    },
    [slug, session, qc, toast],
  );

  if (!session) return <FullPageSpinner />;
  if (!membership)
    return (
      <div className="grid min-h-dvh place-items-center p-6 text-center">
        <div>
          <div className="text-lg font-semibold">You&apos;re not a member of this salon.</div>
          <Link className="mt-3 inline-block font-semibold text-brand" href="/staff">
            Choose another salon
          </Link>
        </div>
      </div>
    );

  const nav = [
    { href: `/dashboard/${slug}`, label: 'Queue', show: true },
    { href: `/dashboard/${slug}/settings`, label: 'Settings', show: canDesk(membership.role) },
    { href: `/dashboard/${slug}/report`, label: 'Report', show: canDesk(membership.role) },
  ].filter((n) => n.show);

  return (
    <Ctx.Provider
      value={{
        token: session.token,
        slug,
        role: membership.role,
        stylistId: membership.stylist_id,
        staffName: session.profile.staff.name,
        settings: settings.data,
        call,
        toast,
      }}
    >
      <div className="min-h-dvh">
        <header className="sticky top-0 z-30 border-b border-line bg-bg/95 backdrop-blur">
          <div className={cx('mx-auto flex h-14 items-center gap-4 px-4', wide ? 'max-w-[1400px]' : 'max-w-3xl')}>
            <Logo />
            <span className="hidden truncate text-sm font-semibold text-muted sm:inline">{membership.salon_name}</span>
            <nav className="ml-2 flex gap-1">
              {nav.length > 1 &&
                nav.map((n) => (
                  <Link
                    key={n.href}
                    href={n.href}
                    className={cx(
                      'rounded-lg px-3 py-1.5 text-sm font-semibold',
                      pathname === n.href ? 'bg-brand-soft text-brand' : 'text-muted hover:bg-surface-2',
                    )}
                  >
                    {n.label}
                  </Link>
                ))}
            </nav>
            <div className="ml-auto flex items-center gap-3">
              <Clock />
              <details className="relative">
                <summary className="flex cursor-pointer list-none items-center gap-2 rounded-lg px-2 py-1 text-sm hover:bg-surface-2">
                  <span className="grid size-8 place-items-center rounded-full bg-brand-soft font-bold text-brand">
                    {session.profile.staff.name.charAt(0)}
                  </span>
                  <span className="hidden text-left md:block">
                    <span className="block font-semibold leading-tight">{session.profile.staff.name}</span>
                    <span className="block text-xs capitalize text-muted">{membership.role}</span>
                  </span>
                </summary>
                <div className="absolute right-0 top-11 w-48 rounded-xl border border-line bg-surface p-1 shadow-lg">
                  <button
                    className="w-full rounded-lg px-3 py-2 text-left text-sm text-danger hover:bg-danger-soft"
                    onClick={() => {
                      staffSession.set(null);
                      router.replace('/staff/login');
                    }}
                  >
                    Sign out
                  </button>
                </div>
              </details>
            </div>
          </div>
        </header>
        <main className={cx('mx-auto px-4 py-5', wide ? 'max-w-[1400px]' : 'max-w-3xl')}>{children}</main>
        <div className="pointer-events-none fixed inset-x-0 bottom-4 z-[60] flex flex-col items-center gap-2 px-4 sm:items-end">
          {toasts.map((t) => (
            <div
              key={t.id}
              role="status"
              className={cx(
                'pointer-events-auto max-w-md rounded-xl px-4 py-3 text-sm font-medium shadow-lg',
                t.tone === 'error' ? 'bg-danger text-white' : 'bg-ink text-bg',
              )}
            >
              {t.msg}
            </div>
          ))}
        </div>
      </div>
    </Ctx.Provider>
  );
}

function Clock() {
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    setNow(new Date());
    const t = setInterval(() => setNow(new Date()), 10_000);
    return () => clearInterval(t);
  }, []);
  if (!now) return null;
  return (
    <span className="hidden text-lg font-semibold tabular sm:inline">
      {time(now.toISOString())}
    </span>
  );
}
