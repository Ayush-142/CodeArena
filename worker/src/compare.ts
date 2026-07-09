// Shared by judge.ts (real judging) and run.ts (Run on samples) so both verdict paths use
// exactly one comparison rule. Whole-string trim, not per-line — this is what the actual
// judging behavior has always been (ARCHITECTURE.md §5 previously claimed "per line", which was
// doc drift, not a code change; fixed alongside this extraction).
export function compareOutput(actual: string, expected: string): boolean {
  return actual.trim() === expected.trim();
}
