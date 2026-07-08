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
    <li className="border border-slate-700 p-3">
      <Link href={`/contests/${contest._id}`} className="font-semibold underline">
        {contest.title}
      </Link>
      <p className="text-sm text-slate-400">
        {contest.problemCount} problems · {contest.isRegistered ? 'registered' : 'not registered'}
      </p>
      {phase === 'upcoming' ? (
        <p className="text-sm">
          starts in <CountdownTimer targetTime={contest.startAt} serverTime={serverTime} />
        </p>
      ) : phase === 'running' ? (
        <p className="text-sm text-yellow-400">
          running · ends in <CountdownTimer targetTime={contest.endAt} serverTime={serverTime} />
        </p>
      ) : (
        <p className="text-sm text-slate-400">ended</p>
      )}
    </li>
  );
}
