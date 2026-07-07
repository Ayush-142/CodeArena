import dotenv from 'dotenv';
import { Worker } from 'bullmq';

dotenv.config();

const connection = {
  host: '127.0.0.1',
  port: 6379,
};

const worker = new Worker(
  'submissions',
  async (job) => {
    console.log('Received job payload:', job.data);
    return { status: 'logged' };
  },
  { connection }
);

worker.on('ready', () => {
  console.log('Worker ready');
});

worker.on('failed', (job, err) => {
  console.error(`Job ${job?.name} failed`, err.message);
});

console.log('Worker started');
