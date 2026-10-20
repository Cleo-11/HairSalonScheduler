'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { Card, FullPageSpinner, Logo } from '@/components/ui';
import { useStaffSession } from '@/lib/session';

/** For staff who belong to more than one salon. */
export default function StaffHome() {
  const session = useStaffSession();
  const router = useRouter();
  useEffect(() => {
    if (session === null) router.replace('/staff/login');
  }, [session, router]);
  if (!session) return <FullPageSpinner />;
  return (
    <div className="mx-auto max-w-md px-4 py-10">
      <Logo />
      <h1 className="mt-6 text-xl font-bold">Choose a salon</h1>
      <ul className="mt-4 space-y-3">
        {session.profile.memberships.map((m) => (
          <li key={m.salon_id}>
            <Link href={`/dashboard/${m.salon_slug}`}>
              <Card className="p-4 hover:border-brand">
                <div className="font-semibold">{m.salon_name}</div>
                <div className="text-sm capitalize text-muted">{m.role}</div>
              </Card>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
