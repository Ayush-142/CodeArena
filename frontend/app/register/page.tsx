'use client';

import { Suspense, useState, type FormEvent } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { useAuth } from '@/components/AuthProvider';
import { ApiError } from '@/lib/api';
import { useDocumentTitle } from '@/lib/useDocumentTitle';
import { ErrorState } from '@/components/ui/ErrorState';

export default function RegisterPage() {
  return (
    <Suspense>
      <RegisterForm />
    </Suspense>
  );
}

function RegisterForm() {
  useDocumentTitle('Register');
  const { register } = useAuth();
  const router = useRouter();
  const searchParams = useSearchParams();
  const [handle, setHandle] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await register(handle, email, password);
      const next = searchParams.get('next') ?? '/';
      router.push(next);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Registration failed');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="mx-auto max-w-sm p-4">
      <h1 className="mb-4 font-display text-xl font-bold text-ink">Register</h1>
      <form onSubmit={handleSubmit} className="flex flex-col gap-3">
        <label className="font-mono text-sm text-ink/70">
          Handle
          <input
            className="mt-1 w-full border border-line bg-transparent p-2 font-body text-ink"
            value={handle}
            onChange={(e) => setHandle(e.target.value)}
            required
          />
        </label>
        <label className="font-mono text-sm text-ink/70">
          Email
          <input
            type="email"
            className="mt-1 w-full border border-line bg-transparent p-2 font-body text-ink"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </label>
        <label className="font-mono text-sm text-ink/70">
          Password
          <input
            type="password"
            className="mt-1 w-full border border-line bg-transparent p-2 font-body text-ink"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={8}
          />
        </label>
        {error ? <ErrorState message={error} /> : null}
        <button
          type="submit"
          disabled={submitting}
          className="border border-accent bg-accent/10 px-4 py-2 font-mono text-sm font-semibold uppercase tracking-wide text-accent hover:bg-accent/20 disabled:opacity-40"
        >
          {submitting ? 'Registering…' : 'Register'}
        </button>
      </form>
      <p className="mt-4 font-body text-sm text-ink/70">
        Already have an account?{' '}
        <Link href="/login" className="text-accent underline">
          Log in
        </Link>
      </p>
    </main>
  );
}
