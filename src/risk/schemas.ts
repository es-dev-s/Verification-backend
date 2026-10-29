import { z } from "zod";

export const riskLevelSchema = z.enum([
  "no_risk",
  "low",
  "medium",
  "high",
]);

export type RiskLevel = z.infer<typeof riskLevelSchema>;

export const competenceSchema = z.enum(["competent", "not_competent"]);

export type Competence = z.infer<typeof competenceSchema>;

export const riskLlmSchema = z.object({
  competent: z.boolean(),
  insight: z.string(),
});

export type RiskLlmJudgement = z.infer<typeof riskLlmSchema>;

export type HistoricalStats = {
  totalCases: number;
  positive: number;
  negative: number;
  banned: number;
  positivePct: number;
};

/** Per-case precedent risk reused from datasheet `outcomePossibility`. */
export type PrecedentRiskLevel = "no_risk" | "slight_risk" | "high_risk";

export type PrecedentCaseRow = {
  id: string;
  occupation: string;
  degree: string | null;
  university: string | null;
  country: string | null;
  /** Historical risk from datasheet `outcomePossibility`. */
  matchRisk: PrecedentRiskLevel;
  /** Historical final result from datasheet `outcome`. */
  outcome: string | null;
  verifiedDate: string | null;
};

export type PrecedentCheck = {
  matchingCases: number;
  positiveOutcomeRate: number;
  /** Most common historical risk among matched past cases. */
  overallRisk: PrecedentRiskLevel | null;
  riskCounts: {
    no_risk: number;
    slight_risk: number;
    high_risk: number;
  };
  cases: PrecedentCaseRow[];
};

export type RiskComponentKey = "fundamental" | "core" | "historical";

/** One component of the overall academic alignment score. */
export type RiskComponentScore = {
  key: RiskComponentKey;
  /** Display label, e.g. "Fundamental subjects" / "Core units". */
  label: string;
  /** Component score (0–100); null when there is no data. */
  pct: number | null;
  /** Configured weight (0–1). */
  weight: number;
  /** Weight actually applied after re-normalisation (0 when not used). */
  appliedWeight: number;
  used: boolean;
  /** Why the component was left out. */
  reason?: string;
};

/** Weighted overall score and the governance settings used for it. */
export type RiskScoringBreakdown = {
  configVersion: string;
  components: RiskComponentScore[];
  overallPct: number;
  riskLevel: RiskLevel;
  bands: { noRisk: number; low: number; medium: number };
  historicalMinCases: number;
  renormalised: boolean;
  notes: string[];
};

export type RiskAssessmentResult = {
  anzscoCode: string;
  title: string;
  /** Component scores (0–100 alignment). */
  fundamentalPct: number;
  corePct: number;
  historicalPct: number;
  historical: HistoricalStats;
  /**
   * Past-cases precedent check (occupation / degree / university / country).
   * Separate from subject-weighted scoring.
   */
  precedent: PrecedentCheck;
  /** Same as overallPct (work experience no longer adds points; kept for old saved results). */
  overallPctBeforeWork: number;
  workExperienceBoost: boolean;
  /** Always 0 now: work experience is a note only (kept for old saved results). */
  workExperienceDelta: number;
  /** Overall academic alignment score (0–100). */
  overallPct: number;
  /** Risk category from the overall score and the governance thresholds. */
  riskLevel: RiskLevel;
  /** Components, weights and thresholds behind the score (absent on older saved results). */
  scoring?: RiskScoringBreakdown;
  /** Older saved results only (band-based rating, no longer produced). */
  baseRiskLevel?: RiskLevel;
  /** Older saved results only (band-based rating, no longer produced). */
  riskBasis?: string;
  stepThreeDetermination?: "verified_no_risk" | "conditional" | "not_verified" | "no_match";
  /** Older saved results only (band-based rating, no longer produced). */
  historicalModifierApplied?: boolean;
  /** Notes: components left out / re-normalised weights, work experience, competence conflict. */
  riskNotes?: string[];
  assessmentFlow?: "academic" | "vocational_units";
  /** True when the competence check disagrees with the risk category (category stands). */
  competenceConflict?: boolean;
  reducingRisk: string[];
  increasingRisk: string[];
  /** Single sentence on missing major core domains. */
  missingMajorDomains: string;
  competence: Competence;
  competenceSource: "ai" | "manual";
  insight: string;
};

export const riskPatchBodySchema = z.object({
  competence: competenceSchema,
});

export const riskPostBodySchema = z.object({
  anzscoCode: z.string().min(1),
  title: z.string().optional(),
});
