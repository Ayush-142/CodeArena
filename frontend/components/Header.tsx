'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useAuth } from './AuthProvider';

function NavLink({ href, children }: { href: string; children: React.ReactNode }) {
  const pathname = usePathname();
  const active = pathname === href || pathname.startsWith(`${href}/`);
  return (
    <Link
      href={href}
      className={`border-b-2 px-0.5 py-1 font-mono text-sm uppercase tracking-wide ${
        active ? 'border-accent text-ink' : 'border-transparent text-ink/60 hover:text-ink'
      }`}
    >
      {children}
    </Link>
  );
}

export function Header() {
  const { status, user, logout } = useAuth();
  const router = useRouter();

  async function handleLogout() {
    await logout();
    router.push('/');
  }

  return (
    <header className="flex items-center justify-between border-b border-line bg-canvas px-4 py-3">
      <div className="flex items-center gap-6">
        <Link href="/problems" className="flex items-center gap-2 font-display text-lg font-bold text-ink">
          <span className="inline-block h-3 w-3 rotate-[-8deg] rounded-sm border-2 border-accent" aria-hidden="true" />
          CodeArena
        </Link>
        <NavLink href="/problems">Problems</NavLink>
        <NavLink href="/contests">Contests</NavLink>
      </div>
      <div className="flex items-center gap-3">
        {status === 'authenticated' && user ? (
          <span className="flex items-center gap-3 font-mono text-sm text-ink/70">
            {user.handle}
            <button
              onClick={handleLogout}
              className="rounded-md border border-line px-2 py-1 font-mono text-xs uppercase tracking-wide text-ink hover:border-ink"
            >
              Log out
            </button>
          </span>
        ) : status === 'unauthenticated' ? (
          <Link
            href="/login"
            className="rounded-md border border-accent bg-accent/10 px-2 py-1 font-mono text-xs uppercase tracking-wide text-accent hover:bg-accent/20"
          >
            Log in
          </Link>
        ) : null}
      </div>
    </header>
  );
}
