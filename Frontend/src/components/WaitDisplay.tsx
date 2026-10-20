import { cx } from './ui';
import { time, waitRange } from '@/lib/format';

/** The one way a wait is shown: a range as the headline, the start time underneath. */
export function WaitDisplay({
  range,
  startAt,
  tz,
  size = 'md',
}: {
  range: { low: number; high: number } | null | undefined;
  startAt: string | null | undefined;
  tz?: string;
  size?: 'md' | 'xl';
}) {
  if (!range) return <span className="text-muted">No estimate</span>;
  const now = range.high === 0;
  return (
    <span className="inline-flex flex-col">
      <span className={cx('font-bold tabular leading-tight', size === 'xl' ? 'text-5xl tracking-tight' : 'text-lg')}>
        {waitRange(range)}
      </span>
      {startAt && !now && (
        <span className={cx('text-muted tabular', size === 'xl' ? 'mt-1 text-base' : 'text-sm')}>around {time(startAt, tz)}</span>
      )}
      {now && <span className={cx('text-muted', size === 'xl' ? 'mt-1 text-base' : 'text-sm')}>you&apos;re up next</span>}
    </span>
  );
}
