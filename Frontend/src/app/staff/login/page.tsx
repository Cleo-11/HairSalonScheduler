'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Button, Card, ErrorBox, Field, inputClass, Logo } from '@/components/ui';
import { api, type StaffProfile } from '@/lib/api';
import { staffSession, useStaffSession } from '@/lib/session';

export default function StaffLoginPage() {
  const router = useRouter();
  const session = useStaffSession();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const go = (profile: StaffProfile) => {
    const m = profile.memberships;
    router.replace(m.length === 1 ? `/dashboard/${m[0]!.salon_slug}` : '/staff');
  };

  useEffect(() => {
    if (session) go(session.profile);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { token, ...profile } = await api<StaffProfile & { token: string }>('/v1/staff/auth/login', { body: { email, password } });
      staffSession.set({ token, profile });
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  return (
    <div className="grid min-h-dvh place-items-center px-4">
      <Card className="w-full max-w-sm p-6">
        <Logo />
        <h1 className="mt-5 text-xl font-bold">Salon dashboard</h1>
        <p className="mt-1 text-sm text-muted">Sign in with your staff account.</p>
        <form onSubmit={submit} className="mt-6 space-y-4">
          <Field label="Email">
            <input className={inputClass} type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
          </Field>
          <Field label="Password">
            <input
              className={inputClass}
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </Field>
          <ErrorBox error={error} />
          <Button type="submit" className="w-full" loading={busy}>
            Sign in
          </Button>
        </form>
      </Card>
    </div>
  );
}
