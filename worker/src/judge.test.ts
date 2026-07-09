import { describe, it, expect } from 'vitest';
import { compareOutput } from './compare.js';

describe('compareOutput', () => {
  it('matches identical strings', () => {
    expect(compareOutput('6', '6')).toBe(true);
  });

  it('is insensitive to surrounding/trailing whitespace and newlines', () => {
    expect(compareOutput('6\n', '6')).toBe(true);
    expect(compareOutput('  6  ', '6')).toBe(true);
    expect(compareOutput('6\r\n', '6')).toBe(true);
  });

  it('is case-sensitive', () => {
    expect(compareOutput('Yes', 'yes')).toBe(false);
  });

  it('treats empty-vs-empty as a match', () => {
    expect(compareOutput('', '')).toBe(true);
    expect(compareOutput('   \n', '')).toBe(true);
  });

  it('rejects genuinely different output', () => {
    expect(compareOutput('6', '7')).toBe(false);
  });

  it('does NOT normalize internal whitespace (whole-string trim only, not per-line)', () => {
    // Documents the actual behavior (ARCHITECTURE.md previously claimed "per line" — that
    // was doc drift; this pins down the real, single-trim behavior as a regression guard.
    expect(compareOutput('1 2\n3 4', '1  2\n3 4')).toBe(false);
  });
});
