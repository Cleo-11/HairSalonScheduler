import type { components } from './api-types';

/** Response and request shapes, generated from ../Backend/openapi.yaml (`npm run api:types`). */
export type S = components['schemas'];
export type CustomerEntry = S['CustomerQueueEntry'];
export type DashboardEntry = S['DashboardQueueEntry'];
export type Dashboard = S['Dashboard'];
export type StylistCard = S['StylistCard'];
export type EWalkInStatus = S['EWalkInStatus'];
export type StylistBoardItem = S['StylistBoardItem'];
export type Service = S['Service'];
export type SalonSummary = S['SalonSummary'];
export type SalonDetail = S['SalonDetail'];
export type Customer = S['Customer'];
export type StaffProfile = S['StaffProfile'];
export type StylistStatus = S['StylistStatus'];
export type EntryStatus = S['EntryStatus'];
export type Role = S['Role'];

export const API_URL = (process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3000').replace(/\/$/, '');

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details: Record<string, unknown> | null,
  ) {
    super(message);
  }
}

export interface RequestOpts {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  token?: string | null;
  query?: Record<string, string | number | undefined | null>;
}

export async function api<T>(path: string, opts: RequestOpts = {}): Promise<T> {
  const url = new URL(API_URL + path);
  for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;

  let res: Response;
  try {
    res = await fetch(url, {
      method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'),
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
  } catch {
    throw new ApiError(0, 'NETWORK', "Can't reach the server. Check your connection and try again.", null);
  }
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const e = data?.error;
    throw new ApiError(res.status, e?.code ?? 'HTTP_' + res.status, e?.message ?? 'Something went wrong', e?.details ?? null);
  }
  return data as T;
}

export const isApiError = (e: unknown, code?: string): e is ApiError =>
  e instanceof ApiError && (code === undefined || e.code === code);
