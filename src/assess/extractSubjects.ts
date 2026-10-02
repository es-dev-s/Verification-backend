import { createHash } from "node:crypto";
import { config } from "../config.js";
import { generateJson } from "../lib/gemini.js";
import { acquireParseSlot } from "../lib/rateLimit.js";
import { assessConfig } from "./config.js";
import {
  subjectExtractSystemPrompt,
  subjectExtractUserPrompt,
} from "./prompts.js";
import {
  extractedSubjectSchema,
  subjectExtractSchema,
  type ExtractedSubjectRow,
  type QualificationType,
} from "./schemas.js";

export type TranscriptSource = {
  documentId: string;
  text: string;
  degreeLevelHint?: QualificationType | "unknown";
};

/**
 * Pack transcript pages into ≤ maxChunks bags of ~chunkChars.
 * Avoids one Gemini call per OCR page (the main cause of deadline blowups).
 */
function packChunks(
  text: string,
  chunkChars: number,
  maxChunks: number,
): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];

  const pages = trimmed
    .split(/\n---\s*page\s+\d+\s*---\n/i)
    .map((p) => p.trim())
    .filter(Boolean);
  const units = pages.length > 1 ? pages : [trimmed];

  const bags: string[] = [];
  let current = "";
  for (const unit of units) {
    const next = current ? `${current}\n\n${unit}` : unit;
    if (current && next.length > chunkChars) {
      bags.push(current);
      current = unit;
    } else {
      current = next;
    }
  }
  if (current.trim()) bags.push(current);

  if (bags.length <= maxChunks) return bags;

  const merged: string[] = Array.from({ length: maxChunks }, () => "");
  bags.forEach((bag, i) => {
    const slot = Math.min(
      maxChunks - 1,
      Math.floor((i * maxChunks) / bags.length),
    );
    merged[slot] = merged[slot] ? `${merged[slot]}\n\n${bag}` : bag;
  });
  return merged.filter((b) => b.trim());
}

function dedupeSubjects(rows: ExtractedSubjectRow[]): ExtractedSubjectRow[] {
  const seen = new Map<string, ExtractedSubjectRow>();
  for (const row of rows) {
    const key = `${row.qualification}|${(row.code ?? "").toLowerCase()}|${row.name
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim()}`;
    const existing = seen.get(key);
    if (existing) {
      existing.isRepeat = true;
      if (!existing.grade && row.grade) existing.grade = row.grade;
      continue;
    }
    seen.set(key, { ...row, isRepeat: row.isRepeat ?? false });
  }
  return [...seen.values()];
}

function applyDegreeHint(
  row: ExtractedSubjectRow,
  hint?: QualificationType | "unknown",
): ExtractedSubjectRow {
  if (row.qualification !== "unknown") return row;
  if (hint === "bachelor" || hint === "master") {
    return { ...row, qualification: hint };
  }
  return row;
}

async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, Math.max(items.length, 1)) },
    async () => {
      while (true) {
        const i = next++;
        if (i >= items.length) return;
        results[i] = await fn(items[i]!, i);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

async function extractChunk(
  chunk: string,
  hint: string | undefined,
  pipelineDeadlineMs: number,
): Promise<ExtractedSubjectRow[]> {
  if (Date.now() >= pipelineDeadlineMs - 1500) return [];

  // Primary model only (same first model as form autofill). Do NOT spin every
  // fallback model/key for 60s — that is what produced fake "deadline exceeded".
  const primaryModel = config.geminiModels[0];
  if (!primaryModel) {
    console.error("[assess] no GEMINI_MODEL configured");
    return [];
  }

  const requestMs = Math.min(
    assessConfig.extractRequestTimeoutMs,
    Math.max(8_000, pipelineDeadlineMs - Date.now() - 1_000),
  );
  const callDeadlineMs = Date.now() + requestMs;

  const run = async () => {
    await acquireParseSlot(config.parseRpm);
    const { data, modelUsed } = await generateJson(
      subjectExtractUserPrompt(chunk, hint),
      subjectExtractSystemPrompt(),
      {
        deadlineMs: callDeadlineMs,
        maxTokens: 4096,
        requestTimeoutMs: requestMs,
        models: [primaryModel],
        maxAttempts: 2,
        failFastOnAbort: true,
        // Zod-validate after; constrained schema on big subject lists is too slow.
      },
    );
    console.log(`[assess] subject extract ok model=${modelUsed}`);
    return subjectExtractSchema.parse(data).subjects.map((s) =>
      extractedSubjectSchema.parse(s),
    );
  };

  try {
    return await run();
  } catch (err) {
    console.error(
      "[assess] subject extract failed:",
      err instanceof Error ? err.message : err,
    );
    return [];
  }
}

/**
 * Extract subjects from transcript text via LLM (packed chunks), validate, merge, dedupe.
 */
export async function extractSubjectsFromTranscripts(
  sources: TranscriptSource[],
  opts?: { deadlineMs?: number },
): Promise<ExtractedSubjectRow[]> {
  const deadlineMs = opts?.deadlineMs ?? Date.now() + assessConfig.timeoutMs;
  const all: ExtractedSubjectRow[] = [];

  for (const source of sources) {
    if (!source.text?.trim()) continue;
    if (Date.now() >= deadlineMs) break;

    const hint =
      source.degreeLevelHint === "bachelor" ||
      source.degreeLevelHint === "master"
        ? source.degreeLevelHint
        : undefined;

    const chunks = packChunks(
      source.text,
      assessConfig.chunkChars,
      assessConfig.maxChunks,
    );
    console.log(
      `[assess] extract doc=${source.documentId} chars=${source.text.length} chunks=${chunks.length} ` +
        `model=${config.geminiModels[0] ?? "?"} requestMs=${assessConfig.extractRequestTimeoutMs}`,
    );

    const chunkResults = await mapPool(
      chunks,
      assessConfig.extractConcurrency,
      async (chunk) => extractChunk(chunk, hint, deadlineMs),
    );

    for (const rows of chunkResults) {
      for (const row of rows) {
        all.push(applyDegreeHint(row, source.degreeLevelHint));
      }
    }
  }

  return dedupeSubjects(all);
}

export function hashAssessmentInput(
  transcripts: Array<{ id: string; text: string }>,
  cvText: string | null,
): string {
  const h = createHash("sha256");
  for (const t of transcripts) {
    h.update(t.id);
    h.update("\0");
    h.update(t.text);
    h.update("\0");
  }
  h.update(cvText ?? "");
  return h.digest("hex");
}

/** Map Document.degreeLevel to bachelor/master/unknown for subject qualification. */
export function degreeLevelToQualification(
  level: string | null | undefined,
): QualificationType | "unknown" {
  if (level === "bachelor") return "bachelor";
  if (level === "master") return "master";
  return "unknown";
}
