import { createHash } from "node:crypto";
import {
  generateJsonGroq,
  groqIsConfigured,
  loadGroqKeys,
  type GroqKey,
} from "../lib/groqClient.js";
import { assessConfig } from "./config.js";
import {
  subjectExtractSystemPrompt,
  subjectExtractUserPrompt,
} from "./prompts.js";
import {
  subjectExtractLlmSchema,
  subjectNameToExtractedRow,
  type ExtractedSubjectRow,
  type QualificationType,
} from "./schemas.js";

export type TranscriptSource = {
  documentId: string;
  text: string;
  degreeLevelHint?: QualificationType | "unknown";
};

/**
 * Split transcript text into `parts` roughly equal slices for parallel Groq keys.
 * Prefers page markers, then newlines, falling back to hard char cuts.
 */
function splitForParallelKeys(text: string, parts: number): string[] {
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

  // Prefer splitting on blank lines near equal char boundaries.
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

/**
 * Drop duplicate subject names within the same qualification (first wins,
 * later copies only flag isRepeat). A Bachelor and a Master's subject with the
 * same name are both kept — they are scored in different pools.
 */
export function dedupeSubjects(rows: ExtractedSubjectRow[]): ExtractedSubjectRow[] {
  const seen = new Map<string, ExtractedSubjectRow>();
  for (const row of rows) {
    const key = `${row.qualification ?? "unknown"}|${row.name
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim()}`;
    const existing = seen.get(key);
    if (existing) {
      existing.isRepeat = true;
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

type ChunkStatus = "ok" | "failed" | "skipped" | "empty";

/** Rows plus completeness counters from one extraction run. */
export type SubjectExtractionOutcome = {
  subjects: ExtractedSubjectRow[];
  totalParts: number;
  failedParts: number;
  skippedParts: number;
  missingKeys: boolean;
  complete: boolean;
};

async function extractChunkOnKey(
  chunk: string,
  apiKey: GroqKey,
  pipelineDeadlineMs: number,
): Promise<{ rows: ExtractedSubjectRow[]; status: ChunkStatus }> {
  if (!chunk.trim()) return { rows: [], status: "empty" };
  if (Date.now() >= pipelineDeadlineMs - 1500) return { rows: [], status: "skipped" };

  const requestMs = Math.min(
    assessConfig.extractRequestTimeoutMs,
    Math.max(8_000, pipelineDeadlineMs - Date.now() - 1_000),
  );

  try {
    const { data, modelUsed, keyUsed } = await generateJsonGroq(
      subjectExtractUserPrompt(chunk),
      subjectExtractSystemPrompt(),
      {
        apiKey,
        maxTokens: 8192,
        requestTimeoutMs: requestMs,
        responseSchema: subjectExtractLlmSchema,
      },
    );
    console.log(
      `[assess] subject extract ok model=${modelUsed} key=${keyUsed} subjects=${
        (data as { subjects?: unknown[] }).subjects?.length ?? "?"
      }`,
    );
    return {
      rows: subjectExtractLlmSchema
        .parse(data)
        .subjects.map((s) => subjectNameToExtractedRow(s.name)),
      status: "ok",
    };
  } catch (err) {
    console.error(
      `[assess] subject extract failed key=${apiKey.name}:`,
      err instanceof Error ? err.message : err,
    );
    return { rows: [], status: "failed" };
  }
}

/**
 * Extract subjects from transcript text via Groq.
 * Splits each transcript across all configured Groq keys and runs them in parallel
 * (no Gemini/Mistral, no sequential key fallback).
 */
export async function extractSubjectsFromTranscripts(
  sources: TranscriptSource[],
  opts?: { deadlineMs?: number },
): Promise<SubjectExtractionOutcome> {
  const deadlineMs = opts?.deadlineMs ?? Date.now() + assessConfig.timeoutMs;
  const all: ExtractedSubjectRow[] = [];
  let totalParts = 0;
  let failedParts = 0;
  let skippedParts = 0;

  const keys = loadGroqKeys();
  if (!keys.length || !groqIsConfigured()) {
    console.error(
      "[assess] subject extract: no GROQ_API_KEY / GROQ_API_KEY_1..N configured",
    );
    return {
      subjects: [],
      totalParts: 0,
      failedParts: 0,
      skippedParts: 0,
      missingKeys: true,
      complete: false,
    };
  }

  for (const source of sources) {
    if (!source.text?.trim()) continue;
    if (Date.now() >= deadlineMs) {
      // Whole transcript never attempted — count it as one skipped part.
      totalParts += 1;
      skippedParts += 1;
      continue;
    }

    // One chunk per Groq key so all keys work together at once.
    const chunks = splitForParallelKeys(source.text, keys.length);
    const paired = chunks.map((chunk, i) => ({
      chunk,
      key: keys[Math.min(i, keys.length - 1)]!,
    }));

    console.log(
      `[assess] extract doc=${source.documentId} chars=${source.text.length} ` +
        `parts=${paired.length} keys=${paired.map((p) => p.key.name).join(",")} ` +
        `parallel=true requestMs=${assessConfig.extractRequestTimeoutMs}`,
    );

    const chunkResults = await Promise.all(
      paired.map(({ chunk, key }) =>
        extractChunkOnKey(chunk, key, deadlineMs),
      ),
    );

    for (const { rows, status } of chunkResults) {
      totalParts += 1;
      if (status === "failed") failedParts += 1;
      if (status === "skipped") skippedParts += 1;
      for (const row of rows) {
        all.push({
          ...applyDegreeHint(row, source.degreeLevelHint),
          documentId: source.documentId,
        });
      }
    }
  }

  return {
    subjects: dedupeSubjects(all),
    totalParts,
    failedParts,
    skippedParts,
    missingKeys: false,
    complete: failedParts === 0 && skippedParts === 0,
  };
}

/**
 * Legacy (v1) cache key: transcript ids/texts + CV text only. Kept so subjects
 * persisted by older runs can still be reused without re-extraction.
 */
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

/** Hash of exactly what subject extraction depends on (transcripts + degree levels). */
export function hashSubjectInput(
  transcripts: Array<{ id: string; text: string; degreeLevel?: string | null }>,
): string {
  const h = createHash("sha256");
  h.update("subjects-v2\0");
  for (const t of transcripts) {
    h.update(t.id);
    h.update("\0");
    h.update(t.degreeLevel ?? "");
    h.update("\0");
    h.update(t.text);
    h.update("\0");
  }
  return h.digest("hex");
}

/**
 * Full scoring cache key: subject hash + everything else that changes the
 * score (CV, confirmed experience, qualifications / degree selections, rubric
 * files, scoring config). Values are serialised with sorted keys.
 */
export function hashScoringInput(parts: Record<string, unknown>): string {
  return createHash("sha256")
    .update("score-v2\0")
    .update(stableStringify(parts))
    .digest("hex");
}

export function stableStringify(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .filter((k) => obj[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
    .join(",")}}`;
}

/** Map Document.degreeLevel to bachelor/master/unknown for subject qualification. */
export function degreeLevelToQualification(
  level: string | null | undefined,
): QualificationType | "unknown" {
  if (level === "bachelor") return "bachelor";
  if (level === "master") return "master";
  return "unknown";
}
