import type {
  AdminContestDetail,
  ApiErrorBody,
  AuthUser,
  ContestDetailResponse,
  ContestListResponse,
  CreateSubmissionResponse,
  HintResponse,
  HintSummary,
  LeaderboardResponse,
  LeaderboardUserCellsResponse,
  ProblemDetail,
  ProblemSummary,
  RegisterContestResponse,
  RunResponse,
  SubmissionDetail,
  SubmissionHistoryItem,
} from './types';

// Every request path below already starts with /api (createSubmission -> '/api/submissions',
// etc.), so NEXT_PUBLIC_API_URL must be the bare origin — a trailing slash or an accidental
// /api suffix in the env value would double up into /api/api/* and 404 every request (this
// happened for real in production — see .env.production.example's comment). Normalize once at
// module load so a misconfigured env value self-corrects instead of silently breaking the app.
function normalizeApiBaseUrl(raw: string): string {
  const strippedSlash = raw.replace(/\/+$/, '');
  const normalized = strippedSlash.replace(/\/api$/, '');
  if (normalized !== raw && process.env.NODE_ENV !== 'production') {
    console.warn(
      `[api] NEXT_PUBLIC_API_URL was "${raw}" — normalized to "${normalized}". Set it to the ` +
        'bare origin (no trailing slash, no /api suffix) to avoid relying on this fallback.',
    );
  }
  return normalized;
}

const API_BASE_URL = normalizeApiBaseUrl(process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001');

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
  contestId?: string,
): Promise<CreateSubmissionResponse> {
  return apiFetch<CreateSubmissionResponse>('/api/submissions', {
    method: 'POST',
    headers: { 'Idempotency-Key': idempotencyKey },
    body: JSON.stringify({ problemSlug, code, language, ...(contestId ? { contestId } : {}) }),
  });
}

export function getSubmission(id: string): Promise<SubmissionDetail> {
  return apiFetch<SubmissionDetail>(`/api/submissions/${id}`);
}

// "Run on samples" — no Idempotency-Key (there's no persisted document to dedupe against;
// the rl:run:{userId} 1-per-3s window is what prevents a double-click from firing two runs).
export function createRun(
  problemSlug: string,
  code: string,
  language: 'cpp',
  contestId?: string,
): Promise<{ runId: string }> {
  return apiFetch<{ runId: string }>('/api/run', {
    method: 'POST',
    body: JSON.stringify({ problemSlug, code, language, ...(contestId ? { contestId } : {}) }),
  });
}

export function getRun(runId: string): Promise<RunResponse> {
  return apiFetch<RunResponse>(`/api/run/${runId}`);
}

export function getContests(): Promise<ContestListResponse> {
  return apiFetch<ContestListResponse>('/api/contests');
}

export function getContest(id: string): Promise<ContestDetailResponse> {
  return apiFetch<ContestDetailResponse>(`/api/contests/${id}`);
}

export function registerForContest(id: string): Promise<RegisterContestResponse> {
  return apiFetch<RegisterContestResponse>(`/api/contests/${id}/register`, { method: 'POST' });
}

// Phase 6: contest admin UI's Integrity section (app/admin/contests/[id]/page.tsx).
export function getAdminContest(id: string): Promise<AdminContestDetail> {
  return apiFetch<AdminContestDetail>(`/api/admin/contests/${id}`);
}

export function getContestLeaderboard(id: string, offset = 0, limit = 50): Promise<LeaderboardResponse> {
  return apiFetch<LeaderboardResponse>(`/api/contests/${id}/leaderboard?offset=${offset}&limit=${limit}`);
}

// Live-contest row expansion only; finalized rows already embed `cells` inline.
export function getContestLeaderboardUserCells(
  contestId: string,
  userId: string,
): Promise<LeaderboardUserCellsResponse> {
  return apiFetch<LeaderboardUserCellsResponse>(`/api/contests/${contestId}/leaderboard/${userId}`);
}

export function requestHint(submissionId: string, level: 1 | 2 | 3): Promise<HintResponse> {
  return apiFetch<HintResponse>('/api/hints', {
    method: 'POST',
    body: JSON.stringify({ submissionId, level }),
  });
}

export function getProblemHints(slug: string): Promise<HintSummary[]> {
  return apiFetch<HintSummary[]>(`/api/problems/${slug}/hints`);
}
