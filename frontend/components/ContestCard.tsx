import Link from 'next/link';
import type { ContestSummary } from '@/lib/types';
import { CountdownTimer } from './CountdownTimer';

function computePhase(startAt: string, endAt: string, now: number): 'upcoming' | 'running' | 'ended' {
  if (now < new Date(startAt).getTime()) return 'upcoming';
  if (now <= new Date(endAt).getTime()) return 'running';
  return 'ended';
}

export function ContestCard({ contest, serverTime }: { contest: ContestSummary; serverTime: number }) {
  const phase = computePhase(contest.startAt, contest.endAt, serverTime);

  return (
    <li className="rounded-lg border border-line p-3 hover:border-ink">
      <Link href={`/contests/${contest._id}`} className="font-display font-bold text-ink underline">
        {contest.title}
      </Link>
      <p className="font-mono text-sm text-ink/60">
        {contest.problemCount} problems · {contest.isRegistered ? 'registered' : 'not registered'}
      </p>
      {phase === 'upcoming' ? (
        <p className="font-mono text-sm text-ink/80">
          starts in <CountdownTimer targetTime={contest.startAt} serverTime={serverTime} />
        </p>
      ) : phase === 'running' ? (
        <p className="font-mono text-sm text-accent">
          running · ends in <CountdownTimer targetTime={contest.endAt} serverTime={serverTime} />
        </p>
      ) : (
        <p className="font-mono text-sm text-ink/50">ended</p>
      )}
    </li>
  );
}
