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
  easy: 'text-verdict-ac',
  medium: 'text-verdict-tle',
  hard: 'text-verdict-wa',
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
          {problems.map((p) => (
            <li key={p._id} className="border border-line px-3 py-2 hover:border-ink">
              <Link href={`/problems/${p.slug}`} className="font-body text-ink underline">
                {p.title}
              </Link>{' '}
              <span className={`font-mono text-xs uppercase ${DIFFICULTY_STYLES[p.difficulty]}`}>
                {p.difficulty}
              </span>
              {p.tags.length ? (
                <span className="ml-2 font-mono text-xs text-ink/50">{p.tags.join(', ')}</span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
