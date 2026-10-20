'use client';

import { useSyncExternalStore } from 'react';
import type { Customer, StaffProfile } from './api';

/**
 * Tokens live in localStorage: one for the customer app, one for staff, so a
 * receptionist can test the customer app on the same tablet.
 */
interface CustomerSession {
  token: string;
  customer: Customer;
}
interface StaffSession {
  token: string;
  profile: StaffProfile;
}

const KEYS = { customer: 'kataar.customer', staff: 'kataar.staff' } as const;
const listeners = new Set<() => void>();
const cache = new Map<string, { raw: string | null; value: unknown }>();

function read<T>(key: string): T | null {
  if (typeof window === 'undefined') return null;
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(key);
  } catch {
    raw = null;
  }
  const hit = cache.get(key);
  if (hit && hit.raw === raw) return hit.value as T | null;
  let value: T | null = null;
  try {
    value = raw ? (JSON.parse(raw) as T) : null;
  } catch {
    value = null;
  }
  cache.set(key, { raw, value });
  return value;
}

function write(key: string, value: unknown) {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* private mode: session lasts for this tab only */
  }
  listeners.forEach((l) => l());
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  const onStorage = () => cb();
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(cb);
    window.removeEventListener('storage', onStorage);
  };
}

export const customerSession = {
  get: () => read<CustomerSession>(KEYS.customer),
  set: (s: CustomerSession | null) => write(KEYS.customer, s),
  updateCustomer: (customer: Customer) => {
    const s = read<CustomerSession>(KEYS.customer);
    if (s) write(KEYS.customer, { ...s, customer });
  },
};

export const staffSession = {
  get: () => read<StaffSession>(KEYS.staff),
  set: (s: StaffSession | null) => write(KEYS.staff, s),
};

/** Returns undefined during the first (server) render, then the session or null. */
export function useCustomerSession(): CustomerSession | null | undefined {
  return useSyncExternalStore(subscribe, customerSession.get, () => undefined);
}

export function useStaffSession(): StaffSession | null | undefined {
  return useSyncExternalStore(subscribe, staffSession.get, () => undefined);
}
