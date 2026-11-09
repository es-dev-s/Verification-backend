/**
 * Text window for the single-key degree read.
 * Subjects stay split across every Groq key. This window is only the opening
 * and the closing of a transcript, where the qualification and the award are
 * printed. The unit table in the middle is left for subject extraction.
 */
import { heuristicsEducationFromText } from "./heuristics.js";
import type { EducationExtract } from "./schemas.js";

const HEAD_CHARS = 4_000;
const TAIL_CHARS = 3_000;
const PAGE_MARK = /---\s*page\s+\d+\s*---/i;

function cap(page: string, max: number): string {
  const trimmed = page.trim();
  return trimmed.length <= max ? trimmed : trimmed.slice(0, max).trim();
}

export function degreeReaderWindow(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "";

  const pages = trimmed
    .split(PAGE_MARK)
    .map((page) => page.trim())
    .filter(Boolean);

  if (pages.length >= 2) {
    const first = pages[0]!;
    const last = pages[pages.length - 1]!;
    const head = cap(first, HEAD_CHARS);
    const tail = cap(last, TAIL_CHARS);
    if (head === tail) return head;
    const omitted =
      pages.length > 2 || first.length > HEAD_CHARS || last.length > TAIL_CHARS;
    const glue = omitted ? "\n\n--- later pages omitted ---\n\n" : "\n\n";
    return `${head}${glue}${tail}`;
  }

  if (trimmed.length <= HEAD_CHARS + TAIL_CHARS) return trimmed;
  const head = trimmed.slice(0, HEAD_CHARS).trim();
  const tail = trimmed.slice(-TAIL_CHARS).trim();
  return `${head}\n\n--- later pages omitted ---\n\n${tail}`;
}

const TEXT_FIELDS = [
  "degreeTitle",
  "institution",
  "country",
  "start",
  "end",
  "statedDuration",
] as const;

/**
 * Fill only the fields Groq left empty. A value Groq already returned is kept,
 * including when the label reader would have chosen something else.
 */
export function fillEmptyEducationFields(
  extract: EducationExtract,
  fullText: string,
): EducationExtract {
  const guessed = heuristicsEducationFromText(fullText);
  const next: EducationExtract = { ...extract };
  for (const field of TEXT_FIELDS) {
    if (next[field]?.trim()) continue;
    const value = guessed[field];
    if (value?.trim()) next[field] = value;
  }
  return next;
}
