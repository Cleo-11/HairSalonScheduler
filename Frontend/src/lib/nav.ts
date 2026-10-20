/** Only allow in-app relative redirects (no open redirects via ?next=). */
export function safeNext(next: string | null | undefined, fallback = '/salons'): string {
  if (!next || !next.startsWith('/') || next.startsWith('//')) return fallback;
  return next;
}
