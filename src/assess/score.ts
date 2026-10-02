import { assessConfig } from "./config.js";
import type { Rubric } from "./loadRubric.js";
import type {
  ConfidenceLevel,
  Determination,
  QualificationType,
  SubjectMatch,
  TierOutcome,
} from "./schemas.js";

export type ScoreInput = {
  matches: SubjectMatch[];
  /** Which qualification rows were included in this pass. */
  qualificationsUsed: QualificationType[];
  workExperienceBoost: boolean;
  rubric: Rubric;
};

export type ScoreResult = {
  foundationalMatched: number;
  foundationalExpected: number;
  foundationalPct: number;
  coreMatched: number;
  coreExpected: number;
  corePct: number;
  tier1Outcome: TierOutcome;
  tier2Outcome: TierOutcome;
  tier3GateMet: boolean;
  determination: Determination;
  recommended: boolean;
  confidence: ConfidenceLevel | null;
  anzscoCode: string | null;
  title: string | null;
};

function outcomeFromThresholds(
  matched: number,
  thresholds: Array<{ matchedRange: [number, number]; outcome: string }>,
): TierOutcome {
  for (const t of thresholds) {
    const [lo, hi] = t.matchedRange;
    if (matched >= lo && matched <= hi) return t.outcome as TierOutcome;
  }
  // Fallback: clamp to nearest
  if (matched <= 0) {
    return (thresholds[thresholds.length - 1]?.outcome ?? "high_risk") as TierOutcome;
  }
  return (thresholds[0]?.outcome ?? "no_risk") as TierOutcome;
}

function uniqueMatchedNames(
  matches: SubjectMatch[],
  tier: "tier1" | "tier2" | "tier3",
  categories: string[],
): Set<string> {
  const set = new Set<string>();
  for (const m of matches) {
    if (m.tier !== tier || !m.rubricSubject) continue;
    if (!categories.includes(m.category ?? "")) continue;
    // partial LLM matches still count (they indicate coverage)
    if (m.method === "none") continue;
    set.add(m.rubricSubject);
  }
  return set;
}

function combineDetermination(
  tier1: TierOutcome,
  tier2: TierOutcome,
  tier3GateMet: boolean,
  rubric: Rubric,
): Determination {
  if (!tier3GateMet) {
    return assessConfig.missingTier3Action === "conditional"
      ? "conditional"
      : "not_verified";
  }

  const table = rubric.riskScoring.overallDetermination.combinationTable;
  for (const row of table) {
    if (row.tier1Outcome.includes(tier1) && row.tier2Outcome.includes(tier2)) {
      return row.result as Determination;
    }
  }

  // Default for undocumented gap: Tier1 flag + Tier2 medium_risk
  if (tier1 === "flag" && tier2 === "medium_risk") {
    return assessConfig.flagPlusMediumRisk;
  }

  // Any other gap → conservative
  return "not_verified";
}

function mapConfidence(
  determination: Determination,
  boost: boolean,
): ConfidenceLevel | null {
  if (determination === "verified_no_risk") {
    return assessConfig.confidence.verified_no_risk;
  }
  if (determination === "conditional") {
    return boost
      ? assessConfig.confidence.conditionalWithBoost
      : assessConfig.confidence.conditional;
  }
  return null;
}

/**
 * Score matches using rubric thresholds. Optional subjects never reduce the score.
 * Suitability is NOT matched/total — only expected/core denominators.
 */
export function scoreAssessment(input: ScoreInput): ScoreResult {
  const { matches, rubric, workExperienceBoost } = input;

  const foundationalExpected = rubric.tiers.tier1.scoreDenominator;
  const coreExpected = rubric.tiers.tier2.scoreDenominator;

  const foundationalSet = uniqueMatchedNames(matches, "tier1", ["expected"]);
  const coreSet = uniqueMatchedNames(matches, "tier2", ["core"]);

  // Tier 3 gate: major project / thesis / capstone only (gateSubject)
  const gateName =
    rubric.tiers.tier3.gate?.gateSubject ??
    "Major Project / Thesis / Final-Year Project/ Capstone Project";
  const tier3GateMet = matches.some(
    (m) =>
      m.tier === "tier3" &&
      m.rubricSubject === gateName &&
      m.method !== "none",
  );

  const foundationalMatched = foundationalSet.size;
  const coreMatched = coreSet.size;

  const tier1Outcome = outcomeFromThresholds(
    foundationalMatched,
    rubric.riskScoring.tier1.thresholds,
  );
  const tier2Outcome = outcomeFromThresholds(
    coreMatched,
    rubric.riskScoring.tier2.thresholds,
  );

  const determination = combineDetermination(
    tier1Outcome,
    tier2Outcome,
    tier3GateMet,
    rubric,
  );

  // CV boost never rescues not_verified → verified; only affects confidence on conditional
  const recommended = (
    assessConfig.recommendOn as readonly string[]
  ).includes(determination);

  const confidence = recommended
    ? mapConfidence(determination, workExperienceBoost)
    : null;

  // Surface as no_match when not recommended
  const finalDetermination: Determination = recommended
    ? determination
    : "no_match";

  return {
    foundationalMatched,
    foundationalExpected,
    foundationalPct:
      foundationalExpected > 0
        ? Math.round((foundationalMatched / foundationalExpected) * 1000) / 10
        : 0,
    coreMatched,
    coreExpected,
    corePct:
      coreExpected > 0
        ? Math.round((coreMatched / coreExpected) * 1000) / 10
        : 0,
    tier1Outcome,
    tier2Outcome,
    tier3GateMet,
    determination: finalDetermination,
    recommended,
    confidence,
    anzscoCode: recommended ? rubric.anzscoCode : null,
    title: recommended ? rubric.title : null,
  };
}

/**
 * Decide whether bachelor-only core coverage is insufficient (need masters rows).
 */
export function needsMastersFallback(tier2Outcome: TierOutcome): boolean {
  return (
    tier2Outcome === "medium_risk" ||
    tier2Outcome === "high_risk"
  );
}
