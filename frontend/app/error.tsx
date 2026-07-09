'use client';

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main className="mx-auto flex max-w-md flex-col items-start gap-3 p-10">
      <span className="inline-block rotate-[-2deg] border-2 border-verdict-wa p-[3px] shadow-stamp">
        <span className="block border border-verdict-wa bg-verdict-wa/10 px-3 py-1 font-mono text-sm font-bold uppercase tracking-widest text-verdict-wa">
          Error
        </span>
      </span>
      <h1 className="font-display text-xl font-bold text-ink">Something went wrong</h1>
      <p className="font-body text-sm text-ink/70">
        {error.message || 'An unexpected error occurred.'} Try again, or reload the page.
      </p>
      <button
        onClick={reset}
        className="border border-accent bg-accent/10 px-4 py-2 font-mono text-sm font-semibold uppercase tracking-wide text-accent hover:bg-accent/20"
      >
        Try again
      </button>
    </main>
  );
}
