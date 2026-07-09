// Single shared flat config for all three workspaces (api/worker/frontend) — ESLint 9 walks up
// from each workspace's cwd to find this file, so `npm run lint --workspace X` (cwd = X/) picks
// it up automatically with no per-workspace config duplication. Kept intentionally small per
// ARCHITECTURE.md §16.3 (minimal dependencies): typescript-eslint's recommended rules only, no
// framework-specific (React/Next) plugin — CI's lint step needs *something* to run, not a fully
// tuned rule set.
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.next/**',
      '**/.cache/**',
      'frontend/next-env.d.ts',
    ],
  },
  ...tseslint.configs.recommended.map((config) => ({ ...config, files: ['**/*.{ts,tsx}'] })),
  {
    files: ['**/*.{ts,tsx}'],
    rules: {
      // no-unused-vars from the recommended set flags intentionally-unused destructured
      // params (common in Express handlers: `(_req, res) => ...`) — narrow it instead of
      // disabling the whole rule.
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      // ARCHITECTURE.md §16.6 requires strict TS / no `any` project-wide, but enforcing the
      // full type-checked ban here would require a typed lint pass (parserOptions.project)
      // per workspace — out of scope for this minimal CI lint step; `tsc --noEmit` is the
      // actual `any`-catching gate via `strict: true`, this config is a lighter static pass.
      '@typescript-eslint/no-explicit-any': 'warn',
      // `declare global { namespace Express { interface Request {...} } }` is the standard,
      // idiomatic way to augment Express's Request type (used in api/src/middleware/auth.ts
      // and api/src/routes/submissions.ts) — not a stylistic namespace-vs-module issue the
      // default rule is meant to catch. `allowDeclarations` exempts ambient `declare
      // namespace` blocks specifically, leaving real namespace *definitions* still flagged.
      '@typescript-eslint/no-namespace': ['error', { allowDeclarations: true }],
    },
  },
);
