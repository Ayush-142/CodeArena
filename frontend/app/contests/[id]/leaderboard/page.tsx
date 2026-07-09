'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { ContestLeaderboard } from '@/components/ContestLeaderboard';
import { useDocumentTitle } from '@/lib/useDocumentTitle';

export default function ContestLeaderboardPage() {
  useDocumentTitle('Leaderboard');
  const { id } = useParams<{ id: string }>();

  return (
    <main className="flex flex-col gap-4 p-4">
      <Link href={`/contests/${id}`} className="font-mono text-sm text-accent underline">
        &larr; back to contest
      </Link>
      <h1 className="font-display text-xl font-bold text-ink">Leaderboard</h1>
      <ContestLeaderboard contestId={id} />
    </main>
  );
}
