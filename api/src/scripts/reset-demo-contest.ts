// Makes the live demo contest re-runnable without manual Mongo surgery: shifts it to "about to
// start", wipes its submissions + any bot users from a prior simulate-contest.ts run, and
// re-hides its problems. Run before each live demo (see DEMO.md).
//
// npm run reset-demo   (wired in api/package.json, proxied from root like `seed`/`simulate-contest`)
import 'dotenv/config'; // MUST be first — same ESM import-hoisting reason as seed.ts (models/
// rebuild.js transitively read process.env at module-eval time, before any of this file's own
// top-level code would otherwise run dotenv.config()).
import mongoose from 'mongoose';
import { Contest } from '../models/Contest.js';
import { Submission } from '../models/Submission.js';
import { Problem } from '../models/Problem.js';
import { User } from '../models/User.js';
import { redisClient } from '../redis/client.js';

// Deliberately duplicated from seed.ts's own LIVE_DEMO_CONTEST_SLUG constant rather than
// imported — seed.ts's last line is a top-level `await main()` that seeds the ENTIRE demo
// dataset, so importing anything from that module would re-run the whole seed as a side effect.
// Matches this repo's established "duplicate deliberately, with a comment" convention.
const LIVE_DEMO_CONTEST_SLUG = 'demo-live-contest';

// Must match the prefix simulate-contest.ts uses when registering bot accounts. Handles are
// alphanumeric-only (api/src/routes/auth.ts's HANDLE_RE has no underscore), so this is a plain
// prefix like "bot0001", not "bot_0001".
const BOT_HANDLE_PREFIX = 'bot';

const startOffsetMinutes = Number(process.env.DEMO_CONTEST_START_OFFSET_MINUTES) || 2;
const windowMinutes = Number(process.env.DEMO_CONTEST_WINDOW_MINUTES) || 15;

async function main(): Promise<void> {
  await mongoose.connect(process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/codearena');

  const contest = await Contest.findOne({ slug: LIVE_DEMO_CONTEST_SLUG });
  if (!contest) {
    throw new Error(`demo contest "${LIVE_DEMO_CONTEST_SLUG}" not found — run "npm run seed" first`);
  }

  const startAt = new Date(Date.now() + startOffsetMinutes * 60 * 1000);
  const endAt = new Date(startAt.getTime() + windowMinutes * 60 * 1000);

  // Wipe this contest's submissions (real or bot) so standings start from zero.
  const { deletedCount: submissionsDeleted } = await Submission.deleteMany({ contestId: contest._id });

  // Bot users are scoped to this one contest by construction — simulate-contest.ts only ever
  // registers/uses them against this fixed slug — so it's safe to delete unconditionally by
  // handle prefix rather than cross-referencing which contest they last competed in.
  const { deletedCount: botsDeleted } = await User.deleteMany({ handle: { $regex: `^${BOT_HANDLE_PREFIX}` } });

  await Contest.updateOne(
    { _id: contest._id },
    { $set: { startAt, endAt, isFinalized: false, finalStandings: [], registeredUserIds: [] } },
  );

  // The live leaderboard is a Redis ZSET (lb:{contestId}), updated only by ZINCRBY on each AC
  // (worker/src/scoring.ts) — deleting the underlying Submissions/Users above does nothing to
  // it, so without this, a fresh run's leaderboard would still show stale scores for bot
  // accounts that no longer exist. Safe to drop unconditionally: it's a cache, reconstructible
  // from MongoDB (ARCHITECTURE.md §7), and this contest has no submissions left to rebuild from.
  await redisClient.del(`lb:${contest._id.toString()}`);

  // Finalizing a previous demo run flips these problems isPublished:true (tryFinalizeContest,
  // api/src/contests/rebuild.ts). Undone here, or a second consecutive demo run would start
  // with its problems already public — silently breaking the pre-start/registration gating the
  // whole demo is meant to exercise. isPublished is a property of the Problem document itself,
  // so this is safe precisely because these problems are reserved for this one contest (see
  // seed.ts's seedLiveDemoContest — they're deliberately not reused by any other contest).
  await Problem.updateMany({ _id: { $in: contest.problemIds } }, { $set: { isPublished: false } });

  console.log(
    `reset demo contest "${LIVE_DEMO_CONTEST_SLUG}": startAt=${startAt.toISOString()} endAt=${endAt.toISOString()}\n` +
      `  removed ${submissionsDeleted} submissions, ${botsDeleted} bot users\n` +
      `  ${contest.problemIds.length} problem(s) reset to isPublished:false`,
  );

  await mongoose.disconnect();
  await redisClient.quit();
}

await main();
