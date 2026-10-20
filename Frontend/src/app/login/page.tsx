'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useRef, useState } from 'react';
import { Button, ErrorBox, inputBase, MobileShell, Notice } from '@/components/ui';
import { api, ApiError, type Customer, isApiError } from '@/lib/api';
import { safeNext } from '@/lib/nav';
import { customerSession } from '@/lib/session';

interface OtpRequested {
  phone: string;
  channel: string;
  expires_in_seconds: number;
  resend_after_seconds: number;
}

export default function LoginPage() {
  return (
    <Suspense>
      <Login />
    </Suspense>
  );
}

function Login() {
  const router = useRouter();
  const next = safeNext(useSearchParams().get('next'));
  const [step, setStep] = useState<'phone' | 'code'>('phone');
  const [phone, setPhone] = useState('');
  const [sent, setSent] = useState<OtpRequested | null>(null);
  const [resendAt, setResendAt] = useState(0);
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);

  async function requestCode(e?: React.FormEvent) {
    e?.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api<OtpRequested>('/v1/auth/otp/request', { body: { phone: '+91' + phone.replace(/\D/g, '').slice(-10) } });
      setSent(r);
      setResendAt(Date.now() + r.resend_after_seconds * 1000);
      setStep('code');
    } catch (err) {
      if (isApiError(err, 'OTP_RESEND_TOO_SOON')) {
        setResendAt(Date.now() + Number(err.details?.retry_after_seconds ?? 30) * 1000);
        setStep('code');
      }
      setError(err as ApiError);
    } finally {
      setBusy(false);
    }
  }

  async function verify(code: string) {
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ token: string; is_new: boolean; customer: Customer }>('/v1/auth/otp/verify', {
        body: { phone: sent?.phone ?? '+91' + phone.replace(/\D/g, '').slice(-10), code },
      });
      customerSession.set({ token: r.token, customer: r.customer });
      router.replace(r.customer.needs_name ? `/name?next=${encodeURIComponent(next)}` : next);
    } catch (err) {
      setError(err as ApiError);
      setBusy(false);
    }
  }

  const digits = phone.replace(/\D/g, '');
  const validPhone = /^[6-9]\d{9}$/.test(digits.slice(-10)) && digits.length >= 10;

  if (step === 'code') {
    return (
      <MobileShell back={() => (setStep('phone'), setError(null))} title="Enter code">
        <CodeStep
          phone={sent?.phone ?? '+91 ' + digits}
          channel={sent?.channel}
          busy={busy}
          error={error}
          resendAt={resendAt}
          onVerify={verify}
          onResend={() => requestCode()}
        />
      </MobileShell>
    );
  }

  return (
    <MobileShell>
      <div className="pt-8">
        <div className="text-4xl" aria-hidden>
          💈
        </div>
        <h1 className="mt-4 text-2xl font-bold leading-tight">Skip the wait at the salon</h1>
        <p className="mt-2 text-muted">Join the queue from your phone and see how long you&apos;ll wait, live.</p>
      </div>
      <form onSubmit={requestCode} className="mt-8 space-y-4">
        <label className="block">
          <span className="mb-1.5 block text-sm font-medium">Mobile number</span>
          <div className="flex h-14 items-center rounded-xl border border-line bg-surface focus-within:border-brand">
            <span className="border-r border-line px-3 text-base font-medium text-muted">+91</span>
            <input
              autoFocus
              inputMode="tel"
              autoComplete="tel-national"
              placeholder="98765 43210"
              value={phone}
              onChange={(e) => setPhone(e.target.value.replace(/[^\d\s]/g, '').slice(0, 12))}
              className="h-full flex-1 bg-transparent px-3 text-lg tracking-wide outline-none"
              aria-label="Mobile number"
            />
          </div>
        </label>
        <ErrorBox error={error} />
        <ProviderReason error={error} />
        <Button type="submit" size="lg" className="w-full" disabled={!validPhone} loading={busy}>
          Send code on WhatsApp
        </Button>
        <p className="text-center text-xs text-muted">We&apos;ll send a 6-digit code to this number on WhatsApp.</p>
      </form>
    </MobileShell>
  );
}

function CodeStep({
  phone,
  channel,
  busy,
  error,
  resendAt,
  onVerify,
  onResend,
}: {
  phone: string;
  channel?: string;
  busy: boolean;
  error: ApiError | null;
  resendAt: number;
  onVerify: (code: string) => void;
  onResend: () => void;
}) {
  const [code, setCode] = useState('');
  const [now, setNow] = useState(Date.now());
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    if (error) {
      setCode('');
      inputRef.current?.focus();
    }
  }, [error]);

  const wait = Math.max(0, Math.ceil((resendAt - now) / 1000));
  const locked = error?.code === 'OTP_LOCKED' || error?.code === 'OTP_TOO_MANY_REQUESTS';
  const expired = error?.code === 'OTP_EXPIRED';
  const attemptsLeft = error?.code === 'OTP_INVALID' ? (error.details?.attempts_left as number | undefined) : undefined;

  return (
    <div className="pt-2">
      <p className="text-muted">
        We sent a code to <span className="font-semibold text-ink">{phone}</span> on WhatsApp.
      </p>
      {channel === 'dev' && (
        <Notice tone="warn" className="mt-3">
          Development mode: the code is printed in the backend terminal.
        </Notice>
      )}
      <form
        className="mt-6 space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (code.length === 6) onVerify(code);
        }}
      >
        <input
          ref={inputRef}
          autoFocus
          inputMode="numeric"
          autoComplete="one-time-code"
          aria-label="6-digit code"
          placeholder="••••••"
          value={code}
          disabled={locked}
          onChange={(e) => {
            const v = e.target.value.replace(/\D/g, '').slice(0, 6);
            setCode(v);
            if (v.length === 6) onVerify(v);
          }}
          className={inputBase + ' h-16 w-full text-center text-3xl font-semibold tracking-[0.5em] tabular'}
        />
        {error && (
          <div role="alert" className="rounded-xl bg-danger-soft px-4 py-3 text-sm text-danger">
            {error.message}
            {attemptsLeft !== undefined && ` · ${attemptsLeft} ${attemptsLeft === 1 ? 'attempt' : 'attempts'} left`}
            {expired && ' Tap "Send a new code" below.'}
          </div>
        )}
        <ProviderReason error={error} />
        <Button type="submit" size="lg" className="w-full" disabled={code.length !== 6 || locked} loading={busy}>
          Verify
        </Button>
      </form>
      <div className="mt-6 text-center text-sm">
        {wait > 0 ? (
          <span className="text-muted tabular">Send a new code in {wait}s</span>
        ) : (
          <button className="font-semibold text-brand" onClick={onResend}>
            Send a new code
          </button>
        )}
      </div>
    </div>
  );
}

/** In development the backend includes why WhatsApp delivery failed (e.g. number not on the test list). */
function ProviderReason({ error }: { error: ApiError | null }) {
  const reason = error?.code === 'OTP_DELIVERY_FAILED' ? error.details?.reason : undefined;
  if (typeof reason !== 'string') return null;
  return <p className="break-words rounded-xl bg-surface-2 px-4 py-3 text-xs text-muted">Details: {reason}</p>;
}
