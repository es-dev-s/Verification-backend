import { emptyPrecedentCheck } from "./precedent.js";
import {
  RISK_SCORING_CONFIG,
  type RiskBandThresholds,
  type RiskScoringConfig,
} from "./riskBands.config.js";
import type {
  ComponentSplit,
  HistoricalStats,
  PrecedentCheck,
  RiskAssessmentResult,
  RiskComponentKey,
  RiskComponentScore,
  RiskLevel,
  RiskScoringBreakdown,
} from "./schemas.js";
import type { VocationalAssessmentDetail } from "../assess/schemas.js";

/**
 * Step 5 risk: overall academic alignment score.
 *
 *   Overall = 0.30 × Fundamental + 0.50 × Core + 0.20 × Historical
 *
 * Academic occupations: Fundamental = Tier 1 (foundational) score, Core =
 * Tier 2 (core) score, each 70% Major + 30% Supporting (doc 05 §5–6, see
 * componentSplit.ts). Vocational unit-code occupations: Core =
 * core-unit coverage %, Fundamental = foundational-unit coverage %
 * (Step 3 foundationalPct; dropped when missing). Historical = positive
 * outcome % of past cases for the ANZSCO (verification_datasheet.json),
 * weighted by similarity to this applicant when known (similarCases.ts),
 * used whenever at least one past case exists; with none it is left out.
 *
 * A component without usable data is left out and the remaining weights are
 * re-normalised. The overall score maps to the risk category through the
 * thresholds in riskBands.config.ts (weights live there too).
 */

/** Historical component score: similarity-weighted when available, else the plain positive %. */
export function historicalScorePct(h: HistoricalStats): number {
  return h.scorePct ?? h.positivePct;
}

/** Approved weights (from the governance config). */
export const RISK_WEIGHTS = RISK_SCORING_CONFIG.weights;

/** Older saved results may carry these; kept so their types still resolve. */
export type StepThreeDetermination =
  | "verified_no_risk"
  | "conditional"
  | "not_verified"
  | "no_match";

export type RiskBandInput = {
  determination: StepThreeDetermination;
  tierOutcomes: Array<string | null | undefined>;
  capReasons?: string[];
};

/** Overall score → risk category using the governance thresholds. */
export function riskLevelFromScore(
  overallPct: number,
  bands: RiskBandThresholds = RISK_SCORING_CONFIG.bands,
): RiskLevel {
  if (overallPct >= bands.noRisk) return "no_risk";
  if (overallPct >= bands.low) return "low";
  if (overallPct >= bands.medium) return "medium";
  return "high";
}


const COMPONENT_LABELS: Record<"academic" | "vocational_units", Record<RiskComponentKey, string>> = {
  academic: {
    fundamental: "Fundamental subjects",
    core: "Core subjects",
    historical: "Historical outcomes",
  },
  vocational_units: {
    fundamental: "Foundational units",
    core: "Core units",
    historical: "Historical outcomes",
  },
};

function weightPct(w: number): string {
  return `${Math.round(w * 1000) / 10}%`;
}

/** Weighted overall score with re-normalisation for missing components. */
export function computeAlignmentScore(
  input: {
    /** Null when not applicable (e.g. vocational with no foundational score). */
    fundamentalPct: number | null;
    corePct: number;
    historical: HistoricalStats;
    assessmentFlow?: "academic" | "vocational_units";
  },
  config: RiskScoringConfig = RISK_SCORING_CONFIG,
): RiskScoringBreakdown {
  const flow = input.assessmentFlow ?? "academic";
  const labels = COMPONENT_LABELS[flow];
  const historicalUsable = input.historical.totalCases > 0;

  const raw: Array<{ key: RiskComponentKey; pct: number | null; reason?: string }> = [
    {
      key: "fundamental",
      pct: input.fundamentalPct == null ? null : clampPct(input.fundamentalPct),
      reason:
        input.fundamentalPct == null
          ? "No fundamental score"
          : undefined,
    },
    { key: "core", pct: clampPct(input.corePct) },
    {
      key: "historical",
      pct: input.historical.totalCases > 0 ? clampPct(historicalScorePct(input.historical)) : null,
      reason: historicalUsable ? undefined : "No past cases for this ANZSCO",
    },
  ];

  const used = (c: (typeof raw)[number]) =>
    c.pct != null && (c.key !== "historical" || historicalUsable);
  const usedWeight = raw.reduce((sum, c) => sum + (used(c) ? config.weights[c.key] : 0), 0);

  const components: RiskComponentScore[] = raw.map((c) => {
    const isUsed = used(c);
    return {
      key: c.key,
      label: labels[c.key],
      pct: c.pct,
      weight: config.weights[c.key],
      appliedWeight: isUsed && usedWeight > 0 ? Math.round((config.weights[c.key] / usedWeight) * 1000) / 1000 : 0,
      used: isUsed,
      ...(isUsed || !c.reason ? {} : { reason: c.reason }),
    };
  });

  const overallPct =
    usedWeight > 0
      ? clampPct(
          raw.reduce(
            (sum, c) => sum + (used(c) ? (c.pct as number) * config.weights[c.key] : 0),
            0,
          ) / usedWeight,
        )
      : 0;

  const renormalised = components.some((c) => !c.used);
  const notes: string[] = [];
  for (const c of components) {
    if (!c.used) notes.push(`${c.label} not used: ${c.reason ?? "no data"}.`);
  }
  if (renormalised) {
    notes.push(
      `Weights re-normalised: ${components
        .filter((c) => c.used)
        .map((c) => `${c.label} ${weightPct(c.appliedWeight)}`)
        .join(", ")}.`,
    );
  }

  return {
    configVersion: config.version,
    components,
    overallPct,
    riskLevel: riskLevelFromScore(overallPct, config.bands),
    bands: { ...config.bands },
    renormalised,
    notes,
  };
}

/** Notes produced by computeAlignmentScore (replaced when a result is re-scored). */
const SCORING_NOTE_RE = /\bnot used:|re-normalised|\bOnly \d+ past cases?\b/i;

/**
 * A saved risk result shown with the CURRENT governance settings: the overall
 * score, category, bands and component weights are recomputed from the saved
 * component scores whenever the result was scored with other settings (older
 * band-based results, results from before the minimum-cases rule was removed).
 * Read-only: nothing is saved. Fields of older results that no longer apply
 * (band basis, work-experience points) are dropped.
 */
export function withCurrentScoring(
  risk: RiskAssessmentResult,
  config: RiskScoringConfig = RISK_SCORING_CONFIG,
): RiskAssessmentResult {
  const {
    riskBasis: _riskBasis,
    baseRiskLevel: _baseRiskLevel,
    historicalModifierApplied: _historicalModifierApplied,
    stepThreeDetermination: _stepThreeDetermination,
    overallPctBeforeWork: _overallPctBeforeWork,
    workExperienceDelta: _workExperienceDelta,
    ...rest
  } = risk as RiskAssessmentResult & { overallPctBeforeWork?: unknown; workExperienceDelta?: unknown };
  if (risk.scoring && risk.scoring.configVersion === config.version) return rest;
  const flow = risk.assessmentFlow ?? "academic";
  const savedFundamental = risk.scoring?.components?.find((c) => c.key === "fundamental");
  const fundamentalPct = savedFundamental
    ? savedFundamental.pct
    : flow === "vocational_units"
      ? null
      : risk.fundamentalPct;
  const historical: HistoricalStats = risk.historical ?? {
    totalCases: 0,
    positive: 0,
    negative: 0,
    banned: 0,
    positivePct: 0,
  };
  const scoring = computeAlignmentScore(
    { fundamentalPct, corePct: risk.corePct ?? 0, historical, assessmentFlow: flow },
    config,
  );
  const otherNotes = (risk.riskNotes ?? []).filter((n) => !SCORING_NOTE_RE.test(n));
  return {
    ...rest,
    historical,
    overallPct: scoring.overallPct,
    riskLevel: scoring.riskLevel,
    scoring,
    riskNotes: [...scoring.notes, ...otherNotes],
  };
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
  /** Null when not applicable (e.g. vocational with no foundational score). */
  fundamentalPct: number | null;
  /** Driver wording for the fundamental component (default "foundational"). */
  fundamentalLabel?: string;
  corePct: number;
  historical: HistoricalStats;
  workExperienceBoost: boolean;
  missingCore: string[];
  /** Missing Supporting core subjects (rubric-marked); listed apart from Major gaps. */
  missingSupporting?: string[];
}): { reducingRisk: string[]; increasingRisk: string[] } {
  const reducingRisk: string[] = [];
  const increasingRisk: string[] = [];

  const fLabel = input.fundamentalLabel ?? "foundational";
  if (input.fundamentalPct == null) {
    // Not applicable: no driver.
  } else if (input.fundamentalPct >= 80) {
    reducingRisk.push(
      `Strong ${fLabel} coverage (${input.fundamentalPct}%).`,
    );
  } else if (input.fundamentalPct < 60) {
    increasingRisk.push(
      `Weak ${fLabel} coverage (${input.fundamentalPct}%).`,
    );
  }

  if (input.corePct >= 80) {
    reducingRisk.push(`Strong core subject coverage (${input.corePct}%).`);
  } else if (input.corePct < 60) {
    increasingRisk.push(`Weak core subject coverage (${input.corePct}%).`);
  }

  const similar = input.historical.similar;
  if (input.historical.totalCases > 0 && similar && similar.cases > 0) {
    const line = `${similar.cases} similar past case${similar.cases === 1 ? "" : "s"} (${similar.positive} positive, ${similar.negative} negative).`;
    if ((similar.weightedPositivePct ?? 0) >= 70) reducingRisk.push(`Similar past cases mostly positive: ${line}`);
    else if ((similar.weightedPositivePct ?? 100) < 50) increasingRisk.push(`Similar past cases weaker: ${line}`);
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
      "Related work experience in the field (context only; does not change the score).",
    );
  }

  if (input.missingCore.length) {
    increasingRisk.push(
      input.missingCore.length === 1
        ? `Gap in major core: ${input.missingCore[0]}.`
        : `Gaps in ${input.missingCore.length} major core subjects.`,
    );
  }
  const supp = input.missingSupporting ?? [];
  if (supp.length) {
    increasingRisk.push(
      supp.length === 1
        ? `Gap in supporting core: ${supp[0]} (30% weight).`
        : `Gaps in ${supp.length} supporting core subjects (30% weight).`,
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
  /** Null drops the fundamental component (weights re-normalised). */
  fundamentalPct: number | null;
  corePct: number;
  historical: HistoricalStats;
  precedent?: PrecedentCheck;
  workExperienceBoost: boolean;
  missingCore: string[];
  assessmentFlow?: "academic" | "vocational_units";
  /** Vocational unit-code detail (Step 3 electives; unused for the risk score). */
  vocational?: Pick<VocationalAssessmentDetail, "electiveStatus" | "electiveMinimum" | "electivesFound"> | null;
  /** 70/30 Major / Supporting split (academic); its pct replaces the plain coverage %. */
  splits?: { fundamental: ComponentSplit; core: ComponentSplit } | null;
  config?: RiskScoringConfig;
}): Omit<
  RiskAssessmentResult,
  "competence" | "competenceSource" | "insight"
> {
  const flow = input.assessmentFlow ?? "academic";
  const vocational = flow === "vocational_units";
  const splits = vocational ? null : input.splits ?? null;
  const fundamentalPct = vocational
    ? input.fundamentalPct == null
      ? null
      : clampPct(input.fundamentalPct)
    : clampPct(splits ? splits.fundamental.pct : (input.fundamentalPct ?? 0));
  const corePct = clampPct(splits ? splits.core.pct : input.corePct);
  const historicalPct = clampPct(historicalScorePct(input.historical));
  const rubricSplit = splits?.core.method === "rubric";
  const missingCore = rubricSplit ? splits!.core.missingMajor : input.missingCore;

  const scoring = computeAlignmentScore(
    { fundamentalPct, corePct, historical: input.historical, assessmentFlow: flow },
    input.config,
  );

  const riskNotes: string[] = [...scoring.notes];
  if (input.workExperienceBoost) {
    riskNotes.push("Related work experience noted (context only; it does not change the score).");
  }

  const { reducingRisk, increasingRisk } = buildRiskDrivers({
    fundamentalPct,
    fundamentalLabel: "foundational",
    corePct,
    historical: input.historical,
    workExperienceBoost: input.workExperienceBoost,
    missingCore,
    missingSupporting: rubricSplit ? splits!.core.missingSupporting : [],
  });

  return {
    anzscoCode: input.anzscoCode,
    title: input.title,
    fundamentalPct: fundamentalPct ?? 0,
    corePct,
    historicalPct,
    historical: input.historical,
    precedent: input.precedent ?? emptyPrecedentCheck(),
    workExperienceBoost: input.workExperienceBoost,
    overallPct: scoring.overallPct,
    riskLevel: scoring.riskLevel,
    scoring,
    riskNotes,
    assessmentFlow: flow,
    reducingRisk,
    increasingRisk,
    missingMajorDomains: buildMissingMajorDomainsSentence(missingCore),
    ...(splits ? { componentSplits: splits } : {}),
  };
}
