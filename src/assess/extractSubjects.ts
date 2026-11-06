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
  if (hint && hint !== "unknown") {
    return { ...row, qualification: hint };
  }
  return row;
}

/** Why a chunk could not be read (logged and kept on the extraction record). */
export type ChunkFailureReason =
  | "rate_limited"
  | "cut_off"
  | "empty"
  | "invalid_json"
  | "timeout"
  | "deadline"
  | "error";

export function classifyExtractError(err: unknown): ChunkFailureReason {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  if (/rate limit|\b429\b|too many requests/.test(msg)) return "rate_limited";
  if (/truncated|finish_reason=length/.test(msg)) return "cut_off";
  if (/empty groq response/.test(msg)) return "empty";
  if (/invalid json|non-json|zod|expected|required/.test(msg)) return "invalid_json";
  if (/timed out|abort/.test(msg)) return "timeout";
  return "error";
}

type ChunkCall = (chunk: string, apiKey: GroqKey, requestTimeoutMs: number) => Promise<unknown>;

const defaultChunkCall: ChunkCall = async (chunk, apiKey, requestTimeoutMs) => {
  const { data, modelUsed, keyUsed } = await generateJsonGroq(
    subjectExtractUserPrompt(chunk),
    subjectExtractSystemPrompt(),
    {
      apiKey,
      maxTokens: 8192,
      requestTimeoutMs,
      responseSchema: subjectExtractLlmSchema,
    },
  );
  console.log(
    `[assess] subject extract ok model=${modelUsed} key=${keyUsed} subjects=${
      (data as { subjects?: unknown[] }).subjects?.length ?? "?"
    }`,
  );
  return data;
};

export type ChunkAttempt = { key: string; reason: ChunkFailureReason };

export type ChunkOutcome =
  | { ok: true; rows: ExtractedSubjectRow[]; attempts: ChunkAttempt[] }
  | { ok: false; reason: ChunkFailureReason; attempts: ChunkAttempt[] };

/** Backoff before retrying on the same key (rate limits wait longer). */
export const EXTRACT_RETRY_BACKOFF_MS = { rateLimited: 4_000, other: 1_500 };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Read one chunk: first on its own key, then on each other key, then once
 * more on its own key after a backoff. Every failure is logged with its
 * reason (429 / cut off / empty / invalid JSON / timeout).
 */
export async function extractChunkWithRetry(
  chunk: string,
  ownKey: GroqKey,
  keys: GroqKey[],
  pipelineDeadlineMs: number,
  opts: { call?: ChunkCall; backoffMs?: typeof EXTRACT_RETRY_BACKOFF_MS; label?: string } = {},
): Promise<ChunkOutcome> {
  if (!chunk.trim()) return { ok: true, rows: [], attempts: [] };
  const call = opts.call ?? defaultChunkCall;
  const backoff = opts.backoffMs ?? EXTRACT_RETRY_BACKOFF_MS;
  const others = keys.filter((k) => k.name !== ownKey.name);
  const plan: Array<{ key: GroqKey; waitFirst: boolean }> = [
    { key: ownKey, waitFirst: false },
    ...others.map((key) => ({ key, waitFirst: false })),
    { key: ownKey, waitFirst: true },
  ];
  const attempts: ChunkAttempt[] = [];
  let last: ChunkFailureReason = "error";
  for (const step of plan) {
    if (step.waitFirst) {
      const wait = last === "rate_limited" ? backoff.rateLimited : backoff.other;
      if (Date.now() + wait >= pipelineDeadlineMs - 1500) break;
      await sleep(wait);
    }
    if (Date.now() >= pipelineDeadlineMs - 1500) {
      last = attempts.length ? last : "deadline";
      break;
    }
    const requestMs = Math.min(
      assessConfig.extractRequestTimeoutMs,
      Math.max(8_000, pipelineDeadlineMs - Date.now() - 1_000),
    );
    try {
      const data = await call(chunk, step.key, requestMs);
      const parsed = subjectExtractLlmSchema.parse(data);
      const rows = parsed.subjects.map((s) =>
        subjectNameToExtractedRow(s.name, s.code ?? null, {
          credits: s.credits ?? null,
          yearOrSemester: s.yearOrSemester ?? null,
          entryStatus: s.entryStatus ?? null,
        }),
      );
      if (attempts.length) {
        console.log(
          `[assess] subject extract ${opts.label ?? "chunk"} recovered on key=${step.key.name} after ${attempts.length} failed attempt(s)`,
        );
      }
      return { ok: true, rows, attempts };
    } catch (err) {
      last = classifyExtractError(err);
      attempts.push({ key: step.key.name, reason: last });
      console.error(
        `[assess] subject extract ${opts.label ?? "chunk"} failed key=${step.key.name} reason=${last}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  return { ok: false, reason: last, attempts };
}

/** Pages ("--- page N ---" markers) a chunk covers, when the text has markers. */
export function pagesInChunk(chunk: string, fullText: string): number[] {
  const markers = [...fullText.matchAll(/---\s*page\s+(\d+)\s*---/gi)];
  if (!markers.length) return [];
  // Page text inside the chunk: find which page bodies it contains.
  const bodies = fullText
    .trim()
    .split(/\n?---\s*page\s+\d+\s*---\n/i)
    .map((p) => p.trim());
  const nums = markers.map((m) => Number(m[1]));
  // When the text starts with a marker the first split piece is empty.
  const offset = bodies.length > nums.length ? 1 : 0;
  const out: number[] = [];
  nums.forEach((n, i) => {
    const body = bodies[i + offset];
    if (body && chunk.includes(body.slice(0, Math.min(200, body.length)))) out.push(n);
  });
  return out;
}

export type FailedChunk = {
  documentId: string;
  chunk: number;
  chunks: number;
  pages: number[];
  reason: ChunkFailureReason;
  attempts: number;
};

export type SubjectExtractResult = {
  rows: ExtractedSubjectRow[];
  /** True when at least one chunk could not be read after all retries. */
  partial: boolean;
  failedChunks: FailedChunk[];
};

/** Chunk count for one transcript: one per key, more for long text (also with one key). */
export function chunkCountFor(textLength: number, keyCount: number, maxChunkChars: number): number {
  const bySize = maxChunkChars > 0 ? Math.ceil(textLength / maxChunkChars) : 1;
  return Math.max(1, keyCount, bySize);
}

/**
 * Extract subjects from transcript text via Groq.
 * Long transcripts are split (page markers first) into at least one chunk per
 * key; each key reads its chunks in turn while the keys run in parallel. A
 * failed chunk is retried on another key, then on its own key after a backoff;
 * a chunk that still fails makes the result partial (never silently dropped).
 */
export async function extractSubjectsDetailed(
  sources: TranscriptSource[],
  opts?: { deadlineMs?: number; keys?: GroqKey[]; call?: ChunkCall; backoffMs?: typeof EXTRACT_RETRY_BACKOFF_MS; maxChunkChars?: number },
): Promise<SubjectExtractResult> {
  const deadlineMs = opts?.deadlineMs ?? Date.now() + assessConfig.timeoutMs;
  const all: ExtractedSubjectRow[] = [];
  const failedChunks: FailedChunk[] = [];

  const keys = opts?.keys ?? (groqIsConfigured() ? loadGroqKeys() : []);
  if (!keys.length) {
    console.error(
      "[assess] subject extract: no GROQ_API_KEY / GROQ_API_KEY_1..N configured",
    );
    return { rows: [], partial: false, failedChunks: [] };
  }
  const maxChunkChars = opts?.maxChunkChars ?? assessConfig.extractMaxChunkChars;

  for (const source of sources) {
    if (!source.text?.trim()) continue;

    const parts = chunkCountFor(source.text.trim().length, keys.length, maxChunkChars);
    const chunks = splitForParallelKeys(source.text, parts);
    const paired = chunks.map((chunk, i) => ({ chunk, index: i, key: keys[i % keys.length]! }));

    console.log(
      `[assess] extract doc=${source.documentId} chars=${source.text.length} ` +
        `parts=${paired.length} keys=${[...new Set(paired.map((p) => p.key.name))].join(",")} ` +
        `parallel=true requestMs=${assessConfig.extractRequestTimeoutMs}`,
    );

    // Keys run in parallel; chunks sharing a key are read one after another.
    const byKey = new Map<string, typeof paired>();
    for (const p of paired) byKey.set(p.key.name, [...(byKey.get(p.key.name) ?? []), p]);
    const outcomes: Array<{ index: number; outcome: ChunkOutcome }> = [];
    await Promise.all(
      [...byKey.values()].map(async (queue) => {
        for (const p of queue) {
          const outcome =
            Date.now() >= deadlineMs - 1500
              ? ({ ok: false, reason: "deadline", attempts: [] } as ChunkOutcome)
              : await extractChunkWithRetry(p.chunk, p.key, keys, deadlineMs, {
                  call: opts?.call,
                  backoffMs: opts?.backoffMs,
                  label: `doc=${source.documentId} part=${p.index + 1}/${paired.length}`,
                });
          outcomes.push({ index: p.index, outcome });
        }
      }),
    );
    outcomes.sort((a, b) => a.index - b.index);

    for (const { index, outcome } of outcomes) {
      if (!outcome.ok) {
        const pages = pagesInChunk(paired[index]!.chunk, source.text);
        failedChunks.push({
          documentId: source.documentId,
          chunk: index + 1,
          chunks: paired.length,
          pages,
          reason: outcome.reason,
          attempts: outcome.attempts.length,
        });
        console.error(
          `[assess] subject extract PARTIAL doc=${source.documentId} part=${index + 1}/${paired.length} ` +
            `pages=${pages.length ? pages.join(",") : "?"} reason=${outcome.reason} attempts=${outcome.attempts.length}`,
        );
        continue;
      }
      for (const row of outcome.rows) {
        all.push({
          ...applyDegreeHint(row, source.degreeLevelHint),
          documentId: source.documentId,
        });
      }
    }
  }

  return { rows: dedupeSubjects(all), partial: failedChunks.length > 0, failedChunks };
}

/** Rows only (callers that do not track partial reads). */
export async function extractSubjectsFromTranscripts(
  sources: TranscriptSource[],
  opts?: { deadlineMs?: number },
): Promise<ExtractedSubjectRow[]> {
  return (await extractSubjectsDetailed(sources, opts)).rows;
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
    .update("score-v4\0") // v4: duration counts the span studied
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
  // Title-derived Diploma / Advanced Diploma / Associate Degree beats a mismatched Bachelor/Master upload tag.
  if (
    (level === "bachelor" || level === "master") &&
    (fromTitle === "diploma" || fromTitle === "advanced_diploma" || fromTitle === "associate_degree")
  ) {
    return fromTitle;
  }
  if (level === "bachelor") return "bachelor";
  if (level === "master") return "master";
  if (level === "diploma" || level === "advanced_diploma") {
    return fromTitle === "associate_degree" ? "associate_degree" : level;
  }
  if (!level) return fromTitle ?? "unknown";
  return "unknown";
}
