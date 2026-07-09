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
      className={`border-b-2 px-0.5 py-1 font-display text-sm font-bold uppercase tracking-wide ${
        active ? 'border-ink text-ink' : 'border-transparent text-ink/50 hover:text-ink'
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
    <header className="flex items-center justify-between border-b-2 border-line bg-canvas px-4 py-3">
      <div className="flex items-center gap-6">
        <Link href="/problems" className="flex items-center gap-2 font-display text-lg font-bold text-ink">
          <span className="flex h-7 w-7 items-center justify-center rounded-md border-2 border-line text-xs font-bold text-ink" aria-hidden="true">
            CA
          </span>
          CodeArena
        </Link>
        <NavLink href="/problems">Problems</NavLink>
        <NavLink href="/contests">Contests</NavLink>
      </div>
      <div className="flex items-center gap-3">
        {status === 'authenticated' && user ? (
          <span className="flex items-center gap-3 font-mono text-sm text-ink/80">
            <span className="flex h-8 w-8 items-center justify-center rounded-full border-2 border-line text-xs font-bold uppercase" aria-hidden="true">
              {user.handle.slice(0, 1)}
            </span>
            {user.handle}
            <button onClick={handleLogout} className="btn-secondary !px-4 !py-1.5 !text-xs">
              Log out
            </button>
          </span>
        ) : status === 'unauthenticated' ? (
          <Link href="/login" className="btn-secondary !px-4 !py-1.5 !text-xs">
            Log in
          </Link>
        ) : null}
      </div>
    </header>
  );
}
