import { Schema, model, InferSchemaType } from 'mongoose';

const finalStandingCellSchema = new Schema(
  {
    problemId: { type: Schema.Types.ObjectId, ref: 'Problem', required: true },
    solved: { type: Boolean, required: true },
    solvedAtMinutes: { type: Number }, // present only when solved
    wrongAttempts: { type: Number, required: true, default: 0 },
  },
  { _id: false },
);

const finalStandingRowSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    handle: { type: String, required: true }, // denormalized so rendering standings needs no join
    solvedCount: { type: Number, required: true },
    penaltyMinutes: { type: Number, required: true },
    rank: { type: Number, required: true },
    // Absent (not just empty) on rows finalized before this field existed — see
    // backfillFinalStandingsCells in contests/rebuild.ts for the on-read migration.
    cells: { type: [finalStandingCellSchema], default: [] },
  },
  { _id: false },
);

// Phase 6 (Nakalchi integration): written by worker/src/integrity.ts (pending, right
// after Nakalchi's 202) and api/src/routes/internalWebhooks.ts (completed/failed, on
// the signed callback). Duplicated verbatim on worker/src/models/Contest.ts per this
// repo's established api/worker model-duplication convention.
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

const contestSchema = new Schema(
  {
    title: { type: String, required: true },
    slug: { type: String, required: true, unique: true, index: true },
    startAt: { type: Date, required: true },
    endAt: { type: Date, required: true },
    problemIds: [{ type: Schema.Types.ObjectId, ref: 'Problem', required: true }],
    // Acceptable embed at student scale (see ARCHITECTURE.md §4); move to a
    // dedicated registrations collection beyond ~10k users per contest.
    registeredUserIds: [{ type: Schema.Types.ObjectId, ref: 'User' }],
    isFinalized: { type: Boolean, required: true, default: false },
    finalStandings: { type: [finalStandingRowSchema], default: [] },
    integrityAnalysis: { type: integrityAnalysisSchema, required: false },
  },
  { timestamps: true },
);

// No index on registeredUserIds: the only gating query always loads the contest by
// _id/slug first, so a multikey index here would be speculative — add one only if a
// "my registered contests" listing query appears later.
contestSchema.index({ startAt: 1 }); // lobby list sort/phase-bucketing
// Phase 6: internalWebhooks.ts looks up a contest by the analysisId Nakalchi's webhook
// payload carries - sparse since most contests never have this field set.
contestSchema.index({ 'integrityAnalysis.analysisId': 1 }, { sparse: true });

export type ContestDoc = InferSchemaType<typeof contestSchema>;
export const Contest = model('Contest', contestSchema);
