'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAuth } from './AuthProvider';

export function Header() {
  const { status, user, logout } = useAuth();
  const router = useRouter();

  async function handleLogout() {
    await logout();
    router.push('/');
  }

  return (
    <header className="flex items-center justify-between border-b border-slate-700 px-4 py-3">
      <Link href="/problems" className="font-semibold">
        CodeArena
      </Link>
      <div>
        {status === 'authenticated' && user ? (
          <span>
            logged in as {user.handle}{' '}
            <button onClick={handleLogout} className="ml-2 underline">
              logout
            </button>
          </span>
        ) : status === 'unauthenticated' ? (
          <Link href="/login" className="underline">
            Log in
          </Link>
        ) : null}
      </div>
    </header>
  );
}
