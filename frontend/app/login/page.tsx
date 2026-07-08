'use client';

import { Suspense, useState, type FormEvent } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { useAuth } from '@/components/AuthProvider';
import { ApiError } from '@/lib/api';

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}

function LoginForm() {
  const { login } = useAuth();
  const router = useRouter();
  const searchParams = useSearchParams();
  const [handle, setHandle] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await login(handle, password);
      const next = searchParams.get('next') ?? '/';
      router.push(next);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Login failed');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="mx-auto max-w-sm p-4">
      <h1 className="mb-4 text-xl font-semibold">Log in</h1>
      <form onSubmit={handleSubmit} className="flex flex-col gap-3">
        <label>
          Handle
          <input
            className="mt-1 w-full border border-slate-600 bg-transparent p-2"
            value={handle}
            onChange={(e) => setHandle(e.target.value)}
            required
          />
        </label>
        <label>
          Password
          <input
            type="password"
            className="mt-1 w-full border border-slate-600 bg-transparent p-2"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </label>
        {error ? <p className="text-red-400">{error}</p> : null}
        <button type="submit" disabled={submitting} className="border border-slate-600 p-2">
          {submitting ? 'Logging in…' : 'Log in'}
        </button>
      </form>
      <p className="mt-4">
        No account? <Link href="/register" className="underline">Register</Link>
      </p>
    </main>
  );
}
