'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { API_URL } from './api';

export type LiveState = 'connecting' | 'live' | 'reconnecting';

/**
 * Subscribes to the salon's Server-Sent Events stream. Each `queue` event means
 * "something changed", so we invalidate the given query keys and React Query
 * refetches whatever is on screen.
 */
export function useSalonEvents(slug: string | null | undefined, invalidate: readonly unknown[][]): LiveState {
  const qc = useQueryClient();
  const [state, setState] = useState<LiveState>('connecting');
  const keysJson = JSON.stringify(invalidate);

  useEffect(() => {
    if (!slug) return;
    const keys = JSON.parse(keysJson) as unknown[][];
    const es = new EventSource(`${API_URL}/v1/salons/${encodeURIComponent(slug)}/events`);
    let first = true;
    es.addEventListener('queue', () => {
      setState('live');
      // The first event is just the snapshot on connect (data was already fetched).
      // After a reconnect, `first` is false, so the snapshot catches us up.
      if (!first) for (const k of keys) qc.invalidateQueries({ queryKey: k });
      first = false;
    });
    es.onerror = () => setState('reconnecting');
    return () => es.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug, keysJson, qc]);

  return state;
}

/** Current time, re-rendering every `ms`. */
export function useNow(ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

export interface LatLng {
  lat: number;
  lng: number;
}

const LOC_KEY = 'kataar.location';

/** Last known location from this tab (used to send with a join). */
export function cachedLocation(): LatLng | null {
  try {
    const raw = sessionStorage.getItem(LOC_KEY);
    return raw ? (JSON.parse(raw) as LatLng) : null;
  } catch {
    return null;
  }
}

export function requestLocation(timeoutMs = 8000): Promise<LatLng> {
  return new Promise((resolve, reject) => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) return reject(new Error('unsupported'));
    // The browser's own timeout only starts once permission is granted, so an
    // unanswered permission prompt would hang forever without this.
    setTimeout(() => reject(new Error('timeout')), timeoutMs + 500);
    navigator.geolocation.getCurrentPosition(
      (p) => {
        const loc = { lat: p.coords.latitude, lng: p.coords.longitude };
        try {
          sessionStorage.setItem(LOC_KEY, JSON.stringify(loc));
        } catch {
          /* ignore */
        }
        resolve(loc);
      },
      (err) => reject(err),
      { enableHighAccuracy: false, timeout: timeoutMs, maximumAge: 60_000 },
    );
  });
}
