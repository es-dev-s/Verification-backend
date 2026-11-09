/**
 * 312999 Building and Engineering Technicians nec: fallback only.
 *
 * 312999 has no subjects and no rubric, so it is never scored and never a
 * first-pass match. It is suggested only when:
 *  - Gate 1 is open with the Engineering Associate track, and
 *  - no scored specific Associate ANZSCO (312211, 312311, 312411, 312511;
 *    plus the telecom codes 313212 / 313213 / 313214 when the ICT60220 path
 *    ran) reaches ASSOCIATE_FALLBACK_THRESHOLD (70%).
 * ICT60220 holders never get 312999 (the telecommunications group decides
 * for them).
 *
 * When it is suggested, each specific code is listed with its score and the
 * units / subjects still missing (near-miss list).
 */
import type { AssociateFallback, AssociateFallbackNearMiss } from "./schemas.js";

export const NEC_ANZSCO = "312999";
export const NEC_TITLE = "Building and Engineering Technicians nec";
export const ASSOCIATE_FALLBACK_THRESHOLD = 70;
/** Specific Associate codes with a rubric. */
export const ASSOCIATE_SPECIFIC_CODES = ["312211", "312311", "312411", "312511"] as const;
/** Telecom Associate codes, counted only when the ICT60220 path ran. */
export const ASSOCIATE_TELECOM_CODES = ["313212", "313213", "313214"] as const;
/** Titles (anzsco_skill_levels.json) for codes listed but not scored. */
const TITLES: Record<string, string> = {
  "312211": "Civil Engineering Draftsperson",
  "312311": "Electrical Engineering Draftsperson",
  "312411": "Electronic Engineering Draftsperson",
  "312511": "Mechanical Engineering Draftsperson",
  "313212": "Telecommunication Field Engineer",
  "313213": "Telecommunications Network Planner",
  "313214": "Telecommunications Technical Officer or Technologist",
};
export const NOT_SCORED_NOTE = "Not scored: no matching units or subjects on the transcript.";

export type AssociateFallbackEntry = {
  anzscoCode: string;
  title: string;
  confidenceScore: number | null;
  determination?: string | null;
  missing?: string[];
};

/**
 * Pure decision. Returns null when the Engineering Associate track is not open
 * (312999 does not apply at all).
 */
export function associateFallbackFor(input: {
  associateOpen: boolean;
  ict60220: boolean;
  entries: readonly AssociateFallbackEntry[];
}): AssociateFallback | null {
  if (!input.associateOpen) return null;
  const codes: string[] = [
    ...ASSOCIATE_SPECIFIC_CODES,
    ...(input.ict60220 ? ASSOCIATE_TELECOM_CODES : []),
  ];
  // Best score per code (the same code can appear in several lists).
  const best = new Map<string, AssociateFallbackEntry>();
  for (const e of input.entries) {
    if (!codes.includes(e.anzscoCode)) continue;
    const prev = best.get(e.anzscoCode);
    if (!prev || (e.confidenceScore ?? -1) > (prev.confidenceScore ?? -1)) best.set(e.anzscoCode, e);
  }
  // Every specific code is listed; one that was not scored shows no score.
  for (const code of codes) {
    if (!best.has(code)) {
      best.set(code, { anzscoCode: code, title: TITLES[code] ?? code, confidenceScore: null, missing: [NOT_SCORED_NOTE] });
    }
  }
  const nearMisses: AssociateFallbackNearMiss[] = [...best.values()]
    .map((e) => ({
      anzscoCode: e.anzscoCode,
      title: e.title,
      confidenceScore: e.confidenceScore,
      determination: e.determination ?? null,
      missing: [...new Set(e.missing ?? [])],
    }))
    .sort((a, b) => (b.confidenceScore ?? -1) - (a.confidenceScore ?? -1) || a.anzscoCode.localeCompare(b.anzscoCode));
  const base = {
    anzscoCode: NEC_ANZSCO,
    title: NEC_TITLE,
    threshold: ASSOCIATE_FALLBACK_THRESHOLD,
    nearMisses,
  };
  if (input.ict60220) {
    return {
      ...base,
      suggested: false,
      reason: "Not suggested: ICT60220 holders are assessed in the telecommunications group, never 312999.",
    };
  }
  const passing = nearMisses.find(
    (n) => n.confidenceScore != null && n.confidenceScore >= ASSOCIATE_FALLBACK_THRESHOLD,
  );
  if (passing) {
    return {
      ...base,
      suggested: false,
      reason: `Not suggested: ${passing.title} (${passing.anzscoCode}) reaches ${passing.confidenceScore}% (${ASSOCIATE_FALLBACK_THRESHOLD}% or more).`,
    };
  }
  return {
    ...base,
    suggested: true,
    reason:
      nearMisses[0]?.confidenceScore != null
        ? `Fallback: no specific Engineering Associate ANZSCO reaches ${ASSOCIATE_FALLBACK_THRESHOLD}% (best ${nearMisses[0].confidenceScore}%).`
        : `Fallback: no specific Engineering Associate ANZSCO was scored.`,
  };
}