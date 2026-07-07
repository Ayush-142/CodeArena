import express from 'express';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { createClient } from 'redis';
import { submissionsRouter } from './routes/submissions.js';
import { problemsRouter } from './routes/problems.js';

dotenv.config();

await mongoose.connect(process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/codearena');

const app = express();
app.use(express.json());

app.use('/api/problems', problemsRouter);
app.use('/api/submissions', submissionsRouter);

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'api' });
});

app.get('/ready', async (_req, res) => {
  const state = { mongo: false, redis: false };

  try {
    await mongoose.connect(process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/codearena');
    state.mongo = true;
  } catch {
    state.mongo = false;
  }

  try {
    const client = createClient({ url: process.env.REDIS_URL || 'redis://127.0.0.1:6379' });
    await client.connect();
    await client.quit();
    state.redis = true;
  } catch {
    state.redis = false;
  }

  res.json(state);
});

const port = Number(process.env.PORT || 3001);
app.listen(port, () => {
  console.log(`API listening on ${port}`);
});
