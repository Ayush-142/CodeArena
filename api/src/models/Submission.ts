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
    // Client-supplied via Idempotency-Key header, or server-generated if missing (see
    // routes/submissions.ts). Not `unique` at the field level: uniqueness is scoped to
    // (userId, idempotencyKey) via the compound index below, not global — the same key is
    // legitimately reusable by two different users.
    idempotencyKey: { type: String },
  },
  { timestamps: true },
);

submissionSchema.index({ userId: 1, problemId: 1, createdAt: -1 });
submissionSchema.index({ status: 1, createdAt: -1 });
submissionSchema.index({ userId: 1, idempotencyKey: 1 }, { unique: true, sparse: true });

export type SubmissionDoc = InferSchemaType<typeof submissionSchema>;
export const Submission = model('Submission', submissionSchema);
