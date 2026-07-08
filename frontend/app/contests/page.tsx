'use client';

import { useEffect, useState } from 'react';
import { getContests } from '@/lib/api';
import type { ContestListResponse } from '@/lib/types';
import { ContestCard } from '@/components/ContestCard';

export default function ContestsPage() {
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

  if (error) return <main className="p-4">{error}</main>;
  if (!data) return <main className="p-4">Loading…</main>;

  return (
    <main className="p-4">
      <h1 className="mb-4 text-xl font-semibold">Contests</h1>
      <ul className="flex flex-col gap-2">
        {data.contests.map((c) => (
          <ContestCard key={c._id} contest={c} serverTime={data.serverTime} />
        ))}
      </ul>
    </main>
  );
}
