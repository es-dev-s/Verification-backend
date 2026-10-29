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
      // Keep a unit code found by another chunk for the same subject.
      if (!existing.code && row.code) existing.code = row.code;
      // Same for credits / year-semester printed only in another chunk.
      if (!existing.credits && row.credits) existing.credits = row.credits;
      if (!existing.yearOrSemester && row.yearOrSemester) {
        existing.yearOrSemester = row.yearOrSemester;
      }
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
  if (hint && hint !== "unknown") {
    return { ...row, qualification: hint };
  }
  return row;
}

async function extractChunkOnKey(
  chunk: string,
  apiKey: GroqKey,
  pipelineDeadlineMs: number,
): Promise<ExtractedSubjectRow[]> {
  if (!chunk.trim()) return [];
  if (Date.now() >= pipelineDeadlineMs - 1500) return [];

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
    return subjectExtractLlmSchema.parse(data).subjects.map((s) =>
      subjectNameToExtractedRow(s.name, s.code ?? null, {
        credits: s.credits ?? null,
        yearOrSemester: s.yearOrSemester ?? null,
      }),
    );
  } catch (err) {
    console.error(
      `[assess] subject extract failed key=${apiKey.name}:`,
      err instanceof Error ? err.message : err,
    );
    return [];
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
): Promise<ExtractedSubjectRow[]> {
  const deadlineMs = opts?.deadlineMs ?? Date.now() + assessConfig.timeoutMs;
  const all: ExtractedSubjectRow[] = [];

  const keys = loadGroqKeys();
  if (!keys.length || !groqIsConfigured()) {
    console.error(
      "[assess] subject extract: no GROQ_API_KEY / GROQ_API_KEY_1..N configured",
    );
    return [];
  }

  for (const source of sources) {
    if (!source.text?.trim()) continue;
    if (Date.now() >= deadlineMs) break;

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

    for (const rows of chunkResults) {
      for (const row of rows) {
        all.push({
          ...applyDegreeHint(row, source.degreeLevelHint),
          documentId: source.documentId,
        });
      }
    }
  }

  return dedupeSubjects(all);
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
  // v3: rows carry unit codes (vocational transcripts); v4: rows also carry
  // credits and year / semester, so older saved rows are re-extracted once.
  h.update("subjects-v4-terms\0");
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
    .update("score-v3\0")
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

/**
 * Degree level named by a qualification / transcript title, or null when the
 * title does not say. Checked most-specific first ("Advanced Diploma" before
 * "Diploma", "Associate Degree" before "Degree").
 */
export function degreeLevelFromTitle(
  title: string | null | undefined,
): QualificationType | null {
  const t = (title ?? "").toLowerCase();
  if (!t.trim()) return null;
  if (/\bassociate\s+(?:degree|of\b)|\bassoc\.?\s+deg/.test(t)) return "associate_degree";
  if (/\badv(?:anced|\.)?\s+dip(?:loma|\.)?\b/.test(t)) return "advanced_diploma";
  if (/\b(?:master|masters|master's|m\.?\s?sc|m\.?\s?eng|m\.?\s?tech|m\.?e\.)\b/.test(t)) {
    return "master";
  }
  if (
    /\b(?:bachelor|bachelors|bachelor's|b\.?\s?sc|b\.?\s?eng|b\.?\s?tech|b\.?e\.|b\.?s\.)(?=\W|$)/.test(t)
  ) {
    return "bachelor";
  }
  // Graduate / postgraduate diplomas sit above a bachelor: not a diploma-level group.
  if (/\b(?:post\s*-?\s*graduate|graduate)\s+diploma\b/.test(t)) return null;
  if (/\bdiploma\b/.test(t)) return "diploma";
  return null;
}

/**
 * Map Document.degreeLevel (+ the qualification title at that level, when
 * known) to the subject qualification used for scoring. The DB enum has no
 * associate degree, so an "Associate Degree …" title refines a diploma /
 * advanced-diploma / unlabelled document; a document without a level falls
 * back to whatever level its title names.
 */
export function degreeLevelToQualification(
  level: string | null | undefined,
  degreeTitle?: string | null,
): QualificationType | "unknown" {
  const fromTitle = degreeLevelFromTitle(degreeTitle);
  if (level === "bachelor") return "bachelor";
  if (level === "master") return "master";
  if (level === "diploma" || level === "advanced_diploma") {
    return fromTitle === "associate_degree" ? "associate_degree" : level;
  }
  if (!level) return fromTitle ?? "unknown";
  return "unknown";
}
