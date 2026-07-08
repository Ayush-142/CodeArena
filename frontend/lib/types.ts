// Types below mirror the API's actual response shapes field-for-field (api/src/routes/*,
// api/src/models/*). Duplicated deliberately rather than imported across workspaces, per
// this repo's established convention for cross-service type drift (see ARCHITECTURE.md §3).

// api/src/routes/auth.ts — register/login/me response shape
export interface AuthUser {
  id: string;
  handle: string;
  email: string;
  isAdmin: boolean;
}

// api/src/routes/problems.ts GET / — bare array, no wrapper
export interface ProblemSummary {
  _id: string;
  title: string;
  slug: string;
  difficulty: 'easy' | 'medium' | 'hard';
  tags: string[];
}

export interface ProblemSample {
  input: string;
  output: string;
  explanation?: string;
}

// api/src/routes/problems.ts GET /:slug
export interface ProblemDetail {
  _id: string;
  slug: string;
  title: string;
  statementMd: string;
  difficulty: 'easy' | 'medium' | 'hard';
  tags: string[];
  timeLimitMs: number;
  memoryLimitMb: number;
  samples: ProblemSample[];
}

// api/src/models/Submission.ts VERDICTS
export type SubmissionStatus = 'queued' | 'running' | 'AC' | 'WA' | 'TLE' | 'MLE' | 'RE' | 'CE';

// api/src/routes/problems.ts GET /:slug/submissions
export interface SubmissionHistoryItem {
  _id: string;
  status: SubmissionStatus;
  createdAt: string;
  execTimeMs: number | null;
  language: 'cpp';
}

// api/src/routes/submissions.ts GET /:id — full raw doc
export interface SubmissionDetail {
  _id: string;
  userId: string;
  problemId: string;
  code: string;
  language: 'cpp';
  status: SubmissionStatus;
  failedTestIndex?: number;
  execTimeMs?: number;
  output?: string;
  compileError?: string;
  idempotencyKey: string;
  createdAt: string;
  updatedAt: string;
}

// api/src/routes/submissions.ts POST / — field is `id`, not `submissionId`, on every
// response path (create, idempotent short-circuit, race recovery)
export interface CreateSubmissionResponse {
  id: string;
}

// api/src/middleware/errors.ts errorHandler
export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
}

// api/src/middleware/rateLimit.ts — nested under error.details, not top-level
export interface RateLimitDetails {
  retryAfterMs: number;
}

// Mirrors api/src/socket/types.ts VerdictClientEvent exactly — this is the client contract,
// do not extend it or read any other field off the socket payload (REST is truth).
export interface VerdictClientEvent {
  submissionId: string;
  verdict: string;
}
