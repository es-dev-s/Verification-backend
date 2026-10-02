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

function dedupeSubjects(rows: ExtractedSubjectRow[]): ExtractedSubjectRow[] {
  const seen = new Map<string, ExtractedSubjectRow>();
  for (const row of rows) {
    const key = row.name
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim();
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
      subjectNameToExtractedRow(s.name),
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
