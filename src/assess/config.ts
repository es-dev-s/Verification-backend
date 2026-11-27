/**
 * Configurable assessment defaults for ANZSCO matching gaps in the rubric JSON.
 * Override via env where noted.
 */
import "../config.js"; // ensure .env is loaded before reading process.env

function floatEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

function boolEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (raw == null || raw === "") return fallback;
  return raw === "1" || raw === "true" || raw === "yes";
}

export const assessConfig = {
  /** Soft deadline for a full case assessment (extract + match + score). */
  timeoutMs: intEnv("ASSESS_TIMEOUT_MS", 180_000),
  /** Soft hint for pack size (Groq path splits by key count instead). */
  chunkChars: intEnv("ASSESS_CHUNK_CHARS", 20_000),
  /** Legacy cap; subject extract now fans out 1 part per Groq key. */
  maxChunks: intEnv("ASSESS_MAX_CHUNKS", 3),
  /** Legacy; subject extract always runs all Groq key parts in parallel. */
  extractConcurrency: intEnv("ASSESS_EXTRACT_CONCURRENCY", 3),
  /** Per-attempt Groq timeout for subject extraction. */
  extractRequestTimeoutMs: intEnv("ASSESS_EXTRACT_REQUEST_MS", 60_000),
  /**
   * Longest transcript slice sent in one subject-extract request. Longer
   * transcripts are split further (also with a single Groq key) so no reply
   * is cut off by the token limit.
   */
  extractMaxChunkChars: intEnv("ASSESS_EXTRACT_MAX_CHUNK_CHARS", 14_000),
  /** Fuzzy match similarity threshold (0–1). */
  fuzzyThreshold: floatEnv("ASSESS_FUZZY_THRESHOLD", 0.82),
  /** Use LLM for leftover unclear subject matches (slow). Default off. */
  llmUnclearMatches: boolEnv("ASSESS_LLM_UNCLEAR", false),
  /** Use LLM to write explanation (slow). Default off — use template. */
  llmExplanation: boolEnv("ASSESS_LLM_EXPLAIN", false),
  /**
   * Use Groq to judge confirmed work rows against top ANZSCO candidates.
   * Default on — academic ranking still runs without work; boost is positive-only.
   */
  llmWorkExperience: boolEnv("ASSESS_LLM_EXPERIENCE", true),
  /**
   * Gap in dataFlow overallDetermination: Tier1=flag + Tier2=medium_risk.
   * Default: treat as conditional (manual review).
   */
  flagPlusMediumRisk: (process.env.ASSESS_FLAG_PLUS_MEDIUM ??
    "conditional") as "conditional" | "not_verified",
  /**
   * When Tier 3 gate (major project/thesis/capstone) is missing and the
   * occupation rubric does not set tier3GateDowngradeVerifiedOnly:
   * default forces not_verified even if Tier1/2 would verify.
   * Multi-ANZSCO academic rubrics downgrade verified → conditional instead.
   */
  missingTier3Action: (process.env.ASSESS_MISSING_TIER3 ??
    "not_verified") as "not_verified" | "conditional",
  /** Max occupation cards returned to the wizard (ranked). */
  maxCandidates: intEnv("ASSESS_MAX_CANDIDATES", 3),
  /**
   * How many academically-ranked occupations are sent to the work-experience
   * judge before the final cut to maxCandidates (so a related job can lift a
   * 4th–6th academic candidate into the shortlist).
   */
  boostShortlist: intEnv("ASSESS_BOOST_SHORTLIST", 6),
  /**
   * Coverage used inside confidenceScore (ranking), per tier:
   *
   *   coverage% = 100 × [ (1 − W) × matched/total + W × min(1, matched/REF) ]
   *
   * W blends the plain percentage with an absolute matched count so a rubric
   * with a tiny denominator (e.g. 2/5 core) cannot outrank one with many more
   * matched subjects (e.g. 6/10). REF is the matched count treated as "full"
   * absolute evidence. Displayed foundationalPct / corePct stay plain matched/total.
   * W = 0 restores the old behaviour.
   */
  coverage: {
    absWeight: floatEnv("ASSESS_COVERAGE_ABS_WEIGHT", 0.4),
    coreRef: floatEnv("ASSESS_COVERAGE_CORE_REF", 8),
    foundationRef: floatEnv("ASSESS_COVERAGE_FOUNDATION_REF", 5),
  },
  /**
   * Confidence mapping from determination + optional CV boost.
   * verified_no_risk → high
   * conditional → medium (boost → high if CV related to the occupation)
   * not_verified → no_match (do not recommend)
   */
  confidence: {
    verified_no_risk: "high" as const,
    conditional: "medium" as const,
    conditionalWithBoost: "high" as const,
  },
  /** Only recommend ANZSCO when determination is verified_no_risk or conditional. */
  recommendOn: ["verified_no_risk", "conditional"] as const,
  /**
   * Auto-recommend only when the highest ANZSCO confidence is at least this
   * (percentage). Override with ASSESS_MIN_CONFIDENCE.
   */
  minConfidence: floatEnv("ASSESS_MIN_CONFIDENCE", 50),
  /**
   * Academic Alignment Confidence (ET Plus spec §6): foundation / core /
   * historical weights, then a cap, then year multipliers and penalties.
   */
  academicAlignment: {
    foundationWeight: floatEnv("ASSESS_ALIGN_FOUNDATION_WEIGHT", 0.3),
    coreWeight: floatEnv("ASSESS_ALIGN_CORE_WEIGHT", 0.5),
    historicalWeight: floatEnv("ASSESS_ALIGN_HISTORICAL_WEIGHT", 0.2),
    scoreCap: floatEnv("ASSESS_ALIGN_SCORE_CAP", 96),
    /** Years strictly before this cut use the pre-2000 multiplier. */
    yearCutPre2000: intEnv("ASSESS_YEAR_CUT_PRE2000", 2000),
    /** Years from yearCutPre2000 through this cut use the 2000–2010 multiplier. */
    yearCutThrough2010: intEnv("ASSESS_YEAR_CUT_THROUGH_2010", 2010),
    yearMultiplierPre2000: floatEnv("ASSESS_YEAR_MULT_PRE2000", 0.5),
    yearMultiplier2000To2010: floatEnv("ASSESS_YEAR_MULT_2000_2010", 0.7),
  },
  /** Extra percentage points removed from unmatched PE occupations (spec §5). */
  fieldMatchPenaltyPp: floatEnv("ASSESS_FIELD_MATCH_PENALTY_PP", 15),
};
