import { z } from "zod";

export const qualificationTypeSchema = z.enum([
  "bachelor",
  "master",
  "unknown",
]);

export type QualificationType = z.infer<typeof qualificationTypeSchema>;

export const extractedSubjectSchema = z.object({
  name: z.string().min(1),
  code: z.string().nullable().optional().default(null),
  credits: z.string().nullable().optional().default(null),
  grade: z.string().nullable().optional().default(null),
  yearOrSemester: z.string().nullable().optional().default(null),
  qualification: qualificationTypeSchema.default("unknown"),
  sourceSnippet: z.string().nullable().optional().default(null),
  isRepeat: z.boolean().optional().default(false),
});

export type ExtractedSubjectRow = z.infer<typeof extractedSubjectSchema>;

export const subjectExtractSchema = z.object({
  subjects: z.array(extractedSubjectSchema),
});

export type SubjectExtract = z.infer<typeof subjectExtractSchema>;

export const llmMatchDecisionSchema = z.object({
  decisions: z.array(
    z.object({
      transcriptName: z.string(),
      matchedSubject: z.string().nullable(),
      match: z.enum(["yes", "partial", "no"]),
      confidence: z.number().min(0).max(1),
      reason: z.string(),
    }),
  ),
});

export type LlmMatchDecision = z.infer<typeof llmMatchDecisionSchema>;

export const workExperienceRelevanceSchema = z.object({
  related: z.boolean(),
  confidence: z.number().min(0).max(1),
  reason: z.string(),
});

export type WorkExperienceRelevance = z.infer<
  typeof workExperienceRelevanceSchema
>;

export type MatchMethod = "exact" | "fuzzy" | "llm" | "none";

export type SubjectMatch = {
  transcriptName: string;
  transcriptCode: string | null;
  qualification: QualificationType;
  rubricSubject: string | null;
  tier: "tier1" | "tier2" | "tier3" | null;
  category: string | null;
  method: MatchMethod;
  confidence: number;
  reason?: string;
};

export type TierOutcome =
  | "no_risk"
  | "low_risk"
  | "flag"
  | "medium_risk"
  | "high_risk";

export type Determination =
  | "verified_no_risk"
  | "conditional"
  | "not_verified"
  | "no_match";

export type ConfidenceLevel = "high" | "medium" | "low";

export type AssessmentResult = {
  anzscoCode: string | null;
  title: string | null;
  recommended: boolean;
  confidence: ConfidenceLevel | null;
  determination: Determination;
  foundationalMatched: number;
  foundationalExpected: number;
  foundationalPct: number;
  coreMatched: number;
  coreExpected: number;
  corePct: number;
  tier1Outcome: TierOutcome | null;
  tier2Outcome: TierOutcome | null;
  tier3GateMet: boolean;
  workExperienceBoost: boolean;
  qualificationsUsed: QualificationType[];
  matches: SubjectMatch[];
  unmatched: Array<{
    name: string;
    code: string | null;
    qualification: QualificationType;
  }>;
  /** Raw rows from transcript extraction (before rubric matching). */
  extractedSubjects: ExtractedSubjectRow[];
  explanation: string;
};
