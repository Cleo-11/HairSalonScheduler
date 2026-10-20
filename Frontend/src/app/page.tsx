'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { FullPageSpinner } from '@/components/ui';
import { api, type Customer, type CustomerEntry, isApiError } from '@/lib/api';
import { customerSession, useCustomerSession } from '@/lib/session';

/** Entry point: send the customer to wherever they left off. */
export default function Home() {
  const router = useRouter();
  const session = useCustomerSession();

  useEffect(() => {
    if (session === undefined) return;
    if (!session) return router.replace('/login?next=/salons');
    (async () => {
      try {
        const { customer } = await api<{ customer: Customer }>('/v1/me', { token: session.token });
        customerSession.updateCustomer(customer);
        if (customer.needs_name) return router.replace('/name?next=/salons');
        const { entries } = await api<{ entries: CustomerEntry[] }>('/v1/me/queue', { token: session.token });
        router.replace(entries[0] ? `/queue/${entries[0].id}` : '/salons');
      } catch (e) {
        if (isApiError(e) && e.status === 401) {
          customerSession.set(null);
          router.replace('/login?next=/salons');
        } else router.replace('/salons');
      }
    })();
  }, [session, router]);

  return <FullPageSpinner />;
}
