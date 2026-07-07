import { Schema, model, InferSchemaType } from 'mongoose';

export const VERDICTS = ['queued', 'running', 'AC', 'WA', 'TLE', 'CE'] as const;
export type Verdict = (typeof VERDICTS)[number];

const submissionSchema = new Schema(
  {
    code: { type: String, required: true },
    language: { type: String, required: true, enum: ['cpp'] },
    status: { type: String, required: true, enum: VERDICTS, default: 'queued' },
    output: { type: String },
    compileError: { type: String },
  },
  { timestamps: true },
);

export type SubmissionDoc = InferSchemaType<typeof submissionSchema>;
export const Submission = model('Submission', submissionSchema);
