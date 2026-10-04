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

/** LLM response for subject extraction — names only. */
export const subjectExtractLlmItemSchema = z.object({
  name: z.string().min(1),
});

export const subjectExtractLlmSchema = z.object({
  subjects: z.array(subjectExtractLlmItemSchema),
});

export type SubjectExtractLlm = z.infer<typeof subjectExtractLlmSchema>;

export const subjectExtractSchema = z.object({
  subjects: z.array(extractedSubjectSchema),
});

export type SubjectExtract = z.infer<typeof subjectExtractSchema>;

/** Normalize LLM name-only rows into full extracted subject rows. */
export function subjectNameToExtractedRow(name: string): ExtractedSubjectRow {
  return extractedSubjectSchema.parse({
    name: name.trim(),
    code: null,
    credits: null,
    grade: null,
    yearOrSemester: null,
    qualification: "unknown",
    sourceSnippet: null,
    isRepeat: false,
  });
}

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

/** Legacy single-occupation shape (kept for older callers/tests). */
export const workExperienceRelevanceSchema = z.object({
  related: z.boolean(),
  confidence: z.number().min(0).max(1),
  reason: z.string(),
});

export type WorkExperienceRelevance = z.infer<
  typeof workExperienceRelevanceSchema
>;

export const workExperienceMatchedJobSchema = z.object({
  title: z.string(),
  employer: z.string().nullable().optional().default(null),
});

/** Groq response: relevance of confirmed jobs to each top ANZSCO. */
export const workExperienceTop3AnalysisSchema = z.object({
  occupations: z.array(
    z.object({
      anzscoCode: z.string(),
      related: z.boolean(),
      matchedJobs: z.array(workExperienceMatchedJobSchema).default([]),
      /** 1–2 lines max on why this raises profile confidence. */
      analysis: z.string(),
    }),
  ),
});

export type WorkExperienceTop3Analysis = z.infer<
  typeof workExperienceTop3AnalysisSchema
>;

export type MatchedJob = {
  title: string;
  employer: string | null;
};

/** Per-candidate work-experience boost details for UI. */
export type WorkExperienceCandidateAnalysis = {
  related: boolean;
  matchedJobs: MatchedJob[];
  /** 1–2 line rationale from Groq (empty when not related). */
  analysis: string;
  /** Academic-only confidence before applying the boost. */
  confidenceScoreBefore: number;
  /** Confidence after applying the boost (same as before when not related). */
  confidenceScoreAfter: number;
};

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

export type MissingSubjectsByTier = {
  tier1: string[];
  tier2: string[];
};

export type TranscriptSourceInfo = {
  /** Which transcript pool drove matching. */
  kind: "bachelor" | "master" | "master_fallback" | "mixed" | "unknown";
  /** Human-readable label for the Step 3 UI. */
  label: string;
};

/** Canonical rubric subject with naming variants (for UI drill-down). */
export type RubricSubjectCatalogEntry = {
  name: string;
  tier: "tier1" | "tier2" | "tier3";
  category: string;
  variants: string[];
};

/** One occupation evaluated against the transcript (top-N candidates). */
export type AnzscoCandidate = {
  anzscoCode: string;
  title: string;
  foundationalMatched: number;
  foundationalExpected: number;
  foundationalPct: number;
  coreMatched: number;
  coreExpected: number;
  corePct: number;
  tier3GateMet: boolean;
  confidence: ConfidenceLevel | null;
  /** 0–100 numeric confidence for ranking and display. */
  confidenceScore: number;
  determination: Determination;
  recommended: boolean;
  /** True when Groq judged confirmed work relevant to this occupation. */
  workExperienceBoost?: boolean;
  /** Matched jobs + short analysis + before/after confidence %. */
  workExperienceAnalysis?: WorkExperienceCandidateAnalysis | null;
  matches: SubjectMatch[];
  missingSubjects: MissingSubjectsByTier;
  unmatched: Array<{
    name: string;
    code: string | null;
    qualification: QualificationType;
  }>;
  /** Tier 1 / Tier 2 subjects with naming variants for the breakdown popup. */
  subjectCatalog: RubricSubjectCatalogEntry[];
};

export type AssessmentResult = {
  anzscoCode: string | null;
  title: string | null;
  recommended: boolean;
  confidence: ConfidenceLevel | null;
  /** 0–100 numeric confidence (highest recommended occupation). */
  confidenceScore?: number;
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
  /** Canonical rubric subjects with no transcript match (by tier). */
  missingSubjects?: MissingSubjectsByTier;
  /** Which transcript drove the match (bachelor vs masters fallback). */
  transcriptSource?: TranscriptSourceInfo;
  /** True when bachelor core was weak and masters subjects were included. */
  mastersFallbackUsed?: boolean;
  /** Ranked occupation candidates (top-N across all academic ANZSCO rubrics). */
  candidates?: AnzscoCandidate[];
  /** Raw rows from transcript extraction (before rubric matching). */
  extractedSubjects: ExtractedSubjectRow[];
  explanation: string;
};
