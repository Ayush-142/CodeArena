import { S3Client } from '@aws-sdk/client-s3';

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
