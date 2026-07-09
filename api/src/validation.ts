import { AppError } from './middleware/errors.js';

// Shared by POST /api/submissions and POST /api/run so the two routes can never drift on
// this security/cost-relevant check. ARCHITECTURE.md §4 has always claimed code is "capped
// at 64KB by API validation" — until now that cap didn't actually exist in code (only
// express.json()'s own ~100kb default body-parser ceiling did). This closes that gap for
// both routes at once rather than giving Run a different limit than Submit.
const MAX_CODE_BYTES = 64 * 1024;

export function validateCodeSubmission(input: { code: unknown; language: unknown }): {
  code: string;
  language: 'cpp';
} {
  const { code, language } = input;
  if (typeof code !== 'string' || code.trim().length === 0) {
    throw new AppError(400, 'VALIDATION_ERROR', 'code must be a non-empty string');
  }
  if (Buffer.byteLength(code, 'utf8') > MAX_CODE_BYTES) {
    throw new AppError(400, 'VALIDATION_ERROR', 'code exceeds the 64KB limit');
  }
  if (language !== 'cpp') {
    throw new AppError(400, 'VALIDATION_ERROR', "language must be 'cpp'");
  }
  return { code, language };
}
