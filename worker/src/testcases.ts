import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { HeadObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { s3, BUCKET } from './storage.js';

const CACHE_DIR = join(process.cwd(), '.cache');

function streamToBuffer(body: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  return new Promise((resolve, reject) => {
    body.on('data', (chunk: Buffer) => chunks.push(chunk));
    body.on('end', () => resolve(Buffer.concat(chunks)));
    body.on('error', reject);
  });
}

// Fetches a test file's content, caching it on worker-local disk keyed by the
// object's ETag so a problem's test files are downloaded once per worker
// (not once per submission) and refetched only when they actually change.
export async function getTestFile(slug: string, filename: string, key: string): Promise<string> {
  const cachePath = join(CACHE_DIR, slug, filename);
  const etagPath = `${cachePath}.etag`;

  const head = await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
  const remoteEtag = head.ETag;

  if (
    existsSync(cachePath) &&
    existsSync(etagPath) &&
    readFileSync(etagPath, 'utf8') === remoteEtag
  ) {
    return readFileSync(cachePath, 'utf8');
  }

  const obj = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  const buffer = await streamToBuffer(obj.Body as NodeJS.ReadableStream);

  mkdirSync(dirname(cachePath), { recursive: true });
  writeFileSync(cachePath, buffer);
  if (remoteEtag) writeFileSync(etagPath, remoteEtag);

  return buffer.toString('utf8');
}
