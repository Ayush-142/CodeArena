import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { Problem } from '../models/Problem.js';
import { s3, BUCKET, ensureBucket } from '../storage.js';

dotenv.config();

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROBLEMS_DIR = join(__dirname, '../../../problems');

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

async function main(): Promise<void> {
  await mongoose.connect(process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/codearena');
  await ensureBucket();

  const slugs = readdirSync(PROBLEMS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);

  for (const slug of slugs) {
    await seedProblem(slug);
  }

  await mongoose.disconnect();
}

await main();
