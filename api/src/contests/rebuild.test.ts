import { describe, it, expect, vi } from 'vitest';

// rebuild.ts imports redis/client.ts, which connects to Redis (and reads required env vars)
// as a top-level side effect on import — mock it so importing scoreGroup/packScore/unpackScore
// (all pure, no I/O) doesn't require live infra or a populated .env. This is what keeps this
// suite runnable in CI with zero services.
vi.mock('../redis/client.js', () => ({ redisClient: {} }));

const { scoreGroup, packScore, unpackScore } = await import('./rebuild.js');

const startAt = new Date('2026-01-01T00:00:00.000Z');
function at(minutesAfterStart: number): Date {
  return new Date(startAt.getTime() + minutesAfterStart * 60_000);
}

describe('scoreGroup', () => {
  it('solved with zero wrong attempts', () => {
    const result = scoreGroup([{ status: 'AC', createdAt: at(12) }], startAt);
    expect(result).toEqual({ solved: true, solveMinutes: 12, wrongAttempts: 0 });
  });

  it('solved with wrong attempts before the AC', () => {
    const entries = [
      { status: 'WA', createdAt: at(5) },
      { status: 'TLE', createdAt: at(8) },
      { status: 'AC', createdAt: at(15) },
    ];
    const result = scoreGroup(entries, startAt);
    expect(result).toEqual({ solved: true, solveMinutes: 15, wrongAttempts: 2 });
  });

  it('unsolved with wrong attempts only', () => {
    const entries = [
      { status: 'WA', createdAt: at(3) },
      { status: 'RE', createdAt: at(6) },
    ];
    const result = scoreGroup(entries, startAt);
    expect(result).toEqual({ solved: false, wrongAttempts: 2 });
  });

  it('empty entries: unsolved, zero wrong attempts', () => {
    expect(scoreGroup([], startAt)).toEqual({ solved: false, wrongAttempts: 0 });
  });

  it('CE does not count toward wrongAttempts (per SCORED_WRONG_STATUSES)', () => {
    const entries = [
      { status: 'CE', createdAt: at(1) },
      { status: 'CE', createdAt: at(2) },
      { status: 'AC', createdAt: at(4) },
    ];
    const result = scoreGroup(entries, startAt);
    expect(result).toEqual({ solved: true, solveMinutes: 4, wrongAttempts: 0 });
  });

  it('queued/running entries are silently skipped, not counted as wrong', () => {
    const entries = [
      { status: 'queued', createdAt: at(1) },
      { status: 'running', createdAt: at(2) },
      { status: 'AC', createdAt: at(3) },
    ];
    expect(scoreGroup(entries, startAt)).toEqual({ solved: true, solveMinutes: 3, wrongAttempts: 0 });
  });
});

describe('packScore / unpackScore', () => {
  it('round-trips zero penalty', () => {
    const score = packScore(3, 0);
    expect(unpackScore(score)).toEqual({ solvedCount: 3, penaltyMinutes: 0 });
  });

  it('round-trips a nonzero penalty', () => {
    const score = packScore(1, 20);
    expect(unpackScore(score)).toEqual({ solvedCount: 1, penaltyMinutes: 20 });
  });

  it('regression: Math.ceil (not Math.floor) recovers solvedCount for a 1-solve/20-penalty score', () => {
    // Documented in rebuild.ts's own comment: a real score of 9999980 must decode to
    // 1 solve / 20 penalty, not floor to 0 solves.
    const score = 9_999_980;
    expect(unpackScore(score)).toEqual({ solvedCount: 1, penaltyMinutes: 20 });
  });

  it('round-trips solvedCount 0', () => {
    const score = packScore(0, 0);
    expect(unpackScore(score)).toEqual({ solvedCount: 0, penaltyMinutes: 0 });
  });
});
