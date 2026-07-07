import { Schema, model, InferSchemaType } from 'mongoose';

export const VERDICTS = ['queued', 'running', 'AC', 'WA', 'TLE', 'MLE', 'RE', 'CE'] as const;
export type Verdict = (typeof VERDICTS)[number];

const submissionSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    problemId: { type: Schema.Types.ObjectId, ref: 'Problem', required: true, index: true },
    code: { type: String, required: true },
    language: { type: String, required: true, enum: ['cpp'] },
    status: { type: String, required: true, enum: VERDICTS, default: 'queued' },
    failedTestIndex: { type: Number },
    execTimeMs: { type: Number },
    output: { type: String },
    compileError: { type: String },
  },
  { timestamps: true },
);

export type SubmissionDoc = InferSchemaType<typeof submissionSchema>;
export const Submission = model('Submission', submissionSchema);
