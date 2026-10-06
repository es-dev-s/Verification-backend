/**
 * Groq-backed form autofill parse: split text across GROQ_API_KEY_1..N
 * (same model/client as subject extract) and merge JSON parts into one schema.
 * Does not modify assessment / subject extraction.
 */
import { z } from "zod";
import {
  generateJsonGroq,
  groqIsConfigured,
  loadGroqKeys,
  type GroqKey,
} from "../lib/groqClient.js";
import { assessConfig } from "../assess/config.js";
import {
  cvEducationExtractSchema,
  educationMultiExtractSchema,
  educationSourceExtractSchema,
  experienceExtractSchema,
  type EducationExtract,
} from "./schemas.js";

/**
 * Split text into `parts` roughly equal slices for parallel Groq keys.
 * Prefers page markers, then newlines, falling back to hard char cuts.
 * (Same strategy as subject extract — kept local so assess code stays untouched.)
 */
export function splitForParallelKeys(text: string, parts: number): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (parts <= 1) return [trimmed];

  const pages = trimmed
    .split(/\n---\s*page\s+\d+\s*---\n/i)
    .map((p) => p.trim())
    .filter(Boolean);

  if (pages.length >= parts) {
    const bags: string[] = Array.from({ length: parts }, () => "");
    pages.forEach((page, i) => {
      const slot = Math.min(parts - 1, Math.floor((i * parts) / pages.length));
      bags[slot] = bags[slot] ? `${bags[slot]}\n\n${page}` : page;
    });
    return bags.filter((b) => b.trim());
  }

  const target = Math.ceil(trimmed.length / parts);
  const slices: string[] = [];
  let start = 0;
  for (let p = 0; p < parts - 1; p++) {
    let cut = Math.min(trimmed.length, start + target);
    if (cut < trimmed.length) {
      const window = trimmed.slice(cut, Math.min(trimmed.length, cut + 800));
      const nl = window.search(/\n\s*\n|\n/);
      if (nl >= 0) cut += nl + 1;
    }
    const piece = trimmed.slice(start, cut).trim();
    if (piece) slices.push(piece);
    start = cut;
  }
  const rest = trimmed.slice(start).trim();
  if (rest) slices.push(rest);
  return slices.length ? slices : [trimmed];
}

function preferString(
  a: string | null | undefined,
  b: string | null | undefined,
): string | null {
  const left = a?.trim() ? a : null;
  const right = b?.trim() ? b : null;
  if (left && right) return left.length >= right.length ? left : right;
  return left ?? right;
}

function preferNum(
  a: number | null | undefined,
  b: number | null | undefined,
): number | null {
  if (a != null && b != null) return a >= b ? a : b;
  return a ?? b ?? null;
}

function mergeEducationExtract(
  a: EducationExtract,
  b: EducationExtract,
): EducationExtract {
  const confA = a.confidence ?? {};
  const confB = b.confidence ?? {};
  return {
    degreeTitle: preferString(a.degreeTitle, b.degreeTitle),
    institution: preferString(a.institution, b.institution),
    country: preferString(a.country, b.country),
    start: preferString(a.start, b.start),
    end: preferString(a.end, b.end),
    statedDuration: preferString(a.statedDuration, b.statedDuration),
    multipleBachelors: Boolean(a.multipleBachelors || b.multipleBachelors),
    confidence: {
      degreeTitle: preferNum(confA.degreeTitle, confB.degreeTitle),
      institution: preferNum(confA.institution, confB.institution),
      country: preferNum(confA.country, confB.country),
      start: preferNum(confA.start, confB.start),
      end: preferNum(confA.end, confB.end),
      statedDuration: preferNum(confA.statedDuration, confB.statedDuration),
    },
  };
}

export function mergeEducationMultiParts(
  parts: Array<Record<string, unknown>>,
): Record<string, unknown> {
  const byId = new Map<
    string,
    z.infer<typeof educationSourceExtractSchema>
  >();
  for (const part of parts) {
    const parsed = educationMultiExtractSchema.safeParse(part);
    if (!parsed.success) continue;
    for (const src of parsed.data.sources) {
      const existing = byId.get(src.documentId);
      if (!existing) {
        byId.set(src.documentId, src);
        continue;
      }
      const merged = mergeEducationExtract(existing, src);
      byId.set(src.documentId, {
        ...existing,
        ...merged,
        documentId: existing.documentId,
        documentType: existing.documentType,
        degreeLevel: existing.degreeLevel ?? src.degreeLevel ?? null,
      });
    }
  }
  return { sources: [...byId.values()] };
}

export function mergeCvEducationParts(
  parts: Array<Record<string, unknown>>,
): Record<string, unknown> {
  const byLevel = new Map<string, z.infer<typeof cvEducationExtractSchema>["entries"][number]>();
  const extras: z.infer<typeof cvEducationExtractSchema>["entries"] = [];

  for (const part of parts) {
    const parsed = cvEducationExtractSchema.safeParse(part);
    if (!parsed.success) continue;
    for (const entry of parsed.data.entries) {
      const key = entry.degreeLevel;
      const existing = byLevel.get(key);
      if (!existing) {
        byLevel.set(key, entry);
        continue;
      }
      // Same level twice — keep richer, park the other as extra if both have titles.
      const merged = {
        ...mergeEducationExtract(existing, entry),
        degreeLevel: existing.degreeLevel,
      };
      byLevel.set(key, merged);
      if (
        existing.degreeTitle?.trim() &&
        entry.degreeTitle?.trim() &&
        existing.degreeTitle.trim().toLowerCase() !==
          entry.degreeTitle.trim().toLowerCase()
      ) {
        extras.push(entry);
      }
    }
  }
  return { entries: [...byLevel.values(), ...extras] };
}

export function mergeExperienceParts(
  parts: Array<Record<string, unknown>>,
): Record<string, unknown> {
  const rows: z.infer<typeof experienceExtractSchema>["rows"] = [];
  const seen = new Set<string>();
  for (const part of parts) {
    const parsed = experienceExtractSchema.safeParse(part);
    if (!parsed.success) continue;
    for (const row of parsed.data.rows) {
      const key = [
        (row.employer ?? "").toLowerCase().replace(/\s+/g, " ").trim(),
        (row.title ?? "").toLowerCase().replace(/\s+/g, " ").trim(),
      ].join("|");
      if (!key.replace("|", "").trim()) continue;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push(row);
    }
  }
  return { rows };
}

export type GroqFormParseResult = {
  data: Record<string, unknown>;
  keyUsed: string;
  modelUsed: string;
  parts: number;
};

async function runChunk(
  chunk: string,
  partIndex: number,
  partCount: number,
  header: string,
  systemPrompt: string,
  apiKey: GroqKey,
  responseSchema: z.ZodType,
  maxTokens: number,
): Promise<Record<string, unknown> | null> {
  const prompt =
    `${header}\n\n` +
    `This is part ${partIndex + 1}/${partCount} of the document text. ` +
    `Extract whatever applies from this part only. Return the full JSON schema; ` +
    `use null / empty arrays when nothing is found in this part.\n\n` +
    chunk;

  try {
    const { data, modelUsed, keyUsed } = await generateJsonGroq(
      prompt,
      systemPrompt,
      {
        apiKey,
        maxTokens,
        requestTimeoutMs: assessConfig.extractRequestTimeoutMs,
        responseSchema,
      },
    );
    console.log(
      `[parse/groq] ok key=${keyUsed} model=${modelUsed} part=${partIndex + 1}/${partCount}`,
    );
    return data;
  } catch (err) {
    console.warn(
      `[parse/groq] part ${partIndex + 1}/${partCount} failed on ${apiKey.name}:`,
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

/**
 * Split `bodyText` across all configured Groq keys, run in parallel, merge parts.
 */
export async function generateJsonGroqSplit(opts: {
  bodyText: string;
  header: string;
  systemPrompt: string;
  responseSchema: z.ZodType;
  mergeParts: (parts: Array<Record<string, unknown>>) => Record<string, unknown>;
  maxTokens?: number;
}): Promise<GroqFormParseResult> {
  if (!groqIsConfigured()) {
    throw new Error("Groq is not configured (set GROQ_API_KEY / GROQ_API_KEY_1..N)");
  }
  const keys = loadGroqKeys();
  if (!keys.length) {
    throw new Error("No Groq API keys available");
  }

  const chunks = splitForParallelKeys(opts.bodyText, keys.length);
  if (!chunks.length) {
    throw new Error("No text to parse");
  }

  const paired = chunks.map((chunk, i) => ({
    chunk,
    key: keys[Math.min(i, keys.length - 1)]!,
    index: i,
  }));

  console.log(
    `[parse/groq] split chars=${opts.bodyText.length} parts=${paired.length} ` +
      `keys=${paired.map((p) => p.key.name).join(",")}`,
  );

  const settled = await Promise.all(
    paired.map(({ chunk, key, index }) =>
      runChunk(
        chunk,
        index,
        paired.length,
        opts.header,
        opts.systemPrompt,
        key,
        opts.responseSchema,
        opts.maxTokens ?? 3072,
      ),
    ),
  );

  const ok = settled.filter((p): p is Record<string, unknown> => p != null);
  if (!ok.length) {
    throw new Error("All Groq form-parse parts failed");
  }

  const data = opts.mergeParts(ok);
  // Validate merged shape softly — caller may re-validate.
  const checked = opts.responseSchema.safeParse(data);
  return {
    data: (checked.success ? checked.data : data) as Record<string, unknown>,
    keyUsed: paired.map((p) => p.key.name).join("+"),
    modelUsed: process.env.GROQ_MODEL?.trim() || "openai/gpt-oss-120b",
    parts: paired.length,
  };
}
