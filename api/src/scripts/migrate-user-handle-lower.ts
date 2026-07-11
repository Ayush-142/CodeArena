// One-time migration for the handle/email uniqueness fix (see ARCHITECTURE.md §4).
//
// `User.handleLower` is a new required+unique field (api/src/models/User.ts) derived from
// `handle` by a pre-validate hook — but that hook only runs on `.save()`/`.create()`, so every
// EXISTING document in the collection is missing it. A unique index cannot be built while
// documents are missing the indexed field inconsistently (some null, some absent) or while two
// documents would collide on it (case-variant handles), so this must run, in order:
//
//   1. Backfill `handleLower` on every existing user from their current `handle`.
//   2. Detect duplicate groups (same handleLower, or same email) — report them.
//   3. Dry-run by default: reports what it WOULD do and exits 1 without writing anything if any
//      duplicate group contains a handle that isn't recognized bot/demo/seed data. Pass --apply
//      to actually perform step 1's backfill and, if every duplicate group is fully resolvable
//      automatically (see resolveGroup below), step 3's rename.
//   4. Once no duplicates remain, calls User.syncIndexes() to explicitly build the new
//      `handleLower` unique index (and drop the old unique constraint directly on `handle`,
//      which the schema no longer declares — see User.ts).
//
//   npm run migrate:user-handle-lower           # dry run — reports only, exits 1 if unresolved
//   npm run migrate:user-handle-lower -- --apply  # backfills + auto-resolves recognized dupes + syncIndexes
import 'dotenv/config';
import mongoose from 'mongoose';
import { User } from '../models/User.js';

const APPLY = process.argv.includes('--apply');

// Handles created by seed.ts / simulate-contest.ts — safe to auto-rename if they ever collide,
// since they're regenerated deterministically on the next seed/simulate run anyway. Anything
// else in a duplicate group is a real user account and must be resolved by hand.
const RECOGNIZED_PREFIXES = ['bot', 'load', 'demo'];
const RECOGNIZED_EXACT = new Set(['admin', 'alice', 'bob', 'carol', 'dave']);

function isRecognizedTestHandle(handle: string): boolean {
  const lower = handle.toLowerCase();
  return RECOGNIZED_EXACT.has(lower) || RECOGNIZED_PREFIXES.some((p) => lower.startsWith(p));
}

interface UserRow {
  _id: mongoose.Types.ObjectId;
  handle: string;
  email: string;
  createdAt?: Date;
}

async function findDuplicateGroups(field: 'handleLower' | 'email'): Promise<UserRow[][]> {
  const key = field === 'handleLower' ? { $toLower: '$handle' } : '$email';
  const groups = await User.collection
    .aggregate<{ _id: string; docs: UserRow[] }>([
      { $project: { handle: 1, email: 1, createdAt: 1, _key: key } },
      { $group: { _id: '$_key', docs: { $push: { _id: '$_id', handle: '$handle', email: '$email', createdAt: '$createdAt' } } } },
      { $match: { 'docs.1': { $exists: true } } },
    ])
    .toArray();
  return groups.map((g) => g.docs);
}

async function main(): Promise<void> {
  await mongoose.connect(process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/codearena');

  const handleDupes = await findDuplicateGroups('handleLower');
  const emailDupes = await findDuplicateGroups('email');

  if (handleDupes.length === 0 && emailDupes.length === 0) {
    console.log('no duplicate handles or emails found.');
  }

  let blocked = false;

  for (const group of handleDupes) {
    console.log(`duplicate handle (case-insensitive): ${group.map((u) => `"${u.handle}"(${u._id})`).join(', ')}`);
    const allRecognized = group.every((u) => isRecognizedTestHandle(u.handle));
    if (!allRecognized) {
      console.log('  -> contains a handle NOT recognized as bot/demo/seed data — needs manual review, refusing to auto-resolve.');
      blocked = true;
      continue;
    }
    if (!APPLY) {
      console.log('  -> all handles recognized as test data; would rename all but the oldest (run with --apply).');
      continue;
    }
    const sorted = [...group].sort((a, b) => a._id.getTimestamp().getTime() - b._id.getTimestamp().getTime());
    const [keep, ...rest] = sorted;
    console.log(`  -> keeping "${keep.handle}" (${keep._id}, oldest)`);
    for (let i = 0; i < rest.length; i++) {
      const dupe = rest[i];
      const newHandle = `${dupe.handle}-dup${i + 2}`;
      await User.collection.updateOne(
        { _id: dupe._id },
        { $set: { handle: newHandle, handleLower: newHandle.toLowerCase() } },
      );
      console.log(`  -> renamed "${dupe.handle}" (${dupe._id}) to "${newHandle}"`);
    }
  }

  for (const group of emailDupes) {
    console.log(`duplicate email: ${group.map((u) => `"${u.email}"(${u._id})`).join(', ')}`);
    console.log('  -> email duplicates are never auto-resolved (renaming an email is not safe to guess) — needs manual review.');
    blocked = true;
  }

  if (blocked) {
    console.log('\nmigration stopped: unresolved duplicates require manual review before the unique index can be built.');
    await mongoose.disconnect();
    process.exit(1);
  }

  if (!APPLY) {
    console.log('\ndry run complete. Re-run with --apply to backfill handleLower and build the unique index.');
    await mongoose.disconnect();
    return;
  }

  // Backfill handleLower on every doc (including ones untouched by the dedup step above) —
  // bulkWrite against the raw collection so this never triggers full schema validation on
  // documents that may predate other now-required fields.
  const all = await User.collection.find({}, { projection: { handle: 1 } }).toArray();
  if (all.length > 0) {
    await User.collection.bulkWrite(
      all.map((u) => ({
        updateOne: {
          filter: { _id: u._id },
          update: { $set: { handleLower: String(u.handle).toLowerCase() } },
        },
      })),
    );
  }
  console.log(`backfilled handleLower on ${all.length} user(s).`);

  await User.syncIndexes();
  console.log('syncIndexes() complete — handleLower unique index is now built.');

  await mongoose.disconnect();
}

await main();
