import { Schema, model, InferSchemaType } from 'mongoose';

const userSchema = new Schema(
  {
    // Display case is preserved here — this is what's rendered everywhere (leaderboards,
    // submission history, etc). Uniqueness is NOT enforced on this field directly; it's
    // enforced on the derived `handleLower` below, so "Ayush" and "ayush" collide.
    handle: {
      type: String,
      required: true,
      index: true,
      minlength: 3,
      maxlength: 20,
      match: /^[a-zA-Z0-9]+$/,
    },
    // Derived from `handle` by the pre-validate hook below on every save — never set directly
    // by callers (route, seed script, migration all just set `handle`). This is the actual
    // uniqueness key, so case-variant duplicates ("Ayush" vs "ayush") are impossible by
    // construction rather than by convention.
    handleLower: { type: String, required: true, unique: true },
    // Lowercased at the route before this is ever assigned (auth.ts) — email uniqueness is
    // case-insensitive by storing the canonical form directly, since (unlike handle) email's
    // display case doesn't matter anywhere in the product.
    email: { type: String, required: true, unique: true, index: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true },
    // Phase-3 simplification vs ARCHITECTURE.md §4 (which specifies `role: "user" | "admin"`,
    // plus `rating`/`solvedCount`): a single isAdmin boolean is enough until contests/profile
    // features (Phase 5+) need richer roles or stats. Revisit then.
    isAdmin: { type: Boolean, required: true, default: false },
  },
  { timestamps: true },
);

userSchema.pre('validate', function setHandleLower(next) {
  if (typeof this.handle === 'string') {
    this.handleLower = this.handle.toLowerCase();
  }
  next();
});

export type UserDoc = InferSchemaType<typeof userSchema>;
export const User = model('User', userSchema);
