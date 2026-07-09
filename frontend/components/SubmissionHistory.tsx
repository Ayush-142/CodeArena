'use client';

import { useEffect, useState } from 'react';
import { getProblemSubmissions } from '@/lib/api';
import type { SubmissionHistoryItem } from '@/lib/types';
import { VerdictBadge } from './VerdictBadge';
import { Skeleton } from './ui/Skeleton';
import { ErrorState } from './ui/ErrorState';
import { EmptyState } from './ui/EmptyState';

export function SubmissionHistory({ slug, refreshKey }: { slug: string; refreshKey: number }) {
  const [items, setItems] = useState<SubmissionHistoryItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getProblemSubmissions(slug)
      .then((data) => {
        if (!cancelled) setItems(data);
      })
      .catch(() => {
        if (!cancelled) setError('Failed to load submission history');
      });
    return () => {
      cancelled = true;
    };
  }, [slug, refreshKey]);

  if (error) return <ErrorState message={error} />;
  if (!items) {
    return (
      <div className="flex flex-col gap-2">
        <Skeleton className="h-5 w-full" />
        <Skeleton className="h-5 w-full" />
      </div>
    );
  }
  if (items.length === 0) return <EmptyState message="No submissions yet." />;

  return (
    <div className="overflow-hidden rounded-lg border border-line">
      <table className="w-full border-collapse text-left font-mono text-sm text-ink">
        <thead>
          <tr className="border-b border-line bg-surface text-ink/60">
            <th className="py-1 pl-3 pr-4 font-normal">Status</th>
            <th className="py-1 pr-4 font-normal">When</th>
            <th className="py-1 pr-4 font-normal">Time</th>
            <th className="py-1 pr-3 font-normal">Language</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item, i) => (
            <tr key={item._id} className={i % 2 === 1 ? 'bg-surface/40' : ''}>
              <td className="py-1.5 pl-3 pr-4">
                <VerdictBadge status={item.status} execTimeMs={item.execTimeMs ?? undefined} variant="chip" />
              </td>
              <td className="py-1.5 pr-4">{new Date(item.createdAt).toLocaleString()}</td>
              <td className="py-1.5 pr-4">{item.execTimeMs != null ? `${item.execTimeMs}ms` : '—'}</td>
              <td className="py-1.5 pr-3">{item.language}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
