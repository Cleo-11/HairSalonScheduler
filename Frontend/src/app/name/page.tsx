'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { Button, ErrorBox, inputBase, MobileShell } from '@/components/ui';
import { api, type Customer } from '@/lib/api';
import { safeNext } from '@/lib/nav';
import { customerSession, useCustomerSession } from '@/lib/session';

export default function NamePage() {
  return (
    <Suspense>
      <NameForm />
    </Suspense>
  );
}

function NameForm() {
  const router = useRouter();
  const next = safeNext(useSearchParams().get('next'));
  const session = useCustomerSession();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    if (session === null) router.replace(`/login?next=${encodeURIComponent(next)}`);
  }, [session, router, next]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!session) return;
    setBusy(true);
    setError(null);
    try {
      const { customer } = await api<{ customer: Customer }>('/v1/me', { method: 'PATCH', token: session.token, body: { name } });
      customerSession.updateCustomer(customer);
      router.replace(next);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  return (
    <MobileShell>
      <div className="pt-6">
        <div className="text-4xl" aria-hidden>
          👋
        </div>
        <h1 className="mt-4 text-2xl font-bold">What should we call you?</h1>
        <p className="mt-2 text-muted">The salon uses this to call you to the chair. We only ask once.</p>
      </div>
      <form onSubmit={save} className="mt-8 space-y-4">
        <input
          autoFocus
          autoComplete="given-name"
          aria-label="Your name"
          placeholder="Your name"
          maxLength={80}
          value={name}
          onChange={(e) => setName(e.target.value)}
          className={inputBase + ' h-14 w-full text-lg'}
        />
        <ErrorBox error={error} />
        <Button type="submit" size="lg" className="w-full" disabled={!name.trim()} loading={busy}>
          Continue
        </Button>
      </form>
    </MobileShell>
  );
}
