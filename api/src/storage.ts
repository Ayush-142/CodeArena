import { S3Client, HeadBucketCommand, CreateBucketCommand } from '@aws-sdk/client-s3';

export const BUCKET = process.env.MINIO_BUCKET || 'codearena';

export const s3 = new S3Client({
  endpoint: process.env.MINIO_ENDPOINT || 'http://127.0.0.1:9000',
  region: 'us-east-1',
  forcePathStyle: true,
  credentials: {
    accessKeyId: process.env.MINIO_ACCESS_KEY || 'minioadmin',
    secretAccessKey: process.env.MINIO_SECRET_KEY || 'minioadmin',
  },
});

export async function ensureBucket(): Promise<void> {
  try {
    await s3.send(new HeadBucketCommand({ Bucket: BUCKET }));
  } catch {
    await s3.send(new CreateBucketCommand({ Bucket: BUCKET }));
  }
}
