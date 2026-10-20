'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { customerSession, useCustomerSession } from '@/lib/session';

/** Small account button in the customer header: shows who's signed in, with sign out. */
export function CustomerMenu() {
  const session = useCustomerSession();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  if (!session) return null;
  const initial = (session.customer.name ?? '?').trim().charAt(0).toUpperCase();
  return (
    <div className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-label="Account"
        className="grid size-9 place-items-center rounded-full bg-brand-soft text-sm font-bold text-brand"
      >
        {initial}
      </button>
      {open && (
        <div className="absolute right-0 top-11 z-30 w-56 rounded-xl border border-line bg-surface p-2 shadow-lg">
          <div className="px-2 py-1.5 text-sm">
            <div className="font-semibold">{session.customer.name}</div>
            <div className="text-muted">{session.customer.phone}</div>
          </div>
          <button
            className="mt-1 w-full rounded-lg px-2 py-2 text-left text-sm text-danger hover:bg-danger-soft"
            onClick={() => {
              customerSession.set(null);
              router.replace('/login?next=/salons');
            }}
          >
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}
