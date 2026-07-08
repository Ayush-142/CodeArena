import Link from 'next/link';

export default function HomePage() {
  return (
    <main className="min-h-screen bg-slate-950 text-slate-100 p-10">
      <div className="max-w-3xl mx-auto">
        <h1 className="text-4xl font-semibold mb-4">CodeArena</h1>
        <p className="text-lg text-slate-300">
          An online judge platform.{' '}
          <Link href="/problems" className="underline">
            Browse problems
          </Link>
          .
        </p>
      </div>
    </main>
  );
}
