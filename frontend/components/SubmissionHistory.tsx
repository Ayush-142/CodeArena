'use client';

import { useEffect, useState } from 'react';
import { getProblemSubmissions } from '@/lib/api';
import type { SubmissionHistoryItem } from '@/lib/types';
import { VerdictBadge } from './VerdictBadge';

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

  if (error) return <p>{error}</p>;
  if (!items) return <p>Loading history…</p>;
  if (items.length === 0) return <p>No submissions yet.</p>;

  return (
    <table className="w-full text-left text-sm">
      <thead>
        <tr>
          <th className="pr-4">Status</th>
          <th className="pr-4">When</th>
          <th className="pr-4">Time</th>
          <th>Language</th>
        </tr>
      </thead>
      <tbody>
        {items.map((item) => (
          <tr key={item._id}>
            <td className="pr-4">
              <VerdictBadge status={item.status} execTimeMs={item.execTimeMs ?? undefined} />
            </td>
            <td className="pr-4">{new Date(item.createdAt).toLocaleString()}</td>
            <td className="pr-4">{item.execTimeMs != null ? `${item.execTimeMs}ms` : '—'}</td>
            <td>{item.language}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
