// Run once after a Redis outage resolves (see DEMO.md's Redis-outage chapter and
// ARCHITECTURE.md §11's failure-mode table). A submission stays status:'queued' in MongoDB even
// when the BullMQ enqueue itself failed (api/src/routes/submissions.ts's try/catch around
// submissionsQueue.add) — there is no way to tell, from the Mongo document alone, whether a
// 'queued' submission is still legitimately waiting its turn in a healthy queue or was never
// actually enqueued at all. This script uses a time-based heuristic instead: anything still
// 'queued' after STALE_THRESHOLD_MS almost certainly means the enqueue failed, since a healthy
// worker (BullMQ default concurrency 1, but judging a small test suite takes seconds, not
// minutes) picks up new jobs quickly. Re-enqueueing a submission that actually IS still
// legitimately queued is a harmless double-add — judging is idempotent (ARCHITECTURE.md §2
// principle 5), so processing the same submissionId twice just rewrites the same verdict twice.
//
//   npm run recover
import 'dotenv/config'; // MUST be first — same ESM import-hoisting reason as seed.ts.
import mongoose from 'mongoose';
import { Submission } from '../models/Submission.js';
import { submissionsQueue } from '../queue.js';

const STALE_THRESHOLD_MS = 2 * 60 * 1000; // 2 minutes — see the file header for why this is safe

async function main(): Promise<void> {
  await mongoose.connect(process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/codearena');

  const staleCutoff = new Date(Date.now() - STALE_THRESHOLD_MS);
  const stale = await Submission.find({ status: 'queued', createdAt: { $lt: staleCutoff } })
    .select('_id createdAt')
    .lean();

  console.log(`found ${stale.length} submission(s) queued for longer than ${STALE_THRESHOLD_MS / 1000}s`);

  for (const sub of stale) {
    await submissionsQueue.add('judge', { submissionId: sub._id.toString() });
    console.log(`  re-enqueued ${sub._id.toString()} (queued since ${sub.createdAt.toISOString()})`);
  }

  await mongoose.disconnect();
}

await main();
