import Link from 'next/link';

export default function NotFound() {
  return (
    <main className="mx-auto flex max-w-md flex-col items-start gap-3 p-10">
      <span className="inline-block rotate-[-2deg] rounded-lg border-2 border-verdict-wa p-[3px] shadow-stamp">
        <span className="block rounded-md border border-verdict-wa bg-verdict-wa/10 px-3 py-1 font-mono text-sm font-bold uppercase tracking-widest text-verdict-wa">
          404
        </span>
      </span>
      <h1 className="font-display text-xl font-bold text-ink">Page not found</h1>
      <p className="font-body text-sm text-ink/70">
        There&apos;s nothing at this address. Check the link, or go back to problems.
      </p>
      <Link href="/problems" className="font-mono text-sm text-accent underline">
        Back to problems
      </Link>
    </main>
  );
}
