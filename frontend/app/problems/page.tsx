'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { getProblems } from '@/lib/api';
import type { ProblemSummary } from '@/lib/types';

export default function ProblemsPage() {
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

  if (error) return <main className="p-4">{error}</main>;
  if (!problems) return <main className="p-4">Loading…</main>;

  return (
    <main className="p-4">
      <h1 className="mb-4 text-xl font-semibold">Problems</h1>
      <ul className="flex flex-col gap-2">
        {problems.map((p) => (
          <li key={p._id}>
            <Link href={`/problems/${p.slug}`} className="underline">
              {p.title}
            </Link>{' '}
            <span className="text-sm text-slate-400">
              ({p.difficulty}{p.tags.length ? `, ${p.tags.join(', ')}` : ''})
            </span>
          </li>
        ))}
      </ul>
    </main>
  );
}
