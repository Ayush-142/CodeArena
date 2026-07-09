import type { SubmissionStatus } from '@/lib/types';

interface StatusStyle {
  text: string;
  border: string;
  bg: string;
}

// Full literal class strings per status (not composed via template interpolation) so
// Tailwind's content scanner picks every one up statically — see tailwind.config.ts
// for the verdict.* / accent token definitions these reference.
const STATUS_STYLES: Record<SubmissionStatus, StatusStyle> = {
  queued: { text: 'text-accent', border: 'border-accent', bg: 'bg-accent/10' },
  running: { text: 'text-accent', border: 'border-accent', bg: 'bg-accent/10' },
  AC: { text: 'text-verdict-ac', border: 'border-verdict-ac', bg: 'bg-verdict-ac/10' },
  WA: { text: 'text-verdict-wa', border: 'border-verdict-wa', bg: 'bg-verdict-wa/10' },
  TLE: { text: 'text-verdict-tle', border: 'border-verdict-tle', bg: 'bg-verdict-tle/10' },
  MLE: { text: 'text-verdict-mle', border: 'border-verdict-mle', bg: 'bg-verdict-mle/10' },
  RE: { text: 'text-verdict-re', border: 'border-verdict-re', bg: 'bg-verdict-re/10' },
  CE: { text: 'text-verdict-ce', border: 'border-verdict-ce', bg: 'bg-verdict-ce/10' },
};

interface VerdictBadgeProps {
  status: SubmissionStatus;
  failedTestIndex?: number;
  execTimeMs?: number;
  // "stamp": full rotated/animated treatment — the solving page and contest detail
  // verdict moment. "chip": compact, unrotated, no animation — dense tables
  // (SubmissionHistory rows, leaderboard grid cells). Never use "stamp" per-row in a
  // table.
  variant?: 'stamp' | 'chip';
}

export function VerdictBadge({
  status,
  failedTestIndex,
  execTimeMs,
  variant = 'stamp',
}: VerdictBadgeProps) {
  const details: string[] = [];
  if (typeof failedTestIndex === 'number') details.push(`test #${failedTestIndex}`);
  if (typeof execTimeMs === 'number') details.push(`${execTimeMs}ms`);
  const label = details.length ? `${status} (${details.join(', ')})` : status;
  const style = STATUS_STYLES[status];

  if (variant === 'chip') {
    return (
      <span
        className={`inline-block rounded-md border px-1.5 py-0.5 font-mono text-[11px] font-semibold uppercase tracking-wide ${style.text} ${style.border} ${style.bg}`}
      >
        {label}
      </span>
    );
  }

  return (
    <span
      className={`inline-block rotate-[-2deg] rounded-lg border-2 p-[3px] shadow-stamp motion-safe:animate-stamp-in ${style.border} ${style.text}`}
    >
      <span
        className={`block rounded-md border px-3 py-1 font-mono text-sm font-bold uppercase tracking-widest ${style.border} ${style.bg}`}
      >
        {label}
      </span>
    </span>
  );
}
