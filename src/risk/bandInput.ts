import { loadRubric } from "../assess/loadRubric.js";
import { outcomeFromThresholds } from "../assess/score.js";
import type { AnzscoCandidate, AssessmentResult } from "../assess/schemas.js";
import type { RiskBandInput, StepThreeDetermination } from "./scoreRisk.js";

type CandidateLike = Partial<AnzscoCandidate> & { anzscoCode: string };

/**
 * Step 3 determination + tier bands for a candidate, as input to Step 4 risk.
 * Uses the fields saved by the current engine (bandDetermination, tier
 * outcomes, cap flags). Older saved results lack them: the determination is
 * used as saved ("no_match" there means "not recommended", i.e. Not verified
 * or no match → High either way) and the bands are re-derived from the matched
 * counts and the rubric thresholds.
 */
export function bandInputForCandidate(
  candidate: CandidateLike,
  assessment?: Partial<AssessmentResult>,
): RiskBandInput {
  const isWinner =
    assessment?.anzscoCode &&
    assessment.anzscoCode.replace(/\s+/g, "") ===
      candidate.anzscoCode.replace(/\s+/g, "");

  const determination = (candidate.bandDetermination ??
    candidate.determination ??
    (isWinner ? assessment?.determination : undefined) ??
    "no_match") as StepThreeDetermination;

  let tier1 = candidate.tier1Outcome;
  let tier2 = candidate.tier2Outcome;
  const vocational = candidate.assessmentFlow === "vocational_units";
  if (tier2 === undefined && isWinner) {
    tier1 = assessment?.tier1Outcome ?? null;
    tier2 = assessment?.tier2Outcome ?? null;
  }
  if (tier2 === undefined && !vocational) {
    try {
      const rubric = loadRubric(candidate.anzscoCode);
      tier1 = outcomeFromThresholds(
        candidate.foundationalMatched ?? 0,
        rubric.riskScoring.tier1.thresholds,
      );
      tier2 = outcomeFromThresholds(
        candidate.coreMatched ?? 0,
        rubric.riskScoring.tier2.thresholds,
      );
    } catch {
      tier1 = null;
      tier2 = null;
    }
  }

  const capReasons: string[] = [];
  if (determination === "conditional") {
    if (candidate.gateDowngraded || candidate.tier3GateMet === false) {
      capReasons.push("major project / capstone gate not found");
    }
    if (candidate.qualificationCapped) {
      capReasons.push("qualification capped at Step 1");
    }
    if (candidate.routeCapped) {
      capReasons.push("qualification route caps this occupation at Conditional");
    }
  }

  return {
    determination,
    // Vocational: the core-unit band decides (no foundational tier).
    tierOutcomes: vocational ? [tier2] : [tier1, tier2],
    capReasons,
  };
}
