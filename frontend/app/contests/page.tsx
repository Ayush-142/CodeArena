'use client';

import { useEffect, useState } from 'react';
import { getContests } from '@/lib/api';
import type { ContestListResponse } from '@/lib/types';
import { ContestCard } from '@/components/ContestCard';
import { useDocumentTitle } from '@/lib/useDocumentTitle';
import { Skeleton } from '@/components/ui/Skeleton';
import { ErrorState } from '@/components/ui/ErrorState';
import { EmptyState } from '@/components/ui/EmptyState';

export default function ContestsPage() {
  useDocumentTitle('Contests');
  const [data, setData] = useState<ContestListResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getContests()
      .then((res) => {
        if (!cancelled) setData(res);
      })
      .catch(() => {
        if (!cancelled) setError('Failed to load contests');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <main className="p-4">
      <h1 className="mb-4 font-display text-xl font-bold text-ink">Contests</h1>
      {error ? (
        <ErrorState message={error} />
      ) : !data ? (
        <div className="flex flex-col gap-2">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      ) : data.contests.length === 0 ? (
        <EmptyState message="No contests scheduled yet." />
      ) : (
        <ul className="flex flex-col gap-2">
          {data.contests.map((c) => (
            <ContestCard key={c._id} contest={c} serverTime={data.serverTime} />
          ))}
        </ul>
      )}
    </main>
  );
}
