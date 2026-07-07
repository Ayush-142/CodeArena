import 'dotenv/config'; // MUST be first: loads .env before any other module reads process.env
import express from 'express';
import mongoose from 'mongoose';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import helmet from 'helmet';
import { env } from './config/env.js';
import { redisClient } from './redis/client.js';
import { attachUser } from './middleware/auth.js';
import { AppError, errorHandler } from './middleware/errors.js';
import { authRouter } from './routes/auth.js';
import { submissionsRouter } from './routes/submissions.js';
import { problemsRouter } from './routes/problems.js';

await mongoose.connect(process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/codearena');

const app = express();
app.use(helmet());
app.use(cors({ origin: env.corsOrigins, credentials: true }));
app.use(express.json());
app.use(cookieParser());
app.use(attachUser); // after cookie-parser (needs req.cookies), before all routers

app.use('/api/auth', authRouter);
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
    await redisClient.ping();
    state.redis = true;
  } catch {
    state.redis = false;
  }

  res.json(state);
});

app.use((req, _res, next) => {
  next(new AppError(404, 'NOT_FOUND', `route not found: ${req.method} ${req.path}`));
});

app.use(errorHandler); // must be last — Express identifies error middleware by 4-arg signature

const port = Number(process.env.PORT || 3001);
app.listen(port, () => {
  console.log(`API listening on ${port}`);
});
