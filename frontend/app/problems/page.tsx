'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { getProblems } from '@/lib/api';
import type { ProblemSummary } from '@/lib/types';
import { useDocumentTitle } from '@/lib/useDocumentTitle';
import { Skeleton } from '@/components/ui/Skeleton';
import { ErrorState } from '@/components/ui/ErrorState';
import { EmptyState } from '@/components/ui/EmptyState';

const DIFFICULTY_STYLES: Record<ProblemSummary['difficulty'], string> = {
  easy: 'border-verdict-ac text-verdict-ac',
  medium: 'border-verdict-tle text-verdict-tle',
  hard: 'border-verdict-wa text-verdict-wa',
};

export default function ProblemsPage() {
  useDocumentTitle('Problems');
  const [problems, setProblems] = useState<ProblemSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getProblems()
      .then((data) => {
        if (!cancelled) setProblems(data);
      })
      .catch(() => {
        if (!cancelled) setError('Failed to load problems');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <main className="p-4">
      <h1 className="mb-4 font-display text-xl font-bold text-ink">Problems</h1>
      {error ? (
        <ErrorState message={error} />
      ) : !problems ? (
        <div className="flex flex-col gap-2">
          <Skeleton className="h-6 w-2/3" />
          <Skeleton className="h-6 w-1/2" />
          <Skeleton className="h-6 w-3/5" />
        </div>
      ) : problems.length === 0 ? (
        <EmptyState message="No problems yet." />
      ) : (
        <ul className="flex flex-col gap-2">
          {problems.map((p, i) => (
            <li
              key={p._id}
              className="flex items-center justify-between gap-4 rounded-lg border border-line px-4 py-3 hover:border-ink"
            >
              <div className="flex items-center gap-3">
                <span className="font-mono text-sm text-ink/40">{i + 1}</span>
                <Link href={`/problems/${p.slug}`} className="font-body text-ink underline">
                  {p.title}
                </Link>
              </div>
              <span
                className={`rounded-md border px-2 py-1 font-mono text-xs uppercase ${DIFFICULTY_STYLES[p.difficulty]}`}
              >
                {p.difficulty}
              </span>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
