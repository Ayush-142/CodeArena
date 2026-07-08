import { Schema, model, InferSchemaType } from 'mongoose';

const finalStandingRowSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    handle: { type: String, required: true }, // denormalized so rendering standings needs no join
    solvedCount: { type: Number, required: true },
    penaltyMinutes: { type: Number, required: true },
    rank: { type: Number, required: true },
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
  },
  { timestamps: true },
);

// No index on registeredUserIds: the only gating query always loads the contest by
// _id/slug first, so a multikey index here would be speculative — add one only if a
// "my registered contests" listing query appears later.
contestSchema.index({ startAt: 1 }); // lobby list sort/phase-bucketing

export type ContestDoc = InferSchemaType<typeof contestSchema>;
export const Contest = model('Contest', contestSchema);
