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

function isUnavailableError(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes("unavailable") ||
    lower.includes('"code":503') ||
    lower.includes("high demand") ||
    lower.includes("temporarily")
  );
}

function thinkingConfigFor(modelName: string, _disableThinking = false) {
  // gemini-3.x rejects MINIMAL; LOW is the lightest supported level.
  if (/gemini-3/.test(modelName)) {
    return { thinkingLevel: ThinkingLevel.LOW };
  }
  return { thinkingBudget: 0 };
}

function zodToResponseJsonSchema(schema: z.ZodType): unknown {
  const raw = z.toJSONSchema(schema) as Record<string, unknown>;
  // Gemini rejects some meta fields; keep a lean JSON Schema object.
  const { $schema: _s, ...rest } = raw;
  return rest;
}

export type GenerateJsonOpts = {
  maxTokens?: number;
  /** Absolute epoch ms when this call must stop. */
  deadlineMs?: number;
  /** Per-attempt abort timeout (ms). Defaults to 9s — raise for large extract jobs. */
  requestTimeoutMs?: number;
  /**
   * Max live attempts across keys/models for this call.
   * Default: try all keys × models (parse soft-fail path).
   */
  maxAttempts?: number;
  /**
   * On client abort/timeout, stop immediately instead of rotating keys.
   * Default true when requestTimeoutMs is explicitly set; false for short parse calls.
   */
  failFastOnAbort?: boolean;
  /** Skip / minimize model thinking (faster large JSON extracts). */
  disableThinking?: boolean;
  /**
   * Override model list for this call. Default: config.geminiModels.
   * Parse/form autofill should omit this. Assess may pass the primary model only.
   */
  models?: string[];
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

  const perRequestTimeoutMs = opts?.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  const failFastOnAbort =
    opts?.failFastOnAbort ?? opts?.requestTimeoutMs != null;
  const modelNames =
    opts?.models?.filter(Boolean) ?? config.geminiModels;
  if (!modelNames.length) {
    throw new GeminiUnavailableError("No Gemini models configured");
  }
  const maxAttempts =
    opts?.maxAttempts ??
    Math.max(keys.length * Math.max(modelNames.length, 1), 1);
  const disableThinking = opts?.disableThinking ?? false;

  // Prefer an explicit request window over a short shared parse deadline.
  const deadline =
    opts?.deadlineMs ??
    Date.now() + Math.max(config.parseTimeoutMs, perRequestTimeoutMs + 2_000);

  const maxTokens = opts?.maxTokens ?? 2048;
  const responseJsonSchema = opts?.responseSchema
    ? zodToResponseJsonSchema(opts.responseSchema)
    : undefined;
  let lastError: Error | null = null;
  let attempts = 0;

  console.log(
    `[gemini] start models=${modelNames.join(",")} keys=${keys.length} ` +
      `promptChars=${prompt.length} systemChars=${systemPrompt.length} maxTokens=${maxTokens} ` +
      `schema=${Boolean(responseJsonSchema)} requestTimeoutMs=${perRequestTimeoutMs} ` +
      `maxAttempts=${maxAttempts} failFastOnAbort=${failFastOnAbort}`,
  );

  for (const modelName of modelNames) {
    if (Date.now() >= deadline) break;
    if (attempts >= maxAttempts) break;

    for (let offset = 0; offset < keys.length; offset++) {
      if (Date.now() >= deadline) break;
      if (attempts >= maxAttempts) break;

      const key = keys[(rrIndex + offset) % keys.length]!;
      if (exhausted.has(key.name)) continue;

      const gap = MIN_CALL_INTERVAL_MS - (Date.now() - lastCallAt);
      if (gap > 0) await sleep(gap);

      const remaining = deadline - Date.now();
      if (remaining < 1500) {
        throw new GeminiUnavailableError(
          lastError?.message
            ? `Gemini deadline exceeded (${lastError.message})`
            : "Gemini deadline exceeded",
        );
      }
      // Do not starve a long extract: honour requestTimeoutMs when remaining allows.
      const attemptTimeout = Math.min(perRequestTimeoutMs, remaining - 200);
      attempts += 1;

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
          `[gemini] → request model=${modelName} key=${key.name} timeoutMs=${attemptTimeout} attempt=${attempts}/${maxAttempts}`,
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
            thinkingConfig: thinkingConfigFor(modelName, disableThinking),
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
        if (isUnavailableError(message)) {
          // Overloaded model — try next key/model, but respect maxAttempts.
          continue;
        }
        if (isMissingModelError(message)) {
          break;
        }
        if (aborted || isAbortError(message)) {
          // Do NOT rotate through every key on abort — that invents "deadline exceeded".
          if (failFastOnAbort || attempts >= maxAttempts) {
            throw new GeminiUnavailableError(
              `Gemini request timed out after ${attemptTimeout}ms (${message})`,
            );
          }
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
