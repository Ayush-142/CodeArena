import { Schema, model, InferSchemaType } from 'mongoose';

// Trimmed copy of api/src/models/Contest.ts — the worker's scoring module only ever
// reads startAt/endAt/isFinalized (see scoring.ts), so it doesn't need problemIds,
// registeredUserIds, or finalStandings mirrored here.
const contestSchema = new Schema(
  {
    startAt: { type: Date, required: true },
    endAt: { type: Date, required: true },
    isFinalized: { type: Boolean, required: true, default: false },
  },
  { timestamps: true },
);

export type ContestDoc = InferSchemaType<typeof contestSchema>;
export const Contest = model('Contest', contestSchema);
