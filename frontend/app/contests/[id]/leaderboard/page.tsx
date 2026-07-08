'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { ContestLeaderboard } from '@/components/ContestLeaderboard';

export default function ContestLeaderboardPage() {
  const { id } = useParams<{ id: string }>();

  return (
    <main className="flex flex-col gap-4 p-4">
      <Link href={`/contests/${id}`} className="text-sm underline">
        &larr; back to contest
      </Link>
      <h1 className="text-xl font-semibold">Leaderboard</h1>
      <ContestLeaderboard contestId={id} />
    </main>
  );
}
