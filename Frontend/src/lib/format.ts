export const APP_NAME = 'Kataar';
export const DEFAULT_TZ = 'Asia/Kolkata';

export function rupees(paise: number): string {
  return '₹' + (paise / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 });
}

export function time(iso: string | null | undefined, tz = DEFAULT_TZ): string {
  if (!iso) return '';
  return new Intl.DateTimeFormat('en-IN', { timeZone: tz, hour: 'numeric', minute: '2-digit', hour12: true })
    .format(new Date(iso))
    .replace(' am', ' AM')
    .replace(' pm', ' PM');
}

export function dayAndTime(iso: string | null | undefined, tz = DEFAULT_TZ): string {
  if (!iso) return '';
  const d = new Date(iso);
  const fmt = (o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en-IN', { timeZone: tz, ...o }).format(d);
  const today = fmt({ year: 'numeric', month: '2-digit', day: '2-digit' });
  const now = new Date();
  const same = (x: Date) => new Intl.DateTimeFormat('en-IN', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(x);
  const tomorrow = new Date(now.getTime() + 86_400_000);
  const label = today === same(now) ? 'today' : today === same(tomorrow) ? 'tomorrow' : fmt({ weekday: 'long' });
  return `${label} at ${time(iso, tz)}`;
}

export function minutes(n: number): string {
  if (n < 60) return `${n} min`;
  const h = Math.floor(n / 60);
  const m = n % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

export function waitRange(r: { low: number; high: number } | null | undefined): string {
  if (!r) return '';
  if (r.high === 0) return 'Now';
  if (r.low === 0) return `Under ${r.high} min`;
  if (r.high >= 120) {
    const toH = (m: number) => {
      const half = Math.round(m / 30) / 2;
      const whole = Math.floor(half);
      return (whole ? String(whole) : '') + (half % 1 ? '½' : '') || '0';
    };
    return `${toH(r.low)}–${toH(r.high)} h`;
  }
  return `${r.low}–${r.high} min`;
}

export function distance(m: number | null | undefined): string {
  if (m === null || m === undefined) return '';
  if (m < 1000) return `${Math.round(m / 10) * 10} m`;
  return `${(m / 1000).toFixed(m < 10_000 ? 1 : 0)} km`;
}

export function plural(n: number, one: string, many = one + 's'): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function minutesUntil(iso: string | null | undefined, now = Date.now()): number | null {
  if (!iso) return null;
  return Math.round((new Date(iso).getTime() - now) / 60_000);
}
