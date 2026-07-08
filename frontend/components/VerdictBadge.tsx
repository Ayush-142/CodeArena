import type { SubmissionStatus } from '@/lib/types';

const STATUS_COLORS: Record<SubmissionStatus, string> = {
  queued: 'text-slate-400',
  running: 'text-yellow-400',
  AC: 'text-green-400',
  WA: 'text-red-400',
  TLE: 'text-red-400',
  MLE: 'text-red-400',
  RE: 'text-red-400',
  CE: 'text-red-400',
};

export function VerdictBadge({
  status,
  failedTestIndex,
  execTimeMs,
}: {
  status: SubmissionStatus;
  failedTestIndex?: number;
  execTimeMs?: number;
}) {
  const details: string[] = [];
  if (typeof failedTestIndex === 'number') details.push(`test #${failedTestIndex}`);
  if (typeof execTimeMs === 'number') details.push(`${execTimeMs}ms`);
  const label = details.length ? `${status} (${details.join(', ')})` : status;

  return <span className={STATUS_COLORS[status]}>{label}</span>;
}
