'use client';

import Link from 'next/link';
import { type ButtonHTMLAttributes, type ReactNode, useEffect } from 'react';
import type { StylistStatus } from '@/lib/api';
import { APP_NAME } from '@/lib/format';

export function cx(...c: (string | false | null | undefined)[]) {
  return c.filter(Boolean).join(' ');
}

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'accent';
const VARIANTS: Record<Variant, string> = {
  primary: 'bg-brand text-brand-ink hover:bg-brand-hover disabled:opacity-50',
  secondary: 'bg-surface text-ink border border-line hover:bg-surface-2 disabled:opacity-50',
  ghost: 'text-ink hover:bg-surface-2 disabled:opacity-50',
  danger: 'bg-surface text-danger border border-line hover:bg-danger-soft disabled:opacity-50',
  accent: 'bg-accent text-white hover:opacity-90 disabled:opacity-50',
};

export function Button({
  variant = 'primary',
  size = 'md',
  loading,
  className,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm' | 'md' | 'lg'; loading?: boolean }) {
  const sizes = { sm: 'h-9 px-3 text-sm', md: 'h-11 px-4 text-[15px]', lg: 'h-14 px-5 text-base' };
  return (
    <button
      {...rest}
      disabled={rest.disabled || loading}
      className={cx(
        'inline-flex items-center justify-center gap-2 rounded-xl font-semibold transition-colors disabled:cursor-not-allowed',
        sizes[size],
        VARIANTS[variant],
        className,
      )}
    >
      {loading && <Spinner />}
      {children}
    </button>
  );
}

export function Spinner({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={cx('inline-block size-4 animate-spin rounded-full border-2 border-current border-r-transparent', className)}
    />
  );
}

export function Card({ children, className, ...rest }: { children: ReactNode; className?: string } & React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div {...rest} className={cx('rounded-2xl border border-line bg-surface', className)}>
      {children}
    </div>
  );
}

type Tone = 'brand' | 'ok' | 'warn' | 'danger' | 'accent' | 'off' | 'neutral';
const TONES: Record<Tone, string> = {
  brand: 'bg-brand-soft text-brand',
  ok: 'bg-ok-soft text-ok',
  warn: 'bg-warn-soft text-warn',
  danger: 'bg-danger-soft text-danger',
  accent: 'bg-accent-soft text-accent',
  off: 'bg-off-soft text-off',
  neutral: 'bg-surface-2 text-muted',
};

export function Badge({ tone = 'neutral', children, className }: { tone?: Tone; children: ReactNode; className?: string }) {
  return (
    <span className={cx('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold', TONES[tone], className)}>
      {children}
    </span>
  );
}

const STYLIST_STATUS: Record<StylistStatus, { tone: Tone; label: string; icon: string }> = {
  available: { tone: 'ok', label: 'Available', icon: '●' },
  busy: { tone: 'warn', label: 'Busy', icon: '✂' },
  break: { tone: 'accent', label: 'On break', icon: '☕' },
  off: { tone: 'off', label: 'Off', icon: '○' },
};

/** Status is never shown by colour alone: icon + label. */
export function StylistStatusBadge({ status }: { status: StylistStatus }) {
  const s = STYLIST_STATUS[status];
  return (
    <Badge tone={s.tone}>
      <span aria-hidden>{s.icon}</span>
      {s.label}
    </Badge>
  );
}

export function ErrorBox({ error, className }: { error: unknown; className?: string }) {
  if (!error) return null;
  const msg = error instanceof Error ? error.message : String(error);
  return (
    <div role="alert" className={cx('rounded-xl bg-danger-soft px-4 py-3 text-sm text-danger', className)}>
      {msg}
    </div>
  );
}

export function Notice({ tone = 'neutral', title, children, className }: { tone?: Tone; title?: ReactNode; children?: ReactNode; className?: string }) {
  return (
    <div className={cx('rounded-xl px-4 py-3 text-sm', TONES[tone], className)}>
      {title && <div className="font-semibold">{title}</div>}
      {children && <div className={cx(!!title && 'mt-0.5', 'opacity-90')}>{children}</div>}
    </div>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-sm font-medium text-ink">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-muted">{hint}</span>}
    </label>
  );
}

/** Input styling without a size; `inputClass` adds the default size. */
export const inputBase =
  'rounded-xl border border-line bg-surface px-3 text-[15px] text-ink placeholder:text-muted focus:border-brand focus:outline-none disabled:opacity-60';
export const inputClass = inputBase + ' h-11 w-full';

export function Logo({ size = 'md' }: { size?: 'md' | 'lg' }) {
  return (
    <span className={cx('inline-flex items-center gap-2 font-bold tracking-tight', size === 'lg' ? 'text-2xl' : 'text-lg')}>
      <svg viewBox="0 0 24 24" className={size === 'lg' ? 'size-8' : 'size-6'} aria-hidden>
        <rect x="2" y="2" width="20" height="20" rx="6" fill="var(--brand)" />
        <circle cx="8" cy="12" r="2" fill="var(--brand-ink)" />
        <circle cx="13" cy="12" r="2" fill="var(--brand-ink)" opacity="0.7" />
        <circle cx="18" cy="12" r="2" fill="var(--brand-ink)" opacity="0.4" />
      </svg>
      {APP_NAME}
    </span>
  );
}

/** Mobile page frame for the customer app. */
export function MobileShell({
  title,
  back,
  children,
  footer,
  right,
}: {
  title?: ReactNode;
  back?: string | (() => void);
  children: ReactNode;
  footer?: ReactNode;
  right?: ReactNode;
}) {
  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-md flex-col">
      <header className="sticky top-0 z-20 flex h-14 items-center gap-2 border-b border-line bg-bg/90 px-3 backdrop-blur">
        {back ? (
          typeof back === 'string' ? (
            <Link href={back} aria-label="Back" className="grid size-10 place-items-center rounded-full hover:bg-surface-2">
              <BackIcon />
            </Link>
          ) : (
            <button onClick={back} aria-label="Back" className="grid size-10 place-items-center rounded-full hover:bg-surface-2">
              <BackIcon />
            </button>
          )
        ) : (
          <span className="pl-1">
            <Logo />
          </span>
        )}
        <div className="min-w-0 flex-1 truncate text-base font-semibold">{back ? title : null}</div>
        {right}
      </header>
      <main className="flex-1 px-4 pb-6 pt-4">{children}</main>
      {footer && (
        <div className="sticky bottom-0 z-20 border-t border-line bg-bg/95 px-4 pb-[max(env(safe-area-inset-bottom),12px)] pt-3 backdrop-blur">
          {footer}
        </div>
      )}
    </div>
  );
}

function BackIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <path d="M15 18l-6-6 6-6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function FullPageSpinner() {
  return (
    <div className="grid min-h-dvh place-items-center text-muted">
      <Spinner className="size-6" />
    </div>
  );
}

/** Bottom sheet on phones, centred dialog on larger screens. */
export function Sheet({ open, onClose, title, children, wide }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center" role="dialog" aria-modal="true">
      <button aria-label="Close" className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div
        className={cx(
          'relative max-h-[92dvh] w-full overflow-y-auto rounded-t-3xl bg-surface p-5 shadow-xl sm:rounded-3xl',
          wide ? 'sm:max-w-2xl' : 'sm:max-w-md',
        )}
      >
        <div className="mb-4 flex items-center justify-between gap-4">
          <h2 className="text-lg font-bold">{title}</h2>
          <button onClick={onClose} aria-label="Close" className="grid size-9 place-items-center rounded-full hover:bg-surface-2">
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function LiveIndicator({ state }: { state: 'connecting' | 'live' | 'reconnecting' }) {
  const label = state === 'live' ? 'Live' : state === 'connecting' ? 'Connecting' : 'Reconnecting';
  return (
    <span className="inline-flex items-center gap-1.5 text-xs font-medium text-muted">
      <span className={cx('size-2 rounded-full', state === 'live' ? 'live-dot bg-ok' : 'bg-warn')} />
      {label}
    </span>
  );
}

export function EmptyState({ icon, title, children }: { icon: string; title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center px-6 py-10 text-center">
      <div className="mb-3 text-4xl" aria-hidden>
        {icon}
      </div>
      <div className="text-base font-semibold">{title}</div>
      {children && <div className="mt-1 max-w-sm text-sm text-muted">{children}</div>}
    </div>
  );
}

export function Checkbox({ checked }: { checked: boolean }) {
  return (
    <span
      aria-hidden
      className={cx(
        'grid size-6 shrink-0 place-items-center rounded-md border-2 text-xs font-bold',
        checked ? 'border-brand bg-brand text-brand-ink' : 'border-line bg-surface',
      )}
    >
      {checked ? '✓' : ''}
    </span>
  );
}

export function Avatar({ name, muted, size = 'md' }: { name: string; muted?: boolean; size?: 'sm' | 'md' }) {
  return (
    <span
      aria-hidden
      className={cx(
        'grid shrink-0 place-items-center rounded-full font-bold',
        size === 'sm' ? 'size-8 text-sm' : 'size-11 text-base',
        muted ? 'bg-off-soft text-off' : 'bg-brand-soft text-brand',
      )}
    >
      {name.charAt(0).toUpperCase()}
    </span>
  );
}
