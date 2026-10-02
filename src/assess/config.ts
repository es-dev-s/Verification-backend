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
  /** Fuzzy match similarity threshold (0–1). */
  fuzzyThreshold: floatEnv("ASSESS_FUZZY_THRESHOLD", 0.82),
  /** Use LLM for leftover unclear subject matches (slow). Default off. */
  llmUnclearMatches: boolEnv("ASSESS_LLM_UNCLEAR", false),
  /** Use LLM to write explanation (slow). Default off — use template. */
  llmExplanation: boolEnv("ASSESS_LLM_EXPLAIN", false),
  /** Use LLM for work-experience relevance (heuristic first). Default off. */
  llmWorkExperience: boolEnv("ASSESS_LLM_EXPERIENCE", false),
  /**
   * Gap in dataFlow overallDetermination: Tier1=flag + Tier2=medium_risk.
   * Default: treat as conditional (manual review).
   */
  flagPlusMediumRisk: (process.env.ASSESS_FLAG_PLUS_MEDIUM ??
    "conditional") as "conditional" | "not_verified",
  /**
   * When Tier 3 gate (major project/thesis/capstone) is missing:
   * default forces not_verified even if Tier1/2 would verify.
   */
  missingTier3Action: (process.env.ASSESS_MISSING_TIER3 ??
    "not_verified") as "not_verified" | "conditional",
  /**
   * Confidence mapping from determination + optional CV boost.
   * verified_no_risk → high
   * conditional → medium (boost → high if CV chemical-eng related)
   * not_verified → no_match (do not recommend)
   */
  confidence: {
    verified_no_risk: "high" as const,
    conditional: "medium" as const,
    conditionalWithBoost: "high" as const,
  },
  /** Only recommend ANZSCO when determination is verified_no_risk or conditional. */
  recommendOn: ["verified_no_risk", "conditional"] as const,
};
