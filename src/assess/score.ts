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
  /** 0–100 numeric confidence for ranking and UI display. */
  confidenceScore: number;
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
  const table = rubric.riskScoring.overallDetermination.combinationTable;
  let result: Determination | null = null;

  for (const row of table) {
    if (row.tier1Outcome.includes(tier1) && row.tier2Outcome.includes(tier2)) {
      result = row.result as Determination;
      break;
    }
  }

  if (!result) {
    // Default for undocumented gap: Tier1 flag + Tier2 medium_risk
    if (tier1 === "flag" && tier2 === "medium_risk") {
      result = assessConfig.flagPlusMediumRisk;
    } else {
      result = "not_verified";
    }
  }

  if (tier3GateMet) return result;

  // New multi-ANZSCO rubrics: missing gate only downgrades verified → conditional.
  const downgradeVerifiedOnly =
    rubric.riskScoring.overallDetermination.tier3GateDowngradeVerifiedOnly ===
    true;
  if (downgradeVerifiedOnly) {
    return result === "verified_no_risk" ? "conditional" : result;
  }

  // Legacy config fallback
  return assessConfig.missingTier3Action === "conditional"
    ? "conditional"
    : "not_verified";
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
 * Numeric 0–100 confidence from determination + coverage + gate + CV boost.
 * Always computed (including non-recommended) so candidates can be ranked.
 */
export function computeConfidenceScore(input: {
  rawDetermination: Determination;
  foundationalPct: number;
  corePct: number;
  tier3GateMet: boolean;
  workExperienceBoost: boolean;
}): number {
  const coverage = input.corePct * 0.65 + input.foundationalPct * 0.35;
  let score: number;

  switch (input.rawDetermination) {
    case "verified_no_risk":
      // Strong academic fit: roughly 78–96
      score = 78 + coverage * 0.18;
      break;
    case "conditional":
      // Borderline / manual review: roughly 52–74
      score = 52 + coverage * 0.22;
      break;
    case "not_verified":
    case "no_match":
    default:
      // Weak fit — still show a coverage-based score for ranking: 8–42
      score = 8 + coverage * 0.34;
      break;
  }

  if (input.workExperienceBoost) score += 4;
  if (input.tier3GateMet) score += 3;
  else if (
    input.rawDetermination === "verified_no_risk" ||
    input.rawDetermination === "conditional"
  ) {
    score -= 6;
  }

  return Math.max(0, Math.min(100, Math.round(score)));
}

function labelFromScore(score: number): ConfidenceLevel | null {
  if (score >= 78) return "high";
  if (score >= 52) return "medium";
  if (score >= 35) return "low";
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

  const foundationalPct =
    foundationalExpected > 0
      ? Math.round((foundationalMatched / foundationalExpected) * 1000) / 10
      : 0;
  const corePct =
    coreExpected > 0
      ? Math.round((coreMatched / coreExpected) * 1000) / 10
      : 0;

  const confidenceScore = computeConfidenceScore({
    rawDetermination: determination,
    foundationalPct,
    corePct,
    tier3GateMet,
    workExperienceBoost,
  });

  // Prefer determination-based label when recommended; otherwise derive from score
  const confidence = recommended
    ? mapConfidence(determination, workExperienceBoost)
    : labelFromScore(confidenceScore);

  // Surface as no_match when not recommended
  const finalDetermination: Determination = recommended
    ? determination
    : "no_match";

  return {
    foundationalMatched,
    foundationalExpected,
    foundationalPct,
    coreMatched,
    coreExpected,
    corePct,
    tier1Outcome,
    tier2Outcome,
    tier3GateMet,
    determination: finalDetermination,
    recommended,
    confidence: recommended ? confidence : null,
    confidenceScore,
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
