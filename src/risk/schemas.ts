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
  /** Weighted overall before work-experience adjustment. */
  overallPctBeforeWork: number;
  workExperienceBoost: boolean;
  /** Points added when related work experience is present. */
  workExperienceDelta: number;
  /** Final alignment score used for risk banding (0–100). */
  overallPct: number;
  riskLevel: RiskLevel;
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
