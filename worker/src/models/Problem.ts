import { Schema, model, InferSchemaType } from 'mongoose';

const sampleSchema = new Schema(
  {
    input: { type: String, required: true },
    output: { type: String, required: true },
    explanation: { type: String },
  },
  { _id: false },
);

const testcaseSchema = new Schema(
  {
    key: { type: String, required: true },
    inputKey: { type: String, required: true },
    outputKey: { type: String, required: true },
  },
  { _id: false },
);

const problemSchema = new Schema(
  {
    slug: { type: String, required: true, unique: true, index: true },
    title: { type: String, required: true },
    statementMd: { type: String, required: true },
    difficulty: { type: String, required: true, enum: ['easy', 'medium', 'hard'] },
    tags: { type: [String], default: [] },
    timeLimitMs: { type: Number, required: true },
    memoryLimitMb: { type: Number, required: true },
    samples: { type: [sampleSchema], default: [] },
    // Object-storage KEYS only — test file contents never live in Mongo.
    testcases: { type: [testcaseSchema], default: [] },
    isPublished: { type: Boolean, required: true, default: false },
  },
  { timestamps: true },
);

export type ProblemDoc = InferSchemaType<typeof problemSchema>;
export const Problem = model('Problem', problemSchema);
