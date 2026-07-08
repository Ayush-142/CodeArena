import { GoogleGenAI } from '@google/genai';
import { createHash } from 'node:crypto';
import { env } from '../config/env.js';
import { redisClient } from '../redis/client.js';
import { HINT_SYSTEM_PROMPT, buildUserPrompt } from './prompts.js';

const ai = new GoogleGenAI({ apiKey: env.geminiApiKey });

export function normalizeCode(code: string): string {
  return code
    .replace(/\/\/.*$/gm, '') // C++ line comments
    .replace(/\/\*[\s\S]*?\*\//g, '') // C++ block comments
    .replace(/#.*$/gm, '') // Python-style comments — inert today (Submission.language
    // enum is 'cpp' only) but cheap to handle now rather than silently wrong if a
    // language is ever added without revisiting this function.
    .replace(/\s+/g, ' ')
    .trim();
}

export function computeFailureSignature(
  verdict: string,
  failedTestIndex: number | undefined,
  code: string,
): string {
  return createHash('sha256')
    .update(`${verdict}:${failedTestIndex ?? ''}:${normalizeCode(code)}`)
    .digest('hex');
}

export interface GenerateHintParams {
  userId: string;
  submissionId: string;
  problemId: string;
  level: 1 | 2 | 3;
  problemStatement: string;
  code: string;
  verdict: string;
  failedTestInput: string | null;
}

export interface GenerateHintResult {
  hintText: string;
  tokensUsed: number;
}

// Streams chunks to ch:hints (relayed to the client's private room by the socket
// server — see socket/index.ts) as they arrive, while also accumulating the full
// text itself. Throws on timeout/API error (including RESOURCE_EXHAUSTED — the
// caller in routes/hints.ts inspects the error to log a distinct "global limiter
// may be set too high" signal). Never persists a partial hint; the caller degrades
// gracefully on any throw and refunds the user's daily-cap consumption.
export async function generateHint(params: GenerateHintParams): Promise<GenerateHintResult> {
  const userPrompt = buildUserPrompt(params);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);

  let fullText = '';
  let lastUsage: { totalTokenCount?: number } | undefined;
  try {
    const stream = await ai.models.generateContentStream({
      model: env.geminiModel,
      contents: userPrompt,
      config: {
        systemInstruction: HINT_SYSTEM_PROMPT,
        thinkingConfig: { thinkingBudget: 0 }, // 0 = DISABLED (confirmed via SDK source)
        maxOutputTokens: env.hintMaxTokens,
        abortSignal: controller.signal,
      },
    });

    for await (const chunk of stream) {
      const delta = chunk.text;
      if (delta) {
        fullText += delta;
        await redisClient.publish(
          'ch:hints',
          JSON.stringify({
            type: 'chunk',
            userId: params.userId,
            submissionId: params.submissionId,
            level: params.level,
            chunk: delta,
          }),
        );
      }
      if (chunk.usageMetadata) lastUsage = chunk.usageMetadata;
    }

    // totalTokenCount is documented as the sum of prompt + candidates + tool_use +
    // thoughts tokens — one field, no manual summing needed.
    const tokensUsed = lastUsage?.totalTokenCount ?? 0;
    await redisClient.publish(
      'ch:hints',
      JSON.stringify({
        type: 'done',
        userId: params.userId,
        submissionId: params.submissionId,
        level: params.level,
      }),
    );
    return { hintText: fullText, tokensUsed };
  } catch (err) {
    await redisClient.publish(
      'ch:hints',
      JSON.stringify({
        type: 'error',
        userId: params.userId,
        submissionId: params.submissionId,
        level: params.level,
      }),
    );
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
