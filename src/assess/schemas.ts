import { z } from "zod";

export const qualificationTypeSchema = z.enum([
  "bachelor",
  "master",
  "diploma",
  "advanced_diploma",
  "associate_degree",
  "unknown",
]);

export type QualificationType = z.infer<typeof qualificationTypeSchema>;

/** Sub-bachelor levels, scored as their own transcript group. */
export const DIPLOMA_LEVELS: readonly QualificationType[] = [
  "diploma",
  "advanced_diploma",
  "associate_degree",
];

export function isDiplomaLevel(q: string | null | undefined): boolean {
  return (DIPLOMA_LEVELS as readonly string[]).includes(q ?? "");
}

export const extractedSubjectSchema = z.object({
  name: z.string().min(1),
  code: z.string().nullable().optional().default(null),
  credits: z.string().nullable().optional().default(null),
  grade: z.string().nullable().optional().default(null),
  yearOrSemester: z.string().nullable().optional().default(null),
  qualification: qualificationTypeSchema.default("unknown"),
  sourceSnippet: z.string().nullable().optional().default(null),
  isRepeat: z.boolean().optional().default(false),
  /** Transcript Document id this row was extracted from (null when unknown). */
  documentId: z.string().nullable().optional(),
  /** Sortable term parsed from yearOrSemester (Year 3 Sem 2 → 6); in memory only. */
  termIndex: z.number().nullable().optional(),
  /** Unit of termIndex ("semester", "trimester", "quarter", "year", "calendar"). */
  termUnit: z.string().nullable().optional(),
});

export type ExtractedSubjectRow = z.infer<typeof extractedSubjectSchema>;

/** LLM response for subject extraction — names (+ unit code when printed). */
export const subjectExtractLlmItemSchema = z.object({
  name: z.string().min(1),
  /** Unit / course code printed next to the name (vocational transcripts). */
  code: z.string().nullable().optional(),
  /** Credit points / hours printed for the subject (null when not printed). */
  credits: z.union([z.number(), z.string()]).nullable().optional(),
  /** Year / semester heading the subject sits under, as printed (null when not printed). */
  yearOrSemester: z.union([z.string(), z.number()]).nullable().optional(),
});

export const subjectExtractLlmSchema = z.object({
  subjects: z.array(subjectExtractLlmItemSchema),
});

export type SubjectExtractLlm = z.infer<typeof subjectExtractLlmSchema>;

export const subjectExtractSchema = z.object({
  subjects: z.array(extractedSubjectSchema),
});

export type SubjectExtract = z.infer<typeof subjectExtractSchema>;

/**
 * Training-package unit code (e.g. UEECD0007, BSBSMB402, and older 7-letter
 * codes such as UEENEEE101A that training.gov.au lists as superseded):
 * 3-letter package + 2–4 letter field + 3–4 digits + optional release letter.
 */
export const UNIT_CODE_RE = /\b[A-Z]{3}[A-Z]{2,4}\d{3,4}[A-Z]?\b/;

/** Uppercase, no spaces or dashes ("uee-cd 0007" → "UEECD0007"). */
export function normalizeUnitCode(code: string | null | undefined): string | null {
  if (!code) return null;
  const c = code.toUpperCase().replace(/[\s\-–_.]+/g, "");
  return c || null;
}

/**
 * Split a leading / trailing unit code off a subject name
 * ("UEECD0007 Apply WHS…" → code UEECD0007, name "Apply WHS…").
 * Names without a unit code are returned unchanged.
 */
export function splitUnitCode(name: string): { name: string; code: string | null } {
  const trimmed = name.trim();
  const lead = trimmed.match(
    /^\(?([A-Z]{3}[A-Z]{2,4}\d{3,4}[A-Z]?)\)?\s*[-–:|]?\s*(.+)$/,
  );
  if (lead && lead[2] && /[a-z]/i.test(lead[2])) return { code: lead[1]!, name: lead[2].trim() };
  const tail = trimmed.match(/^(.+?)\s*[-–:|]?\s*\(?([A-Z]{3}[A-Z]{2,4}\d{3,4}[A-Z]?)\)?$/);
  if (tail && tail[1] && /[a-z]/i.test(tail[1])) return { code: tail[2]!, name: tail[1].trim() };
  return { name: trimmed, code: null };
}

/** Credits as stored (DB column is a string): "3", "7.5"; null when not a number. */
export function normalizeCredits(credits: number | string | null | undefined): string | null {
  if (credits == null) return null;
  const n = typeof credits === "number" ? credits : Number(String(credits).trim().match(/^\d+(?:\.\d+)?/)?.[0]);
  return Number.isFinite(n) && n > 0 ? String(n) : null;
}

/** Year / semester label as printed (trimmed); null when empty. */
export function normalizeYearOrSemester(v: string | number | null | undefined): string | null {
  if (v == null) return null;
  const s = String(v).replace(/\s+/g, " ").trim();
  return s && !/^(null|n\/?a|none|-)$/i.test(s) ? s.slice(0, 60) : null;
}

/** Normalize LLM rows (name + optional code / credits / term) into full extracted subject rows. */
export function subjectNameToExtractedRow(
  name: string,
  code?: string | null,
  extra?: { credits?: number | string | null; yearOrSemester?: string | number | null },
): ExtractedSubjectRow {
  const split = splitUnitCode(name);
  const given = normalizeUnitCode(code);
  const unitCode = given && UNIT_CODE_RE.test(given) ? given : split.code;
  return extractedSubjectSchema.parse({
    name: unitCode ? split.name : name.trim(),
    code: unitCode ?? (given || null),
    credits: normalizeCredits(extra?.credits),
    grade: null,
    yearOrSemester: normalizeYearOrSemester(extra?.yearOrSemester),
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
  kind: "bachelor" | "master" | "master_fallback" | "mixed" | "diploma" | "unknown";
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

/** How the case's qualifications were routed (Step 1). */
export type QualificationRouteName =
  | "vocational"
  | "draftsperson_academic"
  | "professional"
  | "unknown";

export type RoutingInfo = {
  routes: QualificationRouteName[];
  /** Route label, e.g. "professional engineer". */
  label: string;
  /** Qualification title(s) the route is based on. */
  basedOn: string;
  /** One-line Step 3 note: "Scored as: <route> — based on <title>". */
  note: string;
  /** Extra assessor notes (ignored qualifications, occupations not scored automatically). */
  notes: string[];
  qualifications: Array<{
    title: string | null;
    level: QualificationType | "unknown";
    route: QualificationRouteName;
    reason: string;
  }>;
};

/** How a vocational core unit was matched (in the order tried). */
export type UnitMatchType = "exact" | "release" | "equivalent" | "typo" | "title";

export type VocationalUnitMatch = {
  unitId: string;
  /** Rubric unit code. */
  code: string;
  title: string;
  /** Code as written on the transcript (null for a title-only match). */
  transcriptCode: string | null;
  transcriptName: string;
  matchType: UnitMatchType;
  /** Plain note, e.g. "matched via superseded code UEENEEE101A". */
  note: string;
  confidence: number;
  /** training.gov.au page backing an equivalent-code match. */
  source?: string;
};

export type VocationalAssessmentDetail = {
  occupationId: string;
  /** Accepted qualification code(s), e.g. ["UEE62122"]. */
  qualificationCodes: string[];
  coreMatched: number;
  coreTotal: number;
  /** Core band: No Risk / Low / Medium / High. */
  coreBand: TierOutcome;
  /** Band thresholds used (minimum matched units). */
  thresholds: { noRisk: number; lowRisk: number; mediumRisk: number };
  matchedCore: VocationalUnitMatch[];
  missingCore: Array<{ unitId: string; code: string; title: string }>;
  electivesFound: Array<{ code: string; name: string }>;
  electiveStatus: "not_assessed" | "met" | "not_met";
  electiveMinimum: number | null;
  electiveNote: string;
  qualificationMet: boolean;
  qualificationNote: string;
  /** Review flags (typo codes, title-only matches, non-equivalent successors …). */
  flags: string[];
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
  /** Assessor notes from the qualification check (Step 1); empty when none. */
  qualificationNotes?: string[];
  /** True when the qualification check capped this occupation at conditional. */
  qualificationCapped?: boolean;
  /** "academic" (subject tiers) or "vocational_units" (unit codes). */
  assessmentFlow?: "academic" | "vocational_units";
  /** Tier 1 band (academic only; null for vocational). */
  tier1Outcome?: TierOutcome | null;
  /** Tier 2 band (academic) or core-unit band (vocational). */
  tier2Outcome?: TierOutcome | null;
  /** Step 3 result before not-recommended is surfaced as no_match. */
  bandDetermination?: Determination;
  /** True when a missing Tier 3 gate turned verified into conditional. */
  gateDowngraded?: boolean;
  /** True when the qualification route (Step 1) capped this occupation. */
  routeCapped?: boolean;
  /** Unit-code detail (vocational occupations only). */
  vocational?: VocationalAssessmentDetail | null;
  /** Gate project / thesis title used (final year preferred); null when none. */
  finalProjectTitle?: string | null;
  /** Gate 1 track this occupation was scored under. */
  track?: Gate1TrackId;
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
  /** Qualification-check notes for the top occupation (see candidates[].qualificationNotes). */
  qualificationNotes?: string[];
  /** Legacy Step 1 routing (results saved before Gate 1; no longer written). */
  routing?: RoutingInfo;
  /** Gate 1 qualification eligibility (decides which tracks were scored). */
  gate1?: Gate1Decision;
  /** Flow of the top occupation. */
  assessmentFlow?: "academic" | "vocational_units";
  /** Step 3 result of the top occupation before no_match surfacing. */
  bandDetermination?: Determination;
  explanation: string;
  /** Subject-extraction bookkeeping used for caching (see assessCase). */
  extraction?: ExtractionReport;
  /** Duration (Gate 1), engineering decision and final-year project (Step 3 box). */
  qualificationEvidence?: QualificationEvidence;
  /** Gate project / thesis title of the top occupation (null when none). */
  finalProjectTitle?: string | null;
};

/** Unit a printed year / semester was read in. */
export type TermUnit = "semester" | "trimester" | "quarter" | "year" | "calendar";

export type DurationStatus = "ok" | "below_minimum" | "mismatch" | "not_counted";

/** Gate 1 duration check for one qualification. */
export type DurationEvidence = {
  level: QualificationType;
  title: string | null;
  /** Qualification.durationYears as entered (null when not stated). */
  statedYears: number | null;
  /** Counted from the printed years / semesters (null when not countable). */
  countedYears: number | null;
  minimumYears: number | null;
  /** Sum of printed credits (reference only). */
  creditTotal: number | null;
  /** Plain description of how the count was made. */
  method: string;
  unit: TermUnit | null;
  confidence: ConfidenceLevel;
  status: DurationStatus;
  /** True when this check capped the occupation at conditional. */
  capped: boolean;
  note: string;
};

export type EngineeringDecision = {
  decision: "yes" | "no" | "unclear";
  reason: string;
  /** What the qualification title says. */
  titleSignal: "engineering" | "related" | "other" | "none";
  /** Share of subjects that read as engineering (0–1; null when no subjects). */
  subjectShare: number | null;
  subjectsConsidered: number;
  /** True when "no" capped professional / technologist occupations. */
  capped: boolean;
  note: string | null;
};

export type FinalProjectEvidence = {
  title: string | null;
  /** Term label of the project row, e.g. "semester 8" (null when not printed). */
  term: string | null;
  /** null when no term info. */
  inFinalYear: boolean | null;
  note: string | null;
};

export type QualificationEvidence = {
  duration: DurationEvidence[];
  engineering: EngineeringDecision;
  finalProject: FinalProjectEvidence | null;
};

/** Gate 1 (qualification eligibility, checked before any scoring). */
export type Gate1Result = "open" | "manual_review" | "not_eligible";

/** Occupation tracks (categories in src/lib/anzsco_skill_levels.json). */
export type Gate1TrackId = "professional_engineer" | "engineering_technologist" | "engineering_associate";

export type Gate1Track = {
  track: Gate1TrackId;
  label: string;
  open: boolean;
  /** 1 = assess first; null when closed. */
  priority: number | null;
  /** Plain reason (why open / why closed). */
  reason: string;
  /** ANZSCO codes in this track. */
  anzscoCodes: string[];
  /** Occupations in this track that cannot be scored automatically (assess manually). */
  notes: string[];
};

/** Award level read from the DB level, the title and any training-package code. */
export type Gate1AwardLevel =
  | "certificate"
  | "diploma"
  | "advanced_diploma"
  | "associate_degree"
  | "bachelor"
  | "honours"
  | "graduate_diploma"
  | "master"
  | "doctorate"
  | "unknown";

export type Gate1Qualification = {
  title: string | null;
  level: QualificationType | "unknown";
  award: Gate1AwardLevel;
  aqfLevel: number | null;
  engineering: "yes" | "no" | "unclear";
  engineeringReason: string;
  /** Qualification.durationYears as entered (null when not stated). */
  statedYears: number | null;
  /** Counted from printed years / semesters (null when not reliably countable). */
  countedYears: number | null;
  /** Duration Gate 1 used (counted, else stated). */
  durationYears: number | null;
  durationSource: "counted" | "stated" | "none";
  /** How the count was made (or why it could not be). */
  durationMethod: string;
  /** Unusual-case flags (combined degree, part-time, credit transfer …). */
  flags: string[];
  /** True for the qualification that decided the gate. */
  used: boolean;
  /** Short outcome for this qualification. */
  outcome: string;
};

export type Gate1Decision = {
  result: Gate1Result;
  /** Spec rule that matched (1 not eligible, 2 manual review, 3 PE + Technologist, 4 Technologist, 5 Associate). */
  rule: 1 | 2 | 3 | 4 | 5;
  ruleLabel: string;
  /** Plain reason shown to the assessor. */
  reason: string;
  /** Title (or level) of the qualification that decided the gate; null when none. */
  qualificationUsed: string | null;
  tracks: Gate1Track[];
  qualifications: Gate1Qualification[];
  /** True when the duration used was the stated one (transcript had no years / semesters). */
  durationFallback: boolean;
  fallbackNote: string | null;
  /** Engineering decision for the qualification that decided the gate (null when none). */
  engineering: EngineeringDecision | null;
  notes: string[];
};

/** Which transcripts the saved subjects came from (subject-level cache key, see assessCase). */
export type ExtractionReport = {
  /** Hash of transcript ids/texts/degree levels the subjects were extracted from. */
  subjectHash: string;
  /** "llm" = freshly extracted, "persisted" = reused saved subjects, "injected" = tests. */
  source: "llm" | "persisted" | "injected";
};
