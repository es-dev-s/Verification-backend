/**
 * ANZSCO family adjustment (user's family rules, Part B).
 *
 * Confidence here is each occupation's subject-matching percentage
 * (candidate.confidenceScore), not the risk score. All adjustments are in
 * percentage points. Order: primary -> overlap check -> family penalty ->
 * Engineering Technologist (Maybe Suitable) -> cap below primary.
 *
 * Pure module: no DB, no LLM. Families come from src/lib/anzsco_families.json.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AnzscoCandidate,
  AssessmentResult,
  FamilyAdjustedOccupation,
  FamilyAdjustment,
  MaybeSuitableEntry,
} from "./schemas.js";

export const ENGINEERING_TECHNOLOGIST_CODE = "233914";
/** Points removed from an alternative that shares no family with the primary. */
export const DIFFERENT_FAMILY_PENALTY = 20;
/** Engineering Technologist is added only when the primary is strictly above this. */
export const ET_THRESHOLD = 50;

type FamilyOccupation = {
  anzscoCode: string;
  occupation: string;
  skillLevel: 1 | 2;
  families: string[];
  crossListed: boolean;
};
type FamiliesFile = { occupations: FamilyOccupation[] };

let byCode: Map<string, FamilyOccupation> | null = null;

function familyIndex(): Map<string, FamilyOccupation> {
  if (byCode) return byCode;
  const here = dirname(fileURLToPath(import.meta.url));
  const path = resolve(here, "../lib/anzsco_families.json");
  const file = JSON.parse(readFileSync(path, "utf8")) as FamiliesFile;
  byCode = new Map(file.occupations.map((o) => [normalizeCode(o.anzscoCode), o]));
  return byCode;
}

/** "2333.11" / "233311 " -> "233311". */
export function normalizeCode(code: string | null | undefined): string {
  return String(code ?? "").replace(/\D+/g, "");
}

export function familyOf(code: string): FamilyOccupation | null {
  return familyIndex().get(normalizeCode(code)) ?? null;
}

/** One decimal place (e.g. 67.5). */
function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function clampPct(n: number): number {
  return Math.max(0, Math.min(100, n));
}

/** ET formula: primary − (10 − 0.1 × (primary − 50)). */
export function etFormulaConfidence(primary: number): number {
  return round1(primary - (10 - 0.1 * (primary - 50)));
}

export type FamilyInput = {
  anzscoCode: string;
  title: string;
  /** Subject-matching % (0–100). */
  confidence: number;
};

export type FamilyAdjustOptions = {
  /**
   * Engineering Technologist's own matching % when it was scored but is not
   * among the inputs (e.g. outside the top 3). Ignored when ET is an input.
   */
  etOwnConfidence?: number | null;
  /** Title for the ET card (defaults to the families file name). */
  etTitle?: string;
};

/**
 * Apply the family rules to a primary + its alternatives.
 * `primary` must not appear in `alternatives`.
 */
export function adjustByFamily(
  primary: FamilyInput,
  alternatives: FamilyInput[],
  opts: FamilyAdjustOptions = {},
): FamilyAdjustment {
  const notes: string[] = [];
  const primaryConfidence = round1(clampPct(primary.confidence));
  const primaryFam = familyOf(primary.anzscoCode);
  if (!primaryFam) {
    notes.push(
      `${primary.title} (${primary.anzscoCode}) is not in the family list; alternatives were left unchanged.`,
    );
  }
  const capAt = Math.max(0, primaryConfidence - 1);

  const primaryRow: FamilyAdjustedOccupation = {
    anzscoCode: primary.anzscoCode,
    title: primary.title,
    isPrimary: true,
    families: primaryFam?.families ?? [],
    skillLevel: primaryFam?.skillLevel ?? null,
    sharedFamilies: primaryFam?.families ?? [],
    originalConfidence: primaryConfidence,
    adjustedConfidence: primaryConfidence,
    changed: false,
    capped: false,
    reason: "Primary",
  };

  const isEt = (code: string) => normalizeCode(code) === ENGINEERING_TECHNOLOGIST_CODE;
  const etQualifies = etQualifiesForPrimary(primary.anzscoCode, primaryConfidence);

  const rows: FamilyAdjustedOccupation[] = [];
  let etInput: FamilyInput | null = null;

  for (const alt of alternatives) {
    if (etQualifies && isEt(alt.anzscoCode)) {
      // Shown once, as the Maybe Suitable card.
      etInput = alt;
      continue;
    }
    const original = round1(clampPct(alt.confidence));
    const fam = familyOf(alt.anzscoCode);
    let adjusted = original;
    let reason: string;
    let shared: string[] = [];
    if (!primaryFam) {
      reason = "Primary not in family list";
    } else if (!fam) {
      reason = "Not in family list";
      notes.push(`${alt.title} (${alt.anzscoCode}) is not in the family list; left unchanged.`);
    } else {
      shared = fam.families.filter((f) => primaryFam.families.includes(f));
      if (shared.length) {
        const overlap = fam.crossListed || primaryFam.crossListed;
        reason = `${overlap ? "Overlapping family" : "Same family"} (${shared.join(", ")})`;
      } else {
        adjusted = Math.max(0, original - DIFFERENT_FAMILY_PENALTY);
        reason = `Different family −${DIFFERENT_FAMILY_PENALTY} pp`;
      }
    }
    let capped = false;
    if (adjusted >= primaryConfidence) {
      adjusted = capAt;
      capped = true;
      reason = `${reason} · capped below primary`;
    }
    adjusted = round1(adjusted);
    rows.push({
      anzscoCode: alt.anzscoCode,
      title: alt.title,
      isPrimary: false,
      families: fam?.families ?? [],
      skillLevel: fam?.skillLevel ?? null,
      sharedFamilies: shared,
      originalConfidence: original,
      adjustedConfidence: adjusted,
      changed: adjusted !== original,
      capped,
      reason,
    });
  }

  rows.sort((a, b) => b.adjustedConfidence - a.adjustedConfidence);

  let maybeSuitable: MaybeSuitableEntry | null = null;
  if (etQualifies) {
    const etFam = familyOf(ENGINEERING_TECHNOLOGIST_CODE);
    const formula = etFormulaConfidence(primaryConfidence);
    const ownRaw = etInput ? etInput.confidence : opts.etOwnConfidence;
    const own = typeof ownRaw === "number" && Number.isFinite(ownRaw)
      ? round1(clampPct(ownRaw))
      : null;
    // ET shares every family, so its own score is never penalised.
    let adjusted = own != null ? Math.max(own, formula) : formula;
    let capped = false;
    if (adjusted >= primaryConfidence) {
      adjusted = capAt;
      capped = true;
    }
    maybeSuitable = {
      anzscoCode: ENGINEERING_TECHNOLOGIST_CODE,
      title: etInput?.title ?? opts.etTitle ?? etFam?.occupation ?? "Engineering Technologist",
      label: "Maybe Suitable",
      originalConfidence: own,
      formulaConfidence: formula,
      adjustedConfidence: round1(adjusted),
      source: own != null && own > formula ? "own_score" : "formula",
      capped,
      inCandidates: Boolean(etInput),
    };
  }

  return {
    primaryCode: primary.anzscoCode,
    primaryConfidence,
    primaryFamilies: primaryFam?.families ?? [],
    occupations: [primaryRow, ...rows],
    maybeSuitable,
    notes,
  };
}

/** ET is offered as Maybe Suitable: skill level 1 primary, confidence strictly above 50. */
export function etQualifiesForPrimary(primaryCode: string, primaryConfidence: number): boolean {
  if (normalizeCode(primaryCode) === ENGINEERING_TECHNOLOGIST_CODE) return false;
  return (
    familyOf(primaryCode)?.skillLevel === 1 &&
    round1(clampPct(primaryConfidence)) > ET_THRESHOLD
  );
}

/** Fields needed to rank / pick the primary. */
export type RankedCandidate = Pick<AnzscoCandidate, "anzscoCode" | "recommended" | "confidenceScore">;

/**
 * Matched slots missing from Step 4: it shows primary + (n − 1) alternatives,
 * and ET is extra when it moves to the Maybe Suitable card. Returns how many
 * matched occupations must be added (0 when ET stays a normal alternative).
 */
export function matchedSlotsMissing(
  top: RankedCandidate[],
  n: number,
  assessorCode?: string | null,
): number {
  const isEt = (c: RankedCandidate) =>
    normalizeCode(c.anzscoCode) === ENGINEERING_TECHNOLOGIST_CODE;
  if (!top.some(isEt)) return 0;
  const primary = pickPrimary(top, assessorCode);
  if (!primary || !etQualifiesForPrimary(primary.anzscoCode, candidateConfidence(primary))) {
    return 0;
  }
  return Math.max(0, n - top.filter((c) => !isEt(c)).length);
}

/**
 * Next-best occupations (from `ranked`, best first) that fill the slots ET
 * freed by moving to Maybe Suitable. Skips ET and anything already shown.
 * Returns fewer (or none) when the shortlist has no more scored occupations.
 */
export function matchedBackfill<T>(
  top: RankedCandidate[],
  ranked: T[],
  n: number,
  view: (t: T) => RankedCandidate,
  assessorCode?: string | null,
): T[] {
  let need = matchedSlotsMissing(top, n, assessorCode);
  if (need <= 0) return [];
  const seen = new Set(top.map((c) => normalizeCode(c.anzscoCode)));
  const out: T[] = [];
  for (const item of ranked) {
    if (need <= 0) break;
    const code = normalizeCode(view(item).anzscoCode);
    if (!code || code === ENGINEERING_TECHNOLOGIST_CODE || seen.has(code)) continue;
    seen.add(code);
    out.push(item);
    need--;
  }
  return out;
}

/** Matching % of a candidate (same value Step 4 displays). */
export function candidateConfidence(c: Pick<RankedCandidate, "confidenceScore">): number {
  return typeof c.confidenceScore === "number" && Number.isFinite(c.confidenceScore)
    ? c.confidenceScore
    : 0;
}

/**
 * Primary = the occupation Step 4 marks as recommended: the highest-confidence
 * recommended candidate, else the highest-confidence candidate. An
 * assessor-selected occupation (manual review) is always the primary.
 */
export function pickPrimary<T extends RankedCandidate>(
  candidates: T[],
  assessorCode?: string | null,
): T | null {
  if (!candidates.length) return null;
  if (assessorCode) {
    const pick = candidates.find(
      (c) => normalizeCode(c.anzscoCode) === normalizeCode(assessorCode),
    );
    if (pick) return pick;
  }
  const recommended = candidates.filter((c) => c.recommended);
  const pool = recommended.length ? recommended : candidates;
  return [...pool].sort((a, b) => candidateConfidence(b) - candidateConfidence(a))[0] ?? null;
}

/**
 * Family adjustment for an assessment result's candidates (top-N as shown in
 * Step 4). `etOwnConfidence`: ET's matching % when scored outside the top-N.
 */
export function familyAdjustmentForResult(
  result: Pick<AssessmentResult, "candidates" | "assessorSelected">,
  etOwnConfidence?: number | null,
): FamilyAdjustment | undefined {
  const candidates = result.candidates ?? [];
  const primary = pickPrimary(candidates, result.assessorSelected?.anzscoCode);
  if (!primary) return undefined;
  const toInput = (c: AnzscoCandidate): FamilyInput => ({
    anzscoCode: c.anzscoCode,
    title: c.title,
    confidence: candidateConfidence(c),
  });
  return adjustByFamily(
    toInput(primary),
    candidates.filter((c) => c !== primary).map(toInput),
    { etOwnConfidence },
  );
}
