import type {
  HistoricalStats,
  RiskAssessmentResult,
  RiskLevel,
} from "./schemas.js";

/** Weights from Academic_Risk_Scoring_Proposed_Update_Report.md */
export const RISK_WEIGHTS = {
  fundamental: 0.3,
  core: 0.5,
  historical: 0.2,
} as const;

/** Related work experience reduces risk (alignment boost), capped. */
export const WORK_EXPERIENCE_DELTA = 5;

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
      `Related work experience in the field (−${WORK_EXPERIENCE_DELTA} pts risk).`,
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
  workExperienceBoost: boolean;
  missingCore: string[];
}): Omit<
  RiskAssessmentResult,
  "competence" | "competenceSource" | "insight"
> {
  const fundamentalPct = clampPct(input.fundamentalPct);
  const corePct = clampPct(input.corePct);
  const historicalPct = clampPct(input.historical.positivePct);

  const overallPctBeforeWork = clampPct(
    fundamentalPct * RISK_WEIGHTS.fundamental +
      corePct * RISK_WEIGHTS.core +
      historicalPct * RISK_WEIGHTS.historical,
  );

  const workExperienceDelta = input.workExperienceBoost
    ? WORK_EXPERIENCE_DELTA
    : 0;
  const overallPct = clampPct(overallPctBeforeWork + workExperienceDelta);
  const riskLevel = riskLevelFromScore(overallPct);
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
    overallPctBeforeWork,
    workExperienceBoost: input.workExperienceBoost,
    workExperienceDelta,
    overallPct,
    riskLevel,
    reducingRisk,
    increasingRisk,
    missingMajorDomains: buildMissingMajorDomainsSentence(input.missingCore),
  };
}
