import { Schema, model, InferSchemaType } from 'mongoose';

// Phase 6: mirrors api/src/models/Contest.ts's integrityAnalysisSchema exactly -
// read and written by integrity.ts's duplicate-analysis guard and webhook-race fix.
const integrityAnalysisSchema = new Schema(
  {
    analysisId: { type: String, required: true },
    status: { type: String, enum: ['pending', 'completed', 'failed'], required: true },
    flaggedPairs: { type: Number },
    topSimilarity: { type: Number },
    error: { type: String },
    updatedAt: { type: Date },
  },
  { _id: false },
);

// Trimmed copy of api/src/models/Contest.ts — the worker's scoring module only ever
// reads startAt/endAt/isFinalized (see scoring.ts). Phase 6's integrity.ts additionally
// needs problemIds (to build the POST /analyses body) and integrityAnalysis (guard +
// pending-state marker); registeredUserIds/finalStandings still aren't needed here.
const contestSchema = new Schema(
  {
    startAt: { type: Date, required: true },
    endAt: { type: Date, required: true },
    isFinalized: { type: Boolean, required: true, default: false },
    problemIds: [{ type: Schema.Types.ObjectId, ref: 'Problem' }],
    integrityAnalysis: { type: integrityAnalysisSchema, required: false },
  },
  { timestamps: true },
);

export type ContestDoc = InferSchemaType<typeof contestSchema>;
export const Contest = model('Contest', contestSchema);
