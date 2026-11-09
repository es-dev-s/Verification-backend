import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { countryFieldsMatch, textFieldsMatch, universityFieldsMatch } from "./precedent.js";
import type { HistoricalStats, SimilarCasesSummary } from "./schemas.js";

/**
 * Historical component (doc 05 §7): "where available, similarity between the
 * current academic profile and the historical profiles".
 *
 * The datasheet (verification_datasheet.json) has no subject lists, so the
 * comparable profile is the qualification on file: degree title, university
 * and country of the bachelor (else master, else diploma) of each past case
 * with the same ANZSCO.
 *
 *   similarity = 0.5 × degree title match + 0.3 × university match + 0.2 × country match
 *
 * A past case is "similar" at similarity ≥ 0.5 (same degree title, or same
 * university and country). The component score shrinks the similarity-
 * weighted positive % of the similar cases towards the ANZSCO's overall
 * positive % with a prior of SIMILARITY_PRIOR cases, so one or two lookalike
 * cases cannot swing the score on their own:
 *
 *   score = (Σ wᵢ·positiveᵢ·100 + k × overall%) ÷ (Σ wᵢ + k)
 *
 * With no similar case the score is the ANZSCO's overall positive %. The
 * Historical weight (20%) is unchanged.
 */
export const SIMILARITY_WEIGHTS = { degree: 0.5, university: 0.3, country: 0.2 } as const;
export const SIMILARITY_THRESHOLD = 0.5;
export const SIMILARITY_PRIOR = 5;
export const SIMILARITY_METHOD =
  "Past cases for this ANZSCO weighted by similarity of degree title (50%), university (30%) and country (20%); " +
  `cases at ≥ ${SIMILARITY_THRESHOLD * 100}% similarity count, blended with all past cases for the ANZSCO (prior of ${SIMILARITY_PRIOR}).`;

export type ApplicantQualification = {
  degreeTitle: string | null;
  university: string | null;
  country: string | null;
};

type QualBlock = { title?: string | null; university?: string | null; college?: string | null; country?: string | null };
export type PastCase = {
  occupation?: { anzscoCode?: string | null };
  qualifications?: { diploma?: QualBlock | null; bachelor?: QualBlock | null; master?: QualBlock | null };
  outcome?: string | null;
};

let casesCache: PastCase[] | null = null;
function loadCases(): PastCase[] {
  if (casesCache) return casesCache;
  const here = dirname(fileURLToPath(import.meta.url));
  const raw = JSON.parse(readFileSync(resolve(here, "../lib/verification_datasheet.json"), "utf8")) as {
    cases?: PastCase[];
  };
  casesCache = raw.cases ?? [];
  return casesCache;
}

const normalizeCode = (code: string) => code.replace(/\s+/g, "").replace(/PE$/i, "").trim();

function pastQualification(row: PastCase): ApplicantQualification {
  const q = row.qualifications;
  for (const b of [q?.bachelor, q?.master, q?.diploma]) {
    if (!b) continue;
    const degreeTitle = b.title?.trim() || null;
    const university = b.university?.trim() || b.college?.trim() || null;
    const country = b.country?.trim() || null;
    if (degreeTitle || university || country) return { degreeTitle, university, country };
  }
  return { degreeTitle: null, university: null, country: null };
}

/** 0–1 similarity between the applicant's qualification and a past case's. */
export function profileSimilarity(a: ApplicantQualification, b: ApplicantQualification): number {
  let s = 0;
  if (textFieldsMatch(a.degreeTitle, b.degreeTitle)) s += SIMILARITY_WEIGHTS.degree;
  if (universityFieldsMatch(a.university, b.university)) s += SIMILARITY_WEIGHTS.university;
  if (countryFieldsMatch(a.country, b.country)) s += SIMILARITY_WEIGHTS.country;
  return Math.round(s * 100) / 100;
}

/** Historical stats with the similarity-weighted score added. */
export function withSimilarCases(
  stats: HistoricalStats,
  anzscoCode: string,
  applicant: ApplicantQualification,
  cases: readonly PastCase[] = loadCases(),
): HistoricalStats {
  if (stats.totalCases <= 0) return stats;
  const code = normalizeCode(anzscoCode);
  let weight = 0;
  let weightedPositive = 0;
  let count = 0;
  let positive = 0;
  let negative = 0;
  for (const row of cases) {
    const past = row.occupation?.anzscoCode;
    if (!past || normalizeCode(past) !== code) continue;
    const sim = profileSimilarity(applicant, pastQualification(row));
    if (sim < SIMILARITY_THRESHOLD) continue;
    const outcome = (row.outcome ?? "").trim().toLowerCase();
    const isPositive = outcome === "positive";
    count += 1;
    if (isPositive) positive += 1;
    else if (outcome === "negative") negative += 1;
    weight += sim;
    if (isPositive) weightedPositive += sim;
  }
  const weightedPositivePct = weight > 0 ? Math.round((weightedPositive / weight) * 1000) / 10 : null;
  const scorePct =
    Math.round(((weightedPositive * 100 + SIMILARITY_PRIOR * stats.positivePct) / (weight + SIMILARITY_PRIOR)) * 10) /
    10;
  const similar: SimilarCasesSummary = {
    cases: count,
    positive,
    negative,
    weightedPositivePct,
    method: SIMILARITY_METHOD,
  };
  return { ...stats, scorePct, similar };
}
