import { Router } from 'express';
import { Problem } from '../models/Problem.js';

export const problemsRouter = Router();

problemsRouter.get('/', async (_req, res) => {
  const problems = await Problem.find({ isPublished: true })
    .select('title slug difficulty tags')
    .lean();
  res.json(problems);
});

problemsRouter.get('/:slug', async (req, res) => {
  const problem = await Problem.findOne({ slug: req.params.slug, isPublished: true })
    .select('slug title statementMd difficulty tags timeLimitMs memoryLimitMb samples')
    .lean();
  if (!problem) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  res.json(problem);
});
