/**
 * Phase 1 level check for transcript / certificate reads.
 *
 * A transcript or certificate filed under one degree level may print an award
 * of another level (e.g. a National Diploma uploaded under Bachelor). When the
 * document prints only that one award, the read keeps the award and flags the
 * mismatch so the assessor sees it. When the document also prints an award at
 * the target level (several awards), the read stays strict and drops the
 * other-level title. CV reads are not checked here; they stay strict.
 */
import type { DegreeLevelLabel, DocumentTypeLabel, EducationExtract } from "./schemas.js";

export const LEVEL_MISMATCH_FLAG = "level_mismatch";

/** Award level printed on a document. The DB has no certificate level, so it is only detected. */
export type DetectedAwardLevel = DegreeLevelLabel | "certificate";

export type LevelMismatch = {
  documentId: string;
  documentType: DocumentTypeLabel;
  targetLevel: DegreeLevelLabel;
  detectedLevel: DetectedAwardLevel;
  /** Short award name as printed, e.g. "National Diploma". */
  awardName: string;
  degreeTitle: string;
};

/** Award level named by a degree title; null when the title names no award. */
export function awardLevelFromTitle(
  title: string | null | undefined,
): DetectedAwardLevel | null {
  const t = (title ?? "").toLowerCase().replace(/\s+/g, " ").trim();
  if (!t) return null;
  if (/\b(?:ph\.?\s?d|doctor\s+of|doctorate)\b/.test(t)) return "phd";
  if (/\b(?:master|masters|master's|m\.?\s?sc|m\.?\s?eng|m\.?\s?tech|mba|mphil)\b/.test(t)) {
    return "master";
  }
  if (
    /\b(?:bachelor|bachelors|bachelor's|b\.?\s?sc|b\.?\s?eng|b\.?\s?tech|b\.?e\.|b\.?s\.|bsc|beng|btech)(?=\W|$)/.test(t)
  ) {
    return "bachelor";
  }
  // Graduate / postgraduate diplomas and certificates sit above a bachelor: no level guess.
  if (/\b(?:post\s*-?\s*graduate|graduate)\s+(?:diploma|certificate)\b/.test(t)) return null;
  if (/\badv(?:anced|\.)?\s+dip(?:loma|\.)?\b/.test(t)) return "advanced_diploma";
  if (/\bdiploma\b/.test(t)) return "diploma";
  if (/\bcertificate\b|\bcert\.?\s*(?:iv|iii|ii|i)\b/.test(t)) return "certificate";
  return null;
}

/** Printed award phrases at each target level (title wording, not passing mentions). */
const TARGET_AWARD_RE: Record<DegreeLevelLabel, RegExp> = {
  phd: /\b(?:doctor\s+of\s+philosophy|ph\.?\s?d\.?\s+(?:in|of)\b|doctorate\s+(?:in|of)\b)/i,
  master: /\b(?:master(?:'?s)?\s+(?:of|in|degree)\b|m\.?\s?(?:sc|eng|tech)\.?\s+(?:in\s+)?[a-z])/i,
  bachelor:
    /\b(?:bachelor(?:'?s|`s)?\s+(?:of|in|degree)\b|b\.\s?(?:sc|eng|tech)\.?\s+(?:in\s+)?[a-z]|(?:bsc|beng|btech)\s+(?:in\s+)?[a-z])/i,
  advanced_diploma: /\badvanced\s+diploma\s+(?:of|in)\b/i,
  diploma: /(?<!advanced\s)(?<!graduate\s)\bdiploma\s+(?:of|in)\b/i,
};

/** True when the document text prints an award at the target level. */
export function printsAwardAtLevel(text: string, level: DegreeLevelLabel): boolean {
  return TARGET_AWARD_RE[level].test(text);
}

/** "National Diploma in Civil Engineering" → "National Diploma". */
export function awardNameOf(title: string): string {
  const t = title.replace(/\s+/g, " ").trim();
  const head = t.split(/\s+(?:in|of)\s+/i)[0]?.trim() ?? t;
  const name = head.length >= 3 && head.length <= 40 ? head : t;
  // Title-case an all-caps award name for the note ("NATIONAL DIPLOMA" → "National Diploma").
  if (name === name.toUpperCase()) {
    return name
      .toLowerCase()
      .replace(/\b([a-z])/g, (c) => c.toUpperCase());
  }
  return name;
}

/**
 * Check one transcript / certificate source read for a target level.
 * - Title at the target level, or no award word: unchanged, no mismatch.
 * - Title at another level and the document also prints a target-level award:
 *   strict (title dropped, no mismatch).
 * - Title at another level and no target-level award printed: kept, mismatch set.
 */
export function checkLevelMismatch(input: {
  documentId: string;
  documentType: DocumentTypeLabel;
  targetLevel: DegreeLevelLabel;
  text: string;
  extract: EducationExtract;
}): { extract: EducationExtract; mismatch: LevelMismatch | null } {
  const { extract, targetLevel, documentType } = input;
  if (documentType === "CV") return { extract, mismatch: null };
  const title = extract.degreeTitle?.trim();
  if (!title) return { extract, mismatch: null };
  const detected = awardLevelFromTitle(title);
  if (!detected || detected === targetLevel) return { extract, mismatch: null };
  if (printsAwardAtLevel(input.text, targetLevel)) {
    return { extract: { ...extract, degreeTitle: null }, mismatch: null };
  }
  return {
    extract,
    mismatch: {
      documentId: input.documentId,
      documentType,
      targetLevel,
      detectedLevel: detected,
      awardName: awardNameOf(title),
      degreeTitle: title,
    },
  };
}

/** Result flags: merge flags, then heuristics_fallback, then level_mismatch (+ detected levels). */
export function educationResultFlags(
  mergedFlags: string[],
  fallback: boolean,
  mismatches: LevelMismatch[],
): string[] {
  const flags = [...mergedFlags];
  if (fallback) flags.push("heuristics_fallback");
  if (mismatches.length) {
    flags.push(LEVEL_MISMATCH_FLAG);
    for (const level of new Set(mismatches.map((m) => m.detectedLevel))) {
      flags.push(`${LEVEL_MISMATCH_FLAG}:${level}`);
    }
  }
  return flags;
}
