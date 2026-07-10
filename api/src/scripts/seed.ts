import 'dotenv/config'; // MUST be first: contests/rebuild.js transitively imports config/env.js,
// which reads process.env at module-eval time — ESM hoists all static imports before any of
// this file's own top-level code runs, so a later `dotenv.config()` call is too late.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { Problem } from '../models/Problem.js';
import { User } from '../models/User.js';
import { Contest } from '../models/Contest.js';
import { Submission } from '../models/Submission.js';
import { backfillFinalStandingsCells } from '../contests/rebuild.js';
import { s3, BUCKET, ensureBucket } from '../storage.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROBLEMS_DIR = join(__dirname, '../../../problems');

// Same cost factor as the real register route (api/src/routes/auth.ts) — demo accounts must
// hash identically, or a login attempt with the documented demo password would fail.
const BCRYPT_COST = 10;
const DEMO_PASSWORD = 'DemoPass123'; // documented in README/DEMO.md — these are seed accounts, not real users

// Fixed slug so reset-demo-contest.ts (api/src/scripts/reset-demo-contest.ts) and
// simulate-contest.ts can find this contest deterministically across runs.
export const LIVE_DEMO_CONTEST_SLUG = 'demo-live-contest';
const PAST_DEMO_CONTEST_SLUG = 'winter-open';

interface Config {
  title: string;
  difficulty: 'easy' | 'medium' | 'hard';
  tags: string[];
  timeLimitMs: number;
  memoryLimitMb: number;
}

function listPairIndices(dir: string): string[] {
  const files = readdirSync(dir);
  const indices = new Set<string>();
  for (const f of files) {
    if (f.endsWith('.in')) indices.add(f.slice(0, -3));
  }
  const sorted = [...indices].sort();
  for (const idx of sorted) {
    const inPath = join(dir, `${idx}.in`);
    const outPath = join(dir, `${idx}.out`);
    if (!existsSync(outPath)) {
      throw new Error(`${inPath} has no matching ${outPath}`);
    }
  }
  return sorted;
}

async function seedProblem(slug: string): Promise<void> {
  const dir = join(PROBLEMS_DIR, slug);
  const config: Config = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'));
  const statementMd = readFileSync(join(dir, 'statement.md'), 'utf8');

  const samplesDir = join(dir, 'samples');
  const samples = listPairIndices(samplesDir).map((idx) => {
    const explanationPath = join(samplesDir, `${idx}.explanation.md`);
    return {
      input: readFileSync(join(samplesDir, `${idx}.in`), 'utf8'),
      output: readFileSync(join(samplesDir, `${idx}.out`), 'utf8'),
      ...(existsSync(explanationPath)
        ? { explanation: readFileSync(explanationPath, 'utf8') }
        : {}),
    };
  });

  const testsDir = join(dir, 'tests');
  const testIndices = listPairIndices(testsDir);
  const testcases = [];
  for (const idx of testIndices) {
    const inputKey = `problems/${slug}/tests/${idx}.in`;
    const outputKey = `problems/${slug}/tests/${idx}.out`;
    await s3.send(
      new PutObjectCommand({
        Bucket: BUCKET,
        Key: inputKey,
        Body: readFileSync(join(testsDir, `${idx}.in`)),
      }),
    );
    await s3.send(
      new PutObjectCommand({
        Bucket: BUCKET,
        Key: outputKey,
        Body: readFileSync(join(testsDir, `${idx}.out`)),
      }),
    );
    testcases.push({ key: idx, inputKey, outputKey });
  }

  await Problem.findOneAndUpdate(
    { slug },
    {
      slug,
      title: config.title,
      statementMd,
      difficulty: config.difficulty,
      tags: config.tags,
      timeLimitMs: config.timeLimitMs,
      memoryLimitMb: config.memoryLimitMb,
      samples,
      testcases,
      isPublished: true,
    },
    { upsert: true, new: true },
  );

  console.log(`seeded ${slug}: ${samples.length} samples, ${testcases.length} tests`);
}

interface DemoUserSpec {
  handle: string;
  email: string;
  isAdmin: boolean;
}

const DEMO_USERS: DemoUserSpec[] = [
  { handle: 'admin', email: 'admin@codearena.dev', isAdmin: true },
  { handle: 'alice', email: 'alice@codearena.dev', isAdmin: false },
  { handle: 'bob', email: 'bob@codearena.dev', isAdmin: false },
  { handle: 'carol', email: 'carol@codearena.dev', isAdmin: false },
  { handle: 'dave', email: 'dave@codearena.dev', isAdmin: false },
];

// One admin (for the admin-gated contest routes) + four demo users, all sharing DEMO_PASSWORD
// (documented in README/DEMO.md — these are seed accounts, not real credentials). Upserted by
// handle, so safe to re-run; the password hash is recomputed each run, which is harmless.
async function seedUsers(): Promise<Record<string, mongoose.Types.ObjectId>> {
  const passwordHash = await bcrypt.hash(DEMO_PASSWORD, BCRYPT_COST);
  const idByHandle: Record<string, mongoose.Types.ObjectId> = {};
  for (const spec of DEMO_USERS) {
    const user = await User.findOneAndUpdate(
      { handle: spec.handle },
      { handle: spec.handle, email: spec.email, passwordHash, isAdmin: spec.isAdmin },
      { upsert: true, new: true },
    );
    idByHandle[spec.handle] = user._id;
  }
  console.log(`seeded ${DEMO_USERS.length} users (1 admin + ${DEMO_USERS.length - 1} demo), password: ${DEMO_PASSWORD}`);
  return idByHandle;
}

const PAST_CONTEST_PROBLEM_SLUGS = ['square-number', 'sum-of-n-numbers', 'max-subarray-sum'];
const COMPETITOR_HANDLES = ['alice', 'bob', 'carol', 'dave'];

// Skill profile per demo user: fast/clean solver, steady solver, a couple of wrong attempts
// before getting there, mostly stuck — gives the finalized standings a believable spread
// instead of every competitor tying. Cosmetic only (Math.random() below), not reproducible
// byte-for-byte across reseeds — that's fine, this is demo flavor, not a fixture under test.
const SKILL_PROFILES: Record<string, { solveProb: number; wrongBefore: number }> = {
  alice: { solveProb: 0.95, wrongBefore: 0 },
  bob: { solveProb: 0.85, wrongBefore: 1 },
  carol: { solveProb: 0.6, wrongBefore: 2 },
  dave: { solveProb: 0.3, wrongBefore: 1 },
};

// A finalized contest with plausible standings, including per-problem cells — lets a fresh
// clone show off the ICPC leaderboard grid without anyone having to run a live contest first.
// Reuses square-number/sum-of-n-numbers/max-subarray-sum (already public practice problems) —
// a *finalized* contest's problems are supposed to be public (that's what finalization does in
// the real flow), so no isPublished juggling is needed here, unlike the live contest below.
async function seedPastContest(userIds: Record<string, mongoose.Types.ObjectId>): Promise<void> {
  const problems = await Problem.find({ slug: { $in: PAST_CONTEST_PROBLEM_SLUGS } })
    .select('_id slug')
    .lean();
  const problemIdBySlug = new Map(problems.map((p) => [p.slug, p._id]));
  const problemIds = PAST_CONTEST_PROBLEM_SLUGS.map((slug) => problemIdBySlug.get(slug)!);

  const startAt = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000); // "3 days ago", relative to whenever seed runs
  const endAt = new Date(startAt.getTime() + 90 * 60 * 1000);
  const competitorIds = COMPETITOR_HANDLES.map((h) => userIds[h]);

  const contest = await Contest.findOneAndUpdate(
    { slug: PAST_DEMO_CONTEST_SLUG },
    {
      title: 'CodeArena Winter Open',
      slug: PAST_DEMO_CONTEST_SLUG,
      startAt,
      endAt,
      problemIds,
      registeredUserIds: competitorIds,
      isFinalized: true,
    },
    { upsert: true, new: true },
  );

  // Idempotent re-seed: wipe and regenerate this contest's synthetic submissions every run
  // rather than trying to merge — safe, this data is entirely scoped to one fixed demo slug
  // and never touches real user submissions.
  await Submission.deleteMany({ contestId: contest._id });

  interface SeedSubmissionDoc {
    userId: mongoose.Types.ObjectId;
    problemId: mongoose.Types.ObjectId;
    contestId: mongoose.Types.ObjectId;
    language: 'cpp';
    code: string;
    status: 'AC' | 'WA';
    contestScored: boolean;
    // The {userId, idempotencyKey} unique index is sparse, but sparse only excludes documents
    // missing EVERY indexed field — since userId is always present, an omitted (undefined)
    // idempotencyKey still gets indexed as null, and a second synthetic submission for the
    // same user would collide on {userId, null}. A cheap deterministic value per row sidesteps
    // this entirely (and re-seeding recomputes the same values, matching Submission.deleteMany
    // above's wipe-and-regenerate idempotency).
    idempotencyKey: string;
    createdAt: Date;
    updatedAt: Date;
  }

  const docs: SeedSubmissionDoc[] = [];
  for (const handle of COMPETITOR_HANDLES) {
    const profile = SKILL_PROFILES[handle];
    const userId = userIds[handle];
    let cursor = startAt.getTime() + 2 * 60 * 1000; // first attempt ~2min into the contest
    for (const problemId of problemIds) {
      for (let i = 0; i < profile.wrongBefore; i++) {
        docs.push({
          userId,
          problemId,
          contestId: contest._id,
          language: 'cpp',
          code: '// demo seed data — wrong attempt',
          status: 'WA',
          contestScored: false,
          idempotencyKey: `seed-${handle}-${problemId.toString()}-wa${i}`,
          createdAt: new Date(cursor),
          updatedAt: new Date(cursor),
        });
        cursor += 3 * 60 * 1000;
      }
      if (Math.random() < profile.solveProb) {
        docs.push({
          userId,
          problemId,
          contestId: contest._id,
          language: 'cpp',
          code: '// demo seed data — accepted',
          status: 'AC',
          contestScored: false,
          idempotencyKey: `seed-${handle}-${problemId.toString()}-ac`,
          createdAt: new Date(cursor),
          updatedAt: new Date(cursor),
        });
      }
      cursor += 8 * 60 * 1000; // move on to the next problem
    }
  }
  if (docs.length > 0) {
    // insertMany() would run these through the schema's {timestamps:true} middleware, which
    // stamps createdAt/updatedAt with the current wall-clock time — overwriting the
    // deliberately-crafted values (spread across the contest window) that scoreGroup's
    // solve-time math depends on. Insert first, then force-correct the timestamps via the raw
    // driver collection, bypassing Mongoose middleware entirely for that second step.
    const inserted = await Submission.insertMany(docs);
    await Submission.collection.bulkWrite(
      inserted.map((doc, i) => ({
        updateOne: {
          filter: { _id: doc._id },
          update: { $set: { createdAt: docs[i].createdAt, updatedAt: docs[i].updatedAt } },
        },
      })),
    );
  }

  await backfillFinalStandingsCells(contest._id.toString());
  console.log(
    `seeded past contest "${PAST_DEMO_CONTEST_SLUG}": ${docs.length} synthetic submissions, standings backfilled`,
  );
}

const LIVE_CONTEST_PROBLEM_SLUGS = ['is-prime', 'two-sum', 'longest-increasing-subsequence'];

// An upcoming contest ready to demo live via scripts/solutions/ + simulate-contest.ts. Its
// problems are deliberately NOT reused by the past contest above — isPublished is a property
// of the Problem document itself (not per-contest), so a problem can't simultaneously be
// "public because a past contest finalized it" and "private because a future contest hasn't
// started yet." Kept unpublished until this contest finalizes for real, exactly like any
// other contest problem — reset-demo-contest.ts re-applies this each time the demo is rerun.
async function seedLiveDemoContest(): Promise<void> {
  const problems = await Problem.find({ slug: { $in: LIVE_CONTEST_PROBLEM_SLUGS } })
    .select('_id slug')
    .lean();
  const problemIdBySlug = new Map(problems.map((p) => [p.slug, p._id]));
  const problemIds = LIVE_CONTEST_PROBLEM_SLUGS.map((slug) => problemIdBySlug.get(slug)!);

  // Safely in the future on a first seed; reset-demo-contest.ts is what shifts this to "about
  // to start" immediately before an actual demo run. $setOnInsert below means a reseed never
  // clobbers whatever reset-demo-contest.ts (or a real registration) has since done to this doc.
  const startAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const endAt = new Date(startAt.getTime() + 30 * 60 * 1000);

  const contest = await Contest.findOneAndUpdate(
    { slug: LIVE_DEMO_CONTEST_SLUG },
    {
      $set: { title: 'CodeArena Live Demo Contest', slug: LIVE_DEMO_CONTEST_SLUG, problemIds },
      $setOnInsert: { startAt, endAt, registeredUserIds: [], isFinalized: false },
    },
    { upsert: true, new: true },
  );

  if (!contest.isFinalized) {
    await Problem.updateMany({ _id: { $in: problemIds } }, { $set: { isPublished: false } });
  }
  console.log(`seeded live demo contest "${LIVE_DEMO_CONTEST_SLUG}" (isFinalized=${contest.isFinalized})`);
}

async function main(): Promise<void> {
  await mongoose.connect(process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/codearena');
  await ensureBucket();

  const slugs = readdirSync(PROBLEMS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);

  for (const slug of slugs) {
    await seedProblem(slug);
  }

  const userIds = await seedUsers();
  await seedPastContest(userIds);
  await seedLiveDemoContest();

  await mongoose.disconnect();
}

await main();
