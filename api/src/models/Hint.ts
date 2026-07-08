import { Schema, model, InferSchemaType } from 'mongoose';

const hintSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    problemId: { type: Schema.Types.ObjectId, ref: 'Problem', required: true },
    submissionId: { type: Schema.Types.ObjectId, ref: 'Submission', required: true },
    level: { type: Number, required: true, enum: [1, 2, 3] },
    promptContextHash: { type: String, required: true },
    hintText: { type: String, required: true },
    // 0 on a cache-hit-served record — no LLM tokens were spent producing THIS
    // record, only whichever request first populated the cache entry.
    tokensUsed: { type: Number, required: true },
  },
  { timestamps: true },
);

// Serves the idempotent-lookup and unlock-predecessor checks (routes/hints.ts),
// and doubles as the uniqueness guard against a duplicate-generation race (two
// concurrent first-time requests for the same level): the loser's create() call
// throws E11000, handled the same way routes/submissions.ts handles its own
// idempotency-key race.
hintSchema.index({ userId: 1, problemId: 1, level: 1 }, { unique: true });

export type HintDoc = InferSchemaType<typeof hintSchema>;
export const Hint = model('Hint', hintSchema);
