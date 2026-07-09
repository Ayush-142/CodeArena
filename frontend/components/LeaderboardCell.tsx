import type { LeaderboardCell as LeaderboardCellData } from '@/lib/types';

// ICPC convention: solved -> solve time (+wrong attempts if any before the AC),
// attempted-but-unsolved -> a negative wrong-attempt count, untouched -> empty.
// Shares the compact "chip" visual language with VerdictBadge's chip variant without
// being that component — this isn't a SubmissionStatus value.
export function LeaderboardCell({ cell }: { cell?: LeaderboardCellData }) {
  if (!cell) {
    return <span className="inline-block px-1.5 py-0.5 font-mono text-[11px]">&nbsp;</span>;
  }

  if (cell.solved) {
    const label =
      cell.wrongAttempts > 0 ? `${cell.solvedAtMinutes} +${cell.wrongAttempts}` : `${cell.solvedAtMinutes}`;
    return (
      <span className="inline-block border border-verdict-ac bg-verdict-ac/10 px-1.5 py-0.5 font-mono text-[11px] font-semibold text-verdict-ac">
        {label}
      </span>
    );
  }

  return (
    <span className="inline-block border border-verdict-wa bg-verdict-wa/10 px-1.5 py-0.5 font-mono text-[11px] font-semibold text-verdict-wa">
      &minus;{cell.wrongAttempts}
    </span>
  );
}
