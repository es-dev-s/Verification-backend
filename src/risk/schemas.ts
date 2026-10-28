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
  /** Display-only: old weighted alignment (no longer decides the level). */
  overallPctBeforeWork: number;
  workExperienceBoost: boolean;
  /** Always 0 now: work experience is a note only (kept for old saved results). */
  workExperienceDelta: number;
  /** Display-only: old weighted alignment (0–100). */
  overallPct: number;
  /** Final level: Step 3 base level, after the historical modifier. */
  riskLevel: RiskLevel;
  /** Level from the Step 3 determination + bands, before the historical modifier. */
  baseRiskLevel?: RiskLevel;
  /** Plain-language basis, e.g. "Step 3: Verified – Low Risk (No Risk, Low Risk)". */
  riskBasis?: string;
  stepThreeDetermination?: "verified_no_risk" | "conditional" | "not_verified" | "no_match";
  /** True when ≥ 20 cases and < 40 % positive moved the level one step worse. */
  historicalModifierApplied?: boolean;
  /** Notes: historical modifier / context, work experience, competence conflict. */
  riskNotes?: string[];
  assessmentFlow?: "academic" | "vocational_units";
  /** True when the competence check disagrees with the band (band stands). */
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
