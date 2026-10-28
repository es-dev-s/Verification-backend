import { emptyPrecedentCheck } from "./precedent.js";
import type {
  HistoricalStats,
  PrecedentCheck,
  RiskAssessmentResult,
  RiskLevel,
} from "./schemas.js";

/**
 * Step 4 risk (aligned to the Step 3 bands).
 *
 * The risk level comes from the Step 3 determination and tier bands:
 *   Verified + every tier No Risk   → No risk
 *   Verified + any tier Low Risk    → Low risk
 *   Conditional                     → Medium risk
 *   Not verified / no match         → High risk
 * Step 3 caps already live in the determination: a missing major-project gate
 * (Tier 3) and the Step 1 qualification / route caps turn Verified into
 * Conditional, so those cases are Medium here.
 *
 * Historical outcomes are a modifier only: with at least
 * HISTORICAL_MIN_CASES past cases for the ANZSCO and a positive rate below
 * HISTORICAL_POSITIVE_FLOOR %, the level moves one step worse (with a note).
 * Otherwise the history is context. Work experience is a note only.
 * Foundational / core % and the old weighted alignment are display-only.
 */

/** Old weighted formula — display-only (no longer decides the level). */
export const RISK_WEIGHTS = {
  fundamental: 0.3,
  core: 0.5,
  historical: 0.2,
} as const;

/** Historical modifier: minimum past cases for the ANZSCO. */
export const HISTORICAL_MIN_CASES = 20;
/** Historical modifier: positive-outcome rate (%) below which risk worsens one level. */
export const HISTORICAL_POSITIVE_FLOOR = 40;

const LEVEL_ORDER: RiskLevel[] = ["no_risk", "low", "medium", "high"];

export type StepThreeDetermination =
  | "verified_no_risk"
  | "conditional"
  | "not_verified"
  | "no_match";

export type RiskBandInput = {
  /** Step 3 determination before surfacing (bandDetermination), else determination. */
  determination: StepThreeDetermination;
  /** Tier band outcomes (null / undefined when a tier is not used). */
  tierOutcomes: Array<string | null | undefined>;
  /** Why Step 3 is conditional (gate / qualification / route caps), for the basis text. */
  capReasons?: string[];
};

const BAND_LABEL: Record<string, string> = {
  no_risk: "No Risk",
  low_risk: "Low Risk",
  medium_risk: "Medium Risk",
  high_risk: "High Risk",
  flag: "Flag",
};

/** Base Step 4 level from the Step 3 determination + bands, with a plain-language basis. */
export function baseRiskFromBands(input: RiskBandInput): { level: RiskLevel; basis: string } {
  const bands = input.tierOutcomes.filter((t): t is string => Boolean(t));
  const bandText = bands.length ? ` (${bands.map((b) => BAND_LABEL[b] ?? b).join(", ")})` : "";
  const caps = input.capReasons?.length ? ` — ${input.capReasons.join("; ")}` : "";
  switch (input.determination) {
    case "verified_no_risk": {
      const allNoRisk = bands.every((b) => b === "no_risk");
      return allNoRisk
        ? { level: "no_risk", basis: `Step 3: Verified – No Risk${bandText}` }
        : { level: "low", basis: `Step 3: Verified – Low Risk${bandText}` };
    }
    case "conditional":
      return { level: "medium", basis: `Step 3: Conditional${bandText}${caps}` };
    case "not_verified":
      return { level: "high", basis: `Step 3: Not verified${bandText}` };
    default:
      return { level: "high", basis: "Step 3: no occupation match" };
  }
}

/** One level worse (High stays High). */
export function worsenRiskLevel(level: RiskLevel): RiskLevel {
  const i = LEVEL_ORDER.indexOf(level);
  return LEVEL_ORDER[Math.min(LEVEL_ORDER.length - 1, i + 1)]!;
}

/** Does the historical modifier apply (≥ 20 cases and < 40 % positive)? */
export function historicalModifierApplies(h: HistoricalStats): boolean {
  return h.totalCases >= HISTORICAL_MIN_CASES && h.positivePct < HISTORICAL_POSITIVE_FLOOR;
}

/**
 * Legacy score → level bands (old formula). Kept for reference / old saved
 * results only; Step 4 no longer uses it to decide the level.
 */
export function riskLevelFromScore(overallPct: number): RiskLevel {
  if (overallPct >= 85) return "no_risk";
  if (overallPct >= 75) return "low";
  if (overallPct >= 50) return "medium";
  return "high";
}

export function riskLevelLabel(level: RiskLevel): string {
  switch (level) {
    case "no_risk":
      return "No risk";
    case "low":
      return "Low risk";
    case "medium":
      return "Medium risk";
    case "high":
      return "High risk";
  }
}

function clampPct(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n * 10) / 10));
}

export function buildMissingMajorDomainsSentence(
  missingCore: string[],
): string {
  const names = missingCore.map((s) => s.trim()).filter(Boolean);
  if (!names.length) {
    return "No major core domains are missing for this occupation.";
  }
  if (names.length === 1) {
    return `Missing major domain: ${names[0]}.`;
  }
  if (names.length === 2) {
    return `Missing major domains: ${names[0]} and ${names[1]}.`;
  }
  const head = names.slice(0, 3).join(", ");
  const more = names.length - 3;
  return more > 0
    ? `Missing major domains: ${head}, and ${more} more.`
    : `Missing major domains: ${head}.`;
}

export function buildRiskDrivers(input: {
  fundamentalPct: number;
  corePct: number;
  historical: HistoricalStats;
  workExperienceBoost: boolean;
  missingCore: string[];
}): { reducingRisk: string[]; increasingRisk: string[] } {
  const reducingRisk: string[] = [];
  const increasingRisk: string[] = [];

  if (input.fundamentalPct >= 80) {
    reducingRisk.push(
      `Strong foundational coverage (${input.fundamentalPct}%).`,
    );
  } else if (input.fundamentalPct < 60) {
    increasingRisk.push(
      `Weak foundational coverage (${input.fundamentalPct}%).`,
    );
  }

  if (input.corePct >= 80) {
    reducingRisk.push(`Strong core subject coverage (${input.corePct}%).`);
  } else if (input.corePct < 60) {
    increasingRisk.push(`Weak core subject coverage (${input.corePct}%).`);
  }

  if (input.historical.totalCases > 0) {
    if (input.historical.positivePct >= 70) {
      reducingRisk.push(
        `Historical outcomes mostly positive (${input.historical.positivePct}% of ${input.historical.totalCases} cases).`,
      );
    } else if (input.historical.positivePct < 50) {
      increasingRisk.push(
        `Historical outcomes weaker (${input.historical.positivePct}% positive of ${input.historical.totalCases} cases).`,
      );
    }
  } else {
    increasingRisk.push("No comparable historical cases for this ANZSCO.");
  }

  if (input.workExperienceBoost) {
    reducingRisk.push(
      "Related work experience in the field (context only; does not change the risk level).",
    );
  }

  if (input.missingCore.length) {
    increasingRisk.push(
      input.missingCore.length === 1
        ? `Gap in major core: ${input.missingCore[0]}.`
        : `Gaps in ${input.missingCore.length} major core subjects.`,
    );
  }

  if (!reducingRisk.length) {
    reducingRisk.push("No strong risk-reducing factors identified.");
  }
  if (!increasingRisk.length) {
    increasingRisk.push("No material risk-increasing factors identified.");
  }

  return { reducingRisk, increasingRisk };
}

export function computeRiskScores(input: {
  anzscoCode: string;
  title: string;
  fundamentalPct: number;
  corePct: number;
  historical: HistoricalStats;
  precedent?: PrecedentCheck;
  workExperienceBoost: boolean;
  missingCore: string[];
  /** Step 3 determination + bands (decides the level). */
  bands: RiskBandInput;
  assessmentFlow?: "academic" | "vocational_units";
}): Omit<
  RiskAssessmentResult,
  "competence" | "competenceSource" | "insight"
> {
  const fundamentalPct = clampPct(input.fundamentalPct);
  const corePct = clampPct(input.corePct);
  const historicalPct = clampPct(input.historical.positivePct);

  // Display-only: the old weighted alignment (no work-experience points).
  const overallPct = clampPct(
    fundamentalPct * RISK_WEIGHTS.fundamental +
      corePct * RISK_WEIGHTS.core +
      historicalPct * RISK_WEIGHTS.historical,
  );

  const base = baseRiskFromBands(input.bands);
  const riskNotes: string[] = [];
  const historicalModifierApplied = historicalModifierApplies(input.historical);
  let riskLevel = base.level;
  if (historicalModifierApplied) {
    const worse = worsenRiskLevel(base.level);
    riskNotes.push(
      worse === base.level
        ? `Historical outcomes for ${input.anzscoCode} are weak (${input.historical.positivePct}% positive of ${input.historical.totalCases} cases); already High risk.`
        : `Moved one level worse (${riskLevelLabel(base.level)} → ${riskLevelLabel(worse)}): historical outcomes for ${input.anzscoCode} are ${input.historical.positivePct}% positive across ${input.historical.totalCases} cases (below ${HISTORICAL_POSITIVE_FLOOR}% with at least ${HISTORICAL_MIN_CASES} cases).`,
    );
    riskLevel = worse;
  } else if (input.historical.totalCases > 0) {
    riskNotes.push(
      `Historical outcomes (context only): ${input.historical.positivePct}% positive across ${input.historical.totalCases} cases.`,
    );
  }
  if (input.workExperienceBoost) {
    riskNotes.push("Related work experience noted (context only; it does not change the risk level).");
  }

  const { reducingRisk, increasingRisk } = buildRiskDrivers({
    fundamentalPct,
    corePct,
    historical: input.historical,
    workExperienceBoost: input.workExperienceBoost,
    missingCore: input.missingCore,
  });

  return {
    anzscoCode: input.anzscoCode,
    title: input.title,
    fundamentalPct,
    corePct,
    historicalPct,
    historical: input.historical,
    precedent: input.precedent ?? emptyPrecedentCheck(),
    overallPctBeforeWork: overallPct,
    workExperienceBoost: input.workExperienceBoost,
    workExperienceDelta: 0,
    overallPct,
    riskLevel,
    baseRiskLevel: base.level,
    riskBasis: base.basis,
    stepThreeDetermination: input.bands.determination,
    historicalModifierApplied,
    riskNotes,
    assessmentFlow: input.assessmentFlow ?? "academic",
    reducingRisk,
    increasingRisk,
    missingMajorDomains: buildMissingMajorDomainsSentence(input.missingCore),
  };
}
