/**
 * Gemini JSON client (@google/genai) — fail-fast with abort, schema, key/model fallback.
 */
import { GoogleGenAI, ThinkingLevel } from "@google/genai";
import { z } from "zod";
import { config } from "../config.js";

const PLACEHOLDERS = new Set(["", "YOUR_API_KEY_HERE", "your_api_key_here"]);
/** Soft spacing between successful calls (ms). */
const MIN_CALL_INTERVAL_MS = 150;
/** Per-attempt timeout — abort the underlying request. */
const REQUEST_TIMEOUT_MS = 9_000;
const DEBUG_LOG_PAYLOADS = process.env.GEMINI_DEBUG_LOG_PAYLOADS === "true";

const exhausted = new Set<string>();
let rrIndex = 0;
let lastCallAt = 0;

export class GeminiUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GeminiUnavailableError";
  }
}

export class GeminiQuotaExhaustedError extends GeminiUnavailableError {
  constructor(message = "All Gemini API keys exhausted") {
    super(message);
    this.name = "GeminiQuotaExhaustedError";
  }
}

function loadKeys(): Array<{ name: string; value: string }> {
  const keys: Array<{ name: string; value: string }> = [];
  const single = process.env.GEMINI_API_KEY?.trim();
  if (single && !PLACEHOLDERS.has(single)) {
    keys.push({ name: "GEMINI_API_KEY", value: single });
  }
  for (let i = 2; i <= 12; i++) {
    const name = `GEMINI_API_KEY_${i}`;
    const value = process.env[name]?.trim();
    if (value && !PLACEHOLDERS.has(value)) {
      keys.push({ name, value });
    }
  }
  const csv = process.env.GEMINI_API_KEYS?.trim();
  if (csv) {
    csv.split(/[,;\s]+/).forEach((value, idx) => {
      const v = value.trim();
      if (v && !PLACEHOLDERS.has(v)) {
        keys.push({ name: `GEMINI_API_KEYS_${idx + 1}`, value: v });
      }
    });
  }
  return keys;
}

export function geminiIsConfigured(): boolean {
  return loadKeys().some((k) => !exhausted.has(k.name));
}

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

function stripJsonFence(text: string): string {
  const trimmed = text.trim();
  const fence = trimmed.match(/^```(?:json)?\s*([\s\S]*?)```$/i);
  return fence ? fence[1].trim() : trimmed;
}

function isQuotaError(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes("quota") ||
    lower.includes("429") ||
    lower.includes("resource_exhausted") ||
    lower.includes("rate limit")
  );
}

function isMissingModelError(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes("not found") ||
    lower.includes("unsupported") ||
    lower.includes("404") ||
    lower.includes("is not found for api version") ||
    lower.includes("no longer available")
  );
}

function isAbortError(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes("abort") ||
    lower.includes("timeout") ||
    lower.includes("timed out") ||
    lower.includes("cancelled") ||
    lower.includes("canceled")
  );
}

function thinkingConfigFor(modelName: string) {
  const isV3 = /gemini-3/.test(modelName);
  return isV3
    ? { thinkingLevel: ThinkingLevel.LOW }
    : { thinkingBudget: 0 };
}

function zodToResponseJsonSchema(schema: z.ZodType): unknown {
  const raw = z.toJSONSchema(schema) as Record<string, unknown>;
  // Gemini rejects some meta fields; keep a lean JSON Schema object.
  const { $schema: _s, ...rest } = raw;
  return rest;
}

export type GenerateJsonOpts = {
  maxTokens?: number;
  deadlineMs?: number;
  /** Zod schema → responseJsonSchema for constrained JSON output. */
  responseSchema?: z.ZodType;
};

export async function generateJson(
  prompt: string,
  systemPrompt: string,
  opts?: GenerateJsonOpts,
): Promise<{ data: Record<string, unknown>; keyUsed: string; modelUsed: string }> {
  const keys = loadKeys().filter((k) => !exhausted.has(k.name));
  if (!keys.length) {
    throw new GeminiQuotaExhaustedError();
  }

  const deadline = opts?.deadlineMs ?? Date.now() + config.parseTimeoutMs;
  const maxTokens = opts?.maxTokens ?? 2048;
  const responseJsonSchema = opts?.responseSchema
    ? zodToResponseJsonSchema(opts.responseSchema)
    : undefined;
  let lastError: Error | null = null;

  console.log(
    `[gemini] start models=${config.geminiModels.join(",")} keys=${keys.length} ` +
      `promptChars=${prompt.length} systemChars=${systemPrompt.length} maxTokens=${maxTokens} ` +
      `schema=${Boolean(responseJsonSchema)}`,
  );

  for (const modelName of config.geminiModels) {
    if (Date.now() >= deadline) break;

    for (let offset = 0; offset < keys.length; offset++) {
      if (Date.now() >= deadline) break;

      const key = keys[(rrIndex + offset) % keys.length]!;
      if (exhausted.has(key.name)) continue;

      const gap = MIN_CALL_INTERVAL_MS - (Date.now() - lastCallAt);
      if (gap > 0) await sleep(gap);

      const remaining = deadline - Date.now();
      if (remaining < 1500) {
        throw new GeminiUnavailableError("Gemini deadline exceeded");
      }
      const attemptTimeout = Math.min(REQUEST_TIMEOUT_MS, remaining - 200);

      const controller = new AbortController();
      const timer = setTimeout(() => {
        console.warn(
          `[gemini] aborting in-flight request model=${modelName} key=${key.name} after ${attemptTimeout}ms`,
        );
        controller.abort();
      }, attemptTimeout);

      try {
        lastCallAt = Date.now();
        console.log(
          `[gemini] → request model=${modelName} key=${key.name} timeoutMs=${attemptTimeout}`,
        );

        const ai = new GoogleGenAI({ apiKey: key.value });
        const response = await ai.models.generateContent({
          model: modelName,
          contents: prompt,
          config: {
            abortSignal: controller.signal,
            systemInstruction: systemPrompt,
            temperature: 0,
            maxOutputTokens: maxTokens,
            responseMimeType: "application/json",
            ...(responseJsonSchema ? { responseJsonSchema } : {}),
            thinkingConfig: thinkingConfigFor(modelName),
          },
        });

        clearTimeout(timer);

        const text = response.text ?? "";
        const elapsed = Date.now() - lastCallAt;
        console.log(
          `[gemini] ← raw response model=${modelName} key=${key.name} ` +
            `elapsedMs=${elapsed} chars=${text.length} aborted=${controller.signal.aborted}`,
        );
        if (DEBUG_LOG_PAYLOADS) {
          console.log("[gemini] ← raw body:\n" + text);
        }

        if (!text.trim()) {
          throw new Error("Empty Gemini response");
        }

        const parsed = JSON.parse(stripJsonFence(text)) as Record<
          string,
          unknown
        >;
        if (DEBUG_LOG_PAYLOADS) {
          console.log(
            "[gemini] ← parsed JSON:\n" + JSON.stringify(parsed, null, 2),
          );
        }
        rrIndex = (rrIndex + offset + 1) % keys.length;
        return { data: parsed, keyUsed: key.name, modelUsed: modelName };
      } catch (err) {
        clearTimeout(timer);
        const message = err instanceof Error ? err.message : String(err);
        lastError = err instanceof Error ? err : new Error(message);
        const aborted = controller.signal.aborted;
        console.error(
          `[gemini] ✕ fail model=${modelName} key=${key.name} aborted=${aborted}: ${message}`,
        );

        if (isQuotaError(message)) {
          exhausted.add(key.name);
          continue;
        }
        if (isMissingModelError(message)) {
          break;
        }
        if (aborted || isAbortError(message)) {
          // Move on quickly after a real abort
          continue;
        }
      }
    }
  }

  const live = loadKeys().filter((k) => !exhausted.has(k.name));
  if (!live.length) {
    throw new GeminiQuotaExhaustedError(lastError?.message);
  }
  if (Date.now() >= deadline) {
    throw new GeminiUnavailableError(
      lastError?.message
        ? `Gemini deadline exceeded (${lastError.message})`
        : "Gemini deadline exceeded",
    );
  }
  throw new GeminiUnavailableError(lastError?.message ?? "Gemini unavailable");
}
