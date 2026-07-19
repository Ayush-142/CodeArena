# Bug Log

Running, append-only log of bugs or notable findings encountered during
CodeArena's development and operation. Never rewrite or delete a past
entry; only append new ones below the divider.

Entry format:

```
## YYYY-MM-DD

- **Symptom:**
- **Root cause:**
- **Fix applied:**
- **Verified by:**
```

---

## 2026-07-19

- **Symptom:** while planning a Nakalchi-integration smoke test against
  this live deployment, found that `api/src/scripts/simulate-contest.ts`'s
  `cleanup()` function (lines 340-352) matches bot/load-test accounts to
  delete via `User.find({handle: {$regex: '^(bot|load)'}})` — an
  **unanchored** prefix regex. On the live production database this
  matched **60 pre-existing accounts** (`bot01` through `bot60`, from
  prior load-testing — see the `load-test-*`/`demo-live-contest` Contest
  docs also sitting unfinalized in the DB), not just whatever bots the
  *current* script invocation created. Running `--cleanup` as documented
  would have deleted all 60 of those pre-existing accounts and every
  submission they ever made, not just the current run's bots.
- **Root cause:** the regex `^(bot|load)` matches on prefix only, with no
  upper bound on the handle format that follows. The script's own
  `botHandle()` helper (line 83-85) always zero-pads to 4 digits
  (`bot0001`, `bot0002`, ...), so a *correct* cleanup filter would be
  anchored and format-aware, e.g. `^(bot|load)\d{4}$` — but `cleanup()`
  was written more loosely and happens to also catch older/differently-
  formatted bot handles (`bot01`..`bot60`, 2-digit, no leading zeros to 4)
  that predate the current zero-padding convention.
- **Fix applied:** none yet — deliberately not fixed mid-smoke-test (per
  review: don't touch a script the smoke test's own manual cleanup
  doesn't depend on, while other prod changes are in flight). **Avoided
  entirely** by not running `--cleanup` against this database at all; did
  a fully manual, surgical cleanup instead (exact handle / exact userId /
  exact contestId, count-verified) for the smoke test's own `bot0001`/
  `bot0002` accounts. If the trivial fix (anchor + exact 4-digit format,
  e.g. `^(bot|load)\d{4}$`) is applied, it should be staged as an
  uncommitted edit for review, not committed automatically — flagged
  alongside the other post-smoke-test review items.
- **Verified by:** direct query against the live DB,
  `db.users.find({handle: {$regex: '^(bot|load)'}})`, returned exactly
  `bot01` through `bot60` (60 accounts) before the smoke test's own
  `bot0001`/`bot0002` were even created — confirms the collision risk was
  real, not hypothetical.

- **Pre-existing prod hygiene item, out of scope to clean now:** the same
  query above found 60 stale `bot01`-`bot60` accounts and 4 unfinalized
  `load-test-*` Contest docs (`load-test-1784020842878`,
  `load-test-v2-1784034535725`, `load-test-v3-1784035244110`,
  `load-test-v4-1784056630450`) plus an unfinalized `demo-live-contest`,
  all left over from prior load-testing sessions. Not cleaned up as part
  of this entry - noted for the record so a future cleanup pass has a
  starting point, not discovered fresh again.
