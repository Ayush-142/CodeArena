'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { useAuth } from '@/components/AuthProvider';
import { ApiError, getAdminContest } from '@/lib/api';
import type { AdminContestDetail } from '@/lib/types';
import { Skeleton } from '@/components/ui/Skeleton';
import { ErrorState } from '@/components/ui/ErrorState';

// Phase 6: first admin UI page in this repo — adminContests.ts was API-only
// before this. Kept deliberately minimal (a two-section button toggle, not a
// general Tabs component) since there's only this one consumer so far.
type Section = 'details' | 'integrity';

const NAKALCHI_WEB_URL = process.env.NEXT_PUBLIC_NAKALCHI_WEB_URL;

function IntegrityStatusBadge({ status }: { status: 'pending' | 'completed' | 'failed' }) {
  const styles: Record<typeof status, string> = {
    pending: 'border-line text-ink/70',
    completed: 'border-verdict-ac text-verdict-ac',
    failed: 'border-verdict-wa text-verdict-wa',
  };
  return <span className={`rounded-md border-2 px-2 py-1 font-mono text-xs font-bold ${styles[status]}`}>{status}</span>;
}

export default function AdminContestDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { status: authStatus, user } = useAuth();

  const [data, setData] = useState<AdminContestDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [section, setSection] = useState<Section>('integrity');

  const refetch = useCallback(() => {
    getAdminContest(id)
      .then(setData)
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Failed to load contest'));
  }, [id]);

  useEffect(() => {
    setData(null);
    setError(null);
    refetch();
  }, [id, refetch]);

  if (authStatus === 'loading') {
    return (
      <main className="flex flex-col gap-4 p-4">
        <Skeleton className="h-7 w-1/3" />
      </main>
    );
  }
  if (authStatus !== 'authenticated' || !user?.isAdmin) {
    return (
      <main className="p-4">
        <ErrorState message="Admin access required." />
      </main>
    );
  }
  if (error) return <main className="p-4"><ErrorState message={error} /></main>;
  if (!data) {
    return (
      <main className="flex flex-col gap-4 p-4">
        <Skeleton className="h-7 w-1/3" />
        <Skeleton className="h-4 w-1/2" />
      </main>
    );
  }

  const { integrityAnalysis } = data;

  return (
    <main className="flex flex-col gap-6 p-4">
      <div>
        <h1 className="font-display text-xl font-bold text-ink">{data.title}</h1>
        <p className="font-mono text-sm text-ink/50">{data.slug}</p>
      </div>

      <div className="flex gap-2">
        {(['details', 'integrity'] as const).map((s) => (
          <button
            key={s}
            onClick={() => setSection(s)}
            className={`rounded-md border-2 px-3 py-2 font-mono text-sm font-bold capitalize ${
              section === s ? 'border-ink bg-surface2 text-ink' : 'border-line bg-transparent text-ink/70 hover:border-ink hover:text-ink'
            }`}
          >
            {s}
          </button>
        ))}
      </div>

      {section === 'details' ? (
        <div className="panel flex flex-col gap-1 p-4 font-mono text-sm text-ink/80">
          <p>Starts: {data.startAt}</p>
          <p>Ends: {data.endAt}</p>
          <p>Problems: {data.problemIds.length}</p>
          <p>Finalized: {data.isFinalized ? 'yes' : 'no'}</p>
        </div>
      ) : (
        <div className="panel flex flex-col gap-3 p-4">
          {!integrityAnalysis ? (
            <p className="font-mono text-sm text-ink/50">
              {data.isFinalized ? 'No integrity analysis has been recorded for this contest yet.' : 'Contest has not finalized yet.'}
            </p>
          ) : (
            <>
              <div className="flex items-center gap-2">
                <IntegrityStatusBadge status={integrityAnalysis.status} />
                {integrityAnalysis.status === 'completed' ? (
                  <span className="font-mono text-sm text-ink/80">
                    {integrityAnalysis.flaggedPairs ?? 0} flagged pair{integrityAnalysis.flaggedPairs === 1 ? '' : 's'}
                    {typeof integrityAnalysis.topSimilarity === 'number'
                      ? ` · top similarity ${(integrityAnalysis.topSimilarity * 100).toFixed(0)}%`
                      : ''}
                  </span>
                ) : null}
              </div>

              {integrityAnalysis.status === 'failed' && integrityAnalysis.error ? (
                <ErrorState message={integrityAnalysis.error} />
              ) : null}

              {/* UI only — no recomputation. Deep-links into Nakalchi's own report pages. */}
              {NAKALCHI_WEB_URL ? (
                <a
                  href={`${NAKALCHI_WEB_URL}/analyses/${integrityAnalysis.analysisId}`}
                  target="_blank"
                  rel="noreferrer"
                  className="btn-secondary w-fit"
                >
                  View full report in Nakalchi
                </a>
              ) : (
                <p className="font-mono text-xs text-ink/50">
                  NEXT_PUBLIC_NAKALCHI_WEB_URL is not configured — cannot deep-link to the report.
                </p>
              )}
            </>
          )}
        </div>
      )}
    </main>
  );
}
