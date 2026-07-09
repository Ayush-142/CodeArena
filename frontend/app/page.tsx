import Link from 'next/link';
import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'CodeArena' };

export default function HomePage() {
  return (
    <main className="p-10">
      <div className="mx-auto max-w-3xl">
        <h1 className="font-display text-4xl font-bold text-ink">CodeArena</h1>
        <p className="mt-4 font-body text-lg text-ink/70">
          A competitive-programming judge.{' '}
          <Link href="/problems" className="text-accent underline">
            Browse problems
          </Link>
          .
        </p>
      </div>
    </main>
  );
}
