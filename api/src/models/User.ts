import { Schema, model, InferSchemaType } from 'mongoose';

const userSchema = new Schema(
  {
    handle: {
      type: String,
      required: true,
      unique: true,
      index: true,
      minlength: 3,
      maxlength: 20,
      match: /^[a-zA-Z0-9]+$/,
    },
    email: { type: String, required: true, unique: true, index: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true },
    // Phase-3 simplification vs ARCHITECTURE.md §4 (which specifies `role: "user" | "admin"`,
    // plus `rating`/`solvedCount`): a single isAdmin boolean is enough until contests/profile
    // features (Phase 5+) need richer roles or stats. Revisit then.
    isAdmin: { type: Boolean, required: true, default: false },
  },
  { timestamps: true },
);

export type UserDoc = InferSchemaType<typeof userSchema>;
export const User = model('User', userSchema);
