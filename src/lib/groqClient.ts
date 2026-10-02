/**
 * Groq JSON client — OpenAI-compatible chat completions.
 * One request per provided API key (no key rotation / fallback).
 */
import { z } from "zod";
import "../config.js"; // ensure .env is loaded before reading process.env

const PLACEHOLDERS = new Set(["", "YOUR_API_KEY_HERE", "your_api_key_here"]);
const DEFAULT_MODEL = "openai/gpt-oss-120b";
const DEFAULT_MAX_TOKENS = 8192;
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";

export type GroqKey = { name: string; value: string };

export class GroqUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GroqUnavailableError";
  }
}

function stripJsonFence(text: string): string {
  const trimmed = text.trim();
  const fence = trimmed.match(/^```(?:json)?\s*([\s\S]*?)```$/i);
  return fence ? fence[1].trim() : trimmed;
}

function loadModel(): string {
  const model = process.env.GROQ_MODEL?.trim();
  return model || DEFAULT_MODEL;
}

/** Load GROQ_API_KEY / GROQ_API_KEY_1..N (and optional GROQ_API_KEYS csv). */
export function loadGroqKeys(): GroqKey[] {
  const keys: GroqKey[] = [];
  const seen = new Set<string>();

  const push = (name: string, raw: string | undefined) => {
    const value = raw?.trim();
    if (!value || PLACEHOLDERS.has(value) || seen.has(value)) return;
    seen.add(value);
    keys.push({ name, value });
  };

  push("GROQ_API_KEY", process.env.GROQ_API_KEY);
  for (let i = 1; i <= 12; i++) {
    push(`GROQ_API_KEY_${i}`, process.env[`GROQ_API_KEY_${i}`]);
  }

  const csv = process.env.GROQ_API_KEYS?.trim();
  if (csv) {
    csv.split(/[,;\s]+/).forEach((value, idx) => {
      push(`GROQ_API_KEYS_${idx + 1}`, value);
    });
  }

  return keys;
}

export function groqIsConfigured(): boolean {
  return loadGroqKeys().length > 0;
}

export type GenerateJsonGroqOpts = {
  /** Required: bind this call to one specific key (parallel fan-out). */
  apiKey: GroqKey;
  maxTokens?: number;
  requestTimeoutMs?: number;
  responseSchema?: z.ZodType;
  model?: string;
};

type GroqChatResponse = {
  choices?: Array<{
    finish_reason?: string | null;
    message?: { content?: string | null };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  error?: { message?: string; type?: string; code?: string };
};

export async function generateJsonGroq(
  prompt: string,
  systemPrompt: string,
  opts: GenerateJsonGroqOpts,
): Promise<{ data: Record<string, unknown>; keyUsed: string; modelUsed: string }> {
  const key = opts.apiKey;
  if (!key?.value) {
    throw new GroqUnavailableError("Groq API key missing");
  }

  const model = opts.model?.trim() || loadModel();
  const maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS;
  const requestTimeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
  const started = Date.now();

  console.log(
    `[groq] → request model=${model} key=${key.name} ` +
      `promptChars=${prompt.length} systemChars=${systemPrompt.length} ` +
      `maxTokens=${maxTokens} timeoutMs=${requestTimeoutMs}`,
  );

  try {
    const res = await fetch(GROQ_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key.value}`,
        "Content-Type": "application/json",
      },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        temperature: 0,
        max_tokens: maxTokens,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: prompt },
        ],
      }),
    });

    const elapsed = Date.now() - started;
    const rawBody = await res.text();

    if (!res.ok) {
      let detail = rawBody.slice(0, 400);
      try {
        const errJson = JSON.parse(rawBody) as GroqChatResponse;
        detail = errJson.error?.message ?? detail;
      } catch {
        /* keep raw */
      }
      if (res.status === 429) {
        throw new GroqUnavailableError(
          `Groq rate limited on ${key.name}: ${detail}`,
        );
      }
      throw new GroqUnavailableError(
        `Groq HTTP ${res.status} on ${key.name}: ${detail}`,
      );
    }

    let parsedRes: GroqChatResponse;
    try {
      parsedRes = JSON.parse(rawBody) as GroqChatResponse;
    } catch {
      throw new GroqUnavailableError(
        `Groq returned non-JSON envelope on ${key.name}`,
      );
    }

    const choice = parsedRes.choices?.[0];
    const finish = choice?.finish_reason ?? null;
    const text = choice?.message?.content ?? "";

    console.log(
      `[groq] ← response model=${model} key=${key.name} elapsedMs=${elapsed} ` +
        `chars=${text.length} finish=${finish ?? "?"} ` +
        `tokens=${parsedRes.usage?.total_tokens ?? "?"}`,
    );

    if (finish === "length") {
      throw new GroqUnavailableError(
        `Groq response truncated (finish_reason=length) on ${key.name}`,
      );
    }
    if (!text.trim()) {
      throw new GroqUnavailableError(`Empty Groq response on ${key.name}`);
    }

    let data: Record<string, unknown>;
    try {
      data = JSON.parse(stripJsonFence(text)) as Record<string, unknown>;
    } catch (err) {
      throw new GroqUnavailableError(
        `Invalid JSON from Groq on ${key.name}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    if (opts.responseSchema) {
      data = opts.responseSchema.parse(data) as Record<string, unknown>;
    }

    return { data, keyUsed: key.name, modelUsed: model };
  } catch (err) {
    if (err instanceof GroqUnavailableError) throw err;
    if (controller.signal.aborted) {
      throw new GroqUnavailableError(
        `Groq request timed out after ${requestTimeoutMs}ms on ${key.name}`,
      );
    }
    throw new GroqUnavailableError(
      err instanceof Error ? err.message : String(err),
    );
  } finally {
    clearTimeout(timer);
  }
}
