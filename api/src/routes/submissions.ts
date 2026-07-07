import { Router } from 'express';
import mongoose from 'mongoose';
import { Submission } from '../models/Submission.js';
import { submissionsQueue } from '../queue.js';

export const submissionsRouter = Router();

submissionsRouter.post('/', async (req, res) => {
  const { code, language } = (req.body ?? {}) as { code?: unknown; language?: unknown };

  if (typeof code !== 'string' || code.trim().length === 0) {
    res.status(400).json({ error: 'code must be a non-empty string' });
    return;
  }
  if (language !== 'cpp') {
    res.status(400).json({ error: "language must be 'cpp'" });
    return;
  }

  const submission = await Submission.create({ code, language, status: 'queued' });
  await submissionsQueue.add('judge', { submissionId: submission._id.toString() });

  res.status(202).json({ id: submission._id.toString() });
});

submissionsRouter.get('/:id', async (req, res) => {
  const { id } = req.params;
  if (!mongoose.isValidObjectId(id)) {
    res.status(400).json({ error: 'invalid id' });
    return;
  }
  const submission = await Submission.findById(id);
  if (!submission) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  res.json(submission);
});
