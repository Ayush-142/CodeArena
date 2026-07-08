import type {
  ApiErrorBody,
  AuthUser,
  CreateSubmissionResponse,
  ProblemDetail,
  ProblemSummary,
  SubmissionDetail,
  SubmissionHistoryItem,
} from './types';

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

export const AUTH_UNAUTHORIZED_EVENT = 'auth:unauthorized';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

// 429 responses nest the retry hint under error.details.retryAfterMs (milliseconds) —
// see api/src/middleware/rateLimit.ts.
export function getRetryAfterSeconds(err: unknown): number | null {
  if (!(err instanceof ApiError) || err.code !== 'RATE_LIMITED') return null;
  const retryAfterMs = err.details?.retryAfterMs;
  if (typeof retryAfterMs !== 'number') return null;
  return Math.ceil(retryAfterMs / 1000);
}

interface ApiFetchOptions extends RequestInit {
  // Login/register 401s mean "wrong credentials", not "session expired" — must not trigger
  // the global logged-out reset that other 401s do.
  isCredentialCheck?: boolean;
}

async function apiFetch<T>(path: string, opts: ApiFetchOptions = {}): Promise<T> {
  const { isCredentialCheck, headers, body, ...rest } = opts;

  const res = await fetch(`${API_BASE_URL}${path}`, {
    ...rest,
    body,
    credentials: 'include',
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
  });

  if (res.status === 204) {
    return undefined as T;
  }

  const json = (await res.json().catch(() => null)) as unknown;

  if (!res.ok) {
    const errorBody = json as ApiErrorBody | null;
    const code = errorBody?.error?.code ?? 'UNKNOWN';
    const message = errorBody?.error?.message ?? `Request failed with status ${res.status}`;
    const details = errorBody?.error?.details;

    if (res.status === 401 && !isCredentialCheck && typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent(AUTH_UNAUTHORIZED_EVENT));
    }

    throw new ApiError(res.status, code, message, details);
  }

  return json as T;
}

export function getMe(): Promise<AuthUser> {
  return apiFetch<AuthUser>('/api/auth/me');
}

export function login(handle: string, password: string): Promise<AuthUser> {
  return apiFetch<AuthUser>('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ handle, password }),
    isCredentialCheck: true,
  });
}

export function register(handle: string, email: string, password: string): Promise<AuthUser> {
  return apiFetch<AuthUser>('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ handle, email, password }),
    isCredentialCheck: true,
  });
}

export function logout(): Promise<void> {
  return apiFetch<void>('/api/auth/logout', { method: 'POST' });
}

export function getProblems(): Promise<ProblemSummary[]> {
  return apiFetch<ProblemSummary[]>('/api/problems');
}

export function getProblem(slug: string): Promise<ProblemDetail> {
  return apiFetch<ProblemDetail>(`/api/problems/${slug}`);
}

export function getProblemSubmissions(slug: string): Promise<SubmissionHistoryItem[]> {
  return apiFetch<SubmissionHistoryItem[]>(`/api/problems/${slug}/submissions`);
}

export function createSubmission(
  problemSlug: string,
  code: string,
  language: 'cpp',
  idempotencyKey: string,
): Promise<CreateSubmissionResponse> {
  return apiFetch<CreateSubmissionResponse>('/api/submissions', {
    method: 'POST',
    headers: { 'Idempotency-Key': idempotencyKey },
    body: JSON.stringify({ problemSlug, code, language }),
  });
}

export function getSubmission(id: string): Promise<SubmissionDetail> {
  return apiFetch<SubmissionDetail>(`/api/submissions/${id}`);
}
