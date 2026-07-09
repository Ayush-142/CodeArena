import { describe, it, expect, vi } from 'vitest';

// llm.ts imports config/env.ts (throws at import time without JWT_SECRET/GEMINI_API_KEY set)
// and redis/client.ts (connects to Redis at import time) as side effects of module load, and
// constructs a GoogleGenAI client from env.geminiApiKey — none of which normalizeCode/
// computeFailureSignature (pure, no I/O) actually need. Mocked so this suite runs with zero
// infra and no .env file, per the CI "no infra" requirement.
vi.mock('../config/env.js', () => ({ env: { geminiApiKey: 'test-key', geminiModel: 'test-model' } }));
vi.mock('../redis/client.js', () => ({ redisClient: {} }));

const { normalizeCode, computeFailureSignature } = await import('./llm.js');

describe('normalizeCode', () => {
  it('strips C++ line comments', () => {
    expect(normalizeCode('int x = 1; // set x')).toBe('int x = 1;');
  });

  it('strips C++ block comments, including multi-line', () => {
    expect(normalizeCode('int x /* a\nb */ = 1;')).toBe('int x = 1;');
  });

  it('collapses whitespace runs to a single space', () => {
    expect(normalizeCode('int   x  =\n\n1;')).toBe('int x = 1;');
  });

  it('leaves code semantics untouched (only comments/whitespace are stripped)', () => {
    const code = 'int add(int a, int b) { return a + b; }';
    expect(normalizeCode(code)).toBe(code);
  });
});

describe('computeFailureSignature', () => {
  it('is deterministic for identical inputs', () => {
    const a = computeFailureSignature('WA', 2, 'int main() {}');
    const b = computeFailureSignature('WA', 2, 'int main() {}');
    expect(a).toBe(b);
  });

  it('differs when verdict changes', () => {
    const a = computeFailureSignature('WA', 2, 'int main() {}');
    const b = computeFailureSignature('TLE', 2, 'int main() {}');
    expect(a).not.toBe(b);
  });

  it('differs when failedTestIndex changes', () => {
    const a = computeFailureSignature('WA', 2, 'int main() {}');
    const b = computeFailureSignature('WA', 3, 'int main() {}');
    expect(a).not.toBe(b);
  });

  it('differs when code changes', () => {
    const a = computeFailureSignature('WA', 2, 'int main() { return 0; }');
    const b = computeFailureSignature('WA', 2, 'int main() { return 1; }');
    expect(a).not.toBe(b);
  });

  it('is stable across insignificant whitespace/comment differences (via normalizeCode)', () => {
    const a = computeFailureSignature('WA', 2, 'int main() {\n  return 0; // done\n}');
    const b = computeFailureSignature('WA', 2, 'int main() { return 0; }');
    expect(a).toBe(b);
  });

  it('treats a missing failedTestIndex consistently', () => {
    const a = computeFailureSignature('CE', undefined, 'int main() {}');
    const b = computeFailureSignature('CE', undefined, 'int main() {}');
    expect(a).toBe(b);
  });
});
