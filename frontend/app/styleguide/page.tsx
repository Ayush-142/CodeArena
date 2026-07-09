'use client';

import { useState } from 'react';
import { VerdictBadge } from '@/components/VerdictBadge';
import { LeaderboardCell } from '@/components/LeaderboardCell';
import { MonacoEditorPanel } from '@/components/MonacoEditorPanel';
import type { SubmissionStatus, LeaderboardCell as LeaderboardCellData } from '@/lib/types';

const ALL_STATUSES: SubmissionStatus[] = ['queued', 'running', 'AC', 'WA', 'TLE', 'MLE', 'RE', 'CE'];

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-4 border-t border-line pt-8 first:border-t-0 first:pt-0">
      <h2 className="font-display text-xl font-bold text-ink">{title}</h2>
      {children}
    </section>
  );
}

function Swatch({ name, className, hex }: { name: string; className: string; hex: string }) {
  return (
    <div className="flex flex-col gap-2">
      <div className={`h-16 w-full rounded-lg border border-line ${className}`} />
      <div className="font-mono text-xs text-ink">
        <div className="font-semibold">{name}</div>
        <div className="text-ink/60">{hex}</div>
      </div>
    </div>
  );
}

const PROBLEM_COLUMNS = ['A', 'B', 'C', 'D', 'E', 'F'];

function sampleCell(kind: 'solved' | 'solved-with-penalty' | 'attempted' | 'untouched'): LeaderboardCellData | undefined {
  if (kind === 'solved') return { problemId: 'x', solved: true, solvedAtMinutes: 37, wrongAttempts: 0 };
  if (kind === 'solved-with-penalty') return { problemId: 'x', solved: true, solvedAtMinutes: 37, wrongAttempts: 2 };
  if (kind === 'attempted') return { problemId: 'x', solved: false, wrongAttempts: 3 };
  return undefined;
}

const SAMPLE_ROWS: { rank: number; handle: string; solved: number; penalty: number; kinds: ('solved' | 'solved-with-penalty' | 'attempted' | 'untouched')[] }[] = [
  { rank: 1, handle: 'top_seed', solved: 5, penalty: 214, kinds: ['solved', 'solved', 'solved-with-penalty', 'solved', 'attempted', 'untouched'] },
  { rank: 2, handle: 'second_place', solved: 4, penalty: 188, kinds: ['solved', 'solved', 'attempted', 'solved', 'untouched', 'untouched'] },
  { rank: 3, handle: 'bronze_medal', solved: 3, penalty: 95, kinds: ['solved-with-penalty', 'solved', 'untouched', 'solved', 'attempted', 'untouched'] },
];

export default function StyleguidePage() {
  const [code, setCode] = useState('#include <bits/stdc++.h>\n\nint main() {\n  // Judge Slip Monaco theme\n  std::cout << "AC" << std::endl;\n}\n');
  const [streamText, setStreamText] = useState('Checking the loop bound against the sample where n = 1');

  return (
    <main className="mx-auto flex max-w-5xl flex-col gap-10 p-6">
      <div>
        <h1 className="font-display text-3xl font-bold text-ink">CodeArena Styleguide</h1>
        <p className="mt-2 max-w-2xl font-body text-sm text-ink/70">
          &ldquo;Judge Slip&rdquo; direction — tokens, type, and every shared component state. This
          page ships to production as the living design-system reference; every later slice
          inherits from it. Every bordered box uses a rounded corner (<code>rounded-md</code> for
          chips/inputs, <code>rounded-lg</code> for panels/cards/tables) — keep new boxes rounded too.
        </p>
      </div>

      <Section title="Colors">
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4 md:grid-cols-5">
          <Swatch name="canvas" className="bg-canvas" hex="#0E1113" />
          <Swatch name="surface" className="bg-surface" hex="#171B1E" />
          <Swatch name="ink" className="bg-ink" hex="#E4E7E6" />
          <Swatch name="line" className="bg-line" hex="#3A4045" />
          <Swatch name="accent" className="bg-accent" hex="#3E7CB8" />
          <Swatch name="verdict-ac" className="bg-verdict-ac" hex="#4FA875" />
          <Swatch name="verdict-wa / re" className="bg-verdict-wa" hex="#C6553D" />
          <Swatch name="verdict-tle / mle" className="bg-verdict-tle" hex="#C98A3B" />
          <Swatch name="verdict-ce" className="bg-verdict-ce" hex="#8A8F94" />
        </div>
      </Section>

      <Section title="Type scale">
        <div className="flex flex-col gap-3">
          <p className="font-display text-3xl font-bold text-ink">Display 3xl — Space Grotesk</p>
          <p className="font-display text-xl font-bold text-ink">Display xl — page/section headings</p>
          <p className="font-body text-base text-ink">
            Body base — IBM Plex Sans. Problem statements, form labels, and general prose render in
            this face at 16px with relaxed line height for long-form reading.
          </p>
          <p className="font-body text-sm text-ink/70">Body sm — secondary/meta text, timestamps, counts.</p>
          <p className="font-mono text-sm text-ink">Mono sm — IBM Plex Mono. Code, test I/O, verdict labels.</p>
        </div>
      </Section>

      <Section title="Buttons & inputs">
        <div className="flex flex-wrap items-center gap-4">
          <button className="rounded-md border border-accent bg-accent/10 px-3 py-1.5 font-mono text-sm font-semibold uppercase tracking-wide text-accent hover:bg-accent/20">
            Primary
          </button>
          <button className="rounded-md border border-line px-3 py-1.5 font-mono text-sm uppercase tracking-wide text-ink hover:border-ink">
            Secondary
          </button>
          <button disabled className="rounded-md border border-line px-3 py-1.5 font-mono text-sm uppercase tracking-wide text-ink/40">
            Disabled
          </button>
          <input
            placeholder="handle"
            className="rounded-md border border-line bg-transparent px-3 py-1.5 font-mono text-sm text-ink placeholder:text-ink/40"
          />
        </div>
      </Section>

      <Section title="Cards">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="rounded-lg border border-line bg-surface p-4">
            <h3 className="font-display text-base font-bold text-ink">Panel title</h3>
            <p className="mt-1 font-body text-sm text-ink/70">
              Rounded-corner surface — the base container used for problem cards, hint panels,
              and contest cards.
            </p>
          </div>
          <div className="rounded-lg border-2 border-line bg-surface p-4 shadow-stamp">
            <h3 className="font-display text-base font-bold text-ink">Emphasized panel</h3>
            <p className="mt-1 font-body text-sm text-ink/70">
              Doubled-border-adjacent treatment (thicker border + hard offset shadow) for panels
              that need more visual weight than a default card.
            </p>
          </div>
        </div>
      </Section>

      <Section title="Verdict badges">
        <div className="flex flex-col gap-6">
          <div>
            <h3 className="mb-3 font-mono text-xs uppercase tracking-wide text-ink/50">Stamp variant</h3>
            <div className="flex flex-wrap items-center gap-6">
              {ALL_STATUSES.map((status) => (
                <VerdictBadge key={status} status={status} variant="stamp" />
              ))}
            </div>
          </div>
          <div>
            <h3 className="mb-3 font-mono text-xs uppercase tracking-wide text-ink/50">
              Chip variant (dense tables)
            </h3>
            <div className="flex flex-wrap items-center gap-3">
              {ALL_STATUSES.map((status) => (
                <VerdictBadge key={status} status={status} variant="chip" />
              ))}
            </div>
          </div>
          <div>
            <h3 className="mb-3 font-mono text-xs uppercase tracking-wide text-ink/50">
              With test index / exec time
            </h3>
            <div className="flex flex-wrap items-center gap-6">
              <VerdictBadge status="WA" variant="stamp" failedTestIndex={4} execTimeMs={88} />
              <VerdictBadge status="AC" variant="chip" execTimeMs={42} />
            </div>
          </div>
        </div>
      </Section>

      <Section title="Leaderboard cells">
        <div className="flex flex-wrap items-center gap-4">
          <div className="flex flex-col items-start gap-1">
            <span className="font-mono text-xs text-ink/50">solved</span>
            <LeaderboardCell cell={sampleCell('solved')} />
          </div>
          <div className="flex flex-col items-start gap-1">
            <span className="font-mono text-xs text-ink/50">solved + wrong attempts</span>
            <LeaderboardCell cell={sampleCell('solved-with-penalty')} />
          </div>
          <div className="flex flex-col items-start gap-1">
            <span className="font-mono text-xs text-ink/50">attempted, unsolved</span>
            <LeaderboardCell cell={sampleCell('attempted')} />
          </div>
          <div className="flex flex-col items-start gap-1">
            <span className="font-mono text-xs text-ink/50">untouched</span>
            <LeaderboardCell cell={sampleCell('untouched')} />
          </div>
        </div>
      </Section>

      <Section title="Table density — 100-row / per-problem standings grid">
        <p className="max-w-2xl font-body text-sm text-ink/70">
          Sticky rank + handle columns; the per-problem region scrolls horizontally in its own
          container so the page itself never scrolls sideways. This is the pattern
          ContestLeaderboard inherits.
        </p>
        <div className="overflow-x-auto rounded-lg border border-line">
          <table className="w-full border-collapse text-left font-mono text-sm">
            <thead>
              <tr className="border-b border-line bg-surface">
                <th className="sticky left-0 z-10 min-w-[3rem] border-r border-line bg-surface px-2 py-2 text-ink">
                  #
                </th>
                <th className="sticky left-[3rem] z-10 min-w-[9rem] border-r border-line bg-surface px-2 py-2 text-ink">
                  Handle
                </th>
                <th className="min-w-[4rem] px-2 py-2 text-ink/70">Solved</th>
                <th className="min-w-[4rem] px-2 py-2 text-ink/70">Penalty</th>
                {PROBLEM_COLUMNS.map((label) => (
                  <th key={label} className="min-w-[3.5rem] px-2 py-2 text-center text-ink/70">
                    {label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {SAMPLE_ROWS.map((row, i) => (
                <tr key={row.rank} className={`border-b border-line ${i % 2 === 1 ? 'bg-surface/40' : ''}`}>
                  <td className="sticky left-0 z-10 border-r border-line bg-canvas px-2 py-2 text-ink">
                    {row.rank}
                  </td>
                  <td className="sticky left-[3rem] z-10 border-r border-line bg-canvas px-2 py-2 text-ink">
                    {row.handle}
                  </td>
                  <td className="px-2 py-2 text-ink">{row.solved}</td>
                  <td className="px-2 py-2 text-ink">{row.penalty}</td>
                  {row.kinds.map((kind, j) => (
                    <td key={j} className="px-2 py-2 text-center">
                      <LeaderboardCell cell={sampleCell(kind)} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="font-mono text-xs text-ink/50">Showing top 50 of 214 registered</p>
      </Section>

      <Section title="Loading / streaming states">
        <div className="flex flex-col gap-6">
          <div>
            <h3 className="mb-2 font-mono text-xs uppercase tracking-wide text-ink/50">
              Skeleton (sized to content, no layout shift)
            </h3>
            <div className="flex flex-col gap-2">
              <div className="h-4 w-3/4 animate-pulse rounded-md motion-reduce:animate-none bg-line/40" />
              <div className="h-4 w-1/2 animate-pulse rounded-md motion-reduce:animate-none bg-line/40" />
              <div className="h-24 w-full animate-pulse rounded-lg motion-reduce:animate-none bg-line/40" />
            </div>
          </div>
          <div>
            <h3 className="mb-2 font-mono text-xs uppercase tracking-wide text-ink/50">
              Streaming hint text
            </h3>
            <div className="rounded-lg border border-line bg-surface p-3">
              <p className="font-body text-sm text-ink">
                {streamText}
                <span className="ml-0.5 inline-block h-4 w-2 animate-pulse motion-reduce:animate-none bg-accent align-middle" />
              </p>
              <button
                className="mt-2 font-mono text-xs uppercase tracking-wide text-accent underline"
                onClick={() => setStreamText((t) => `${t}...`)}
              >
                simulate next chunk
              </button>
            </div>
          </div>
        </div>
      </Section>

      <Section title="Monaco theme">
        <div className="max-w-2xl">
          <MonacoEditorPanel code={code} onChange={setCode} />
        </div>
      </Section>
    </main>
  );
}
