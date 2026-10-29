import {
  generateJsonGroq,
  groqIsConfigured,
  loadGroqKeys,
} from "../lib/groqClient.js";
import { assessConfig } from "../assess/config.js";
import {
  riskLlmSchema,
  type RiskAssessmentResult,
  type RiskLlmJudgement,
} from "./schemas.js";
import { riskLevelLabel } from "./scoreRisk.js";

type ScoredRisk = Omit<
  RiskAssessmentResult,
  "competence" | "competenceSource" | "insight"
>;

export function riskInsightSystemPrompt(): string {
  return `You are an assessor assistant for ANZSCO academic risk review.
The risk level is already decided from the weighted overall alignment score; do not change it.
Return JSON:
{
  "competent": boolean,
  "insight": string
}

Rules:
- competent=true when the overall score and subject coverage support the occupation (normally No risk or Low risk); false when gaps are material.
- insight: 1–2 short sentences max. Cite the overall score and the key numbers. No bullet lists. No fluff.
- Work experience is context only.
- Do not invent subjects or change the scores.`;
}

export function riskInsightUserPrompt(scored: ScoredRisk): string {
  const vocational = scored.assessmentFlow === "vocational_units";
  const coverage = scored.scoring
    ? scored.scoring.components
        .map((c) => `${c.label}: ${c.pct == null ? "n/a" : `${c.pct}%`}${c.used ? ` (weight ${Math.round(c.appliedWeight * 1000) / 10}%)` : " (not used)"}`)
        .join("\n")
    : vocational
      ? `Core units: ${scored.corePct}%`
      : `Fundamental: ${scored.fundamentalPct}%\nCore: ${scored.corePct}%`;
  return `ANZSCO ${scored.anzscoCode} — ${scored.title}
Risk level: ${riskLevelLabel(scored.riskLevel)}
Overall alignment score: ${scored.overallPct}%
${coverage}
Historical positive: ${scored.historicalPct}% (${scored.historical.totalCases} cases)
Notes: ${(scored.riskNotes ?? []).join(" ") || "none"}
Work experience: ${scored.workExperienceBoost ? "related (context only)" : "none noted"}
Missing major domains: ${scored.missingMajorDomains}
Reducing risk: ${scored.reducingRisk.join(" ")}
Increasing risk: ${scored.increasingRisk.join(" ")}`;
}

/** Deterministic fallback when Groq is unavailable: competent when the category is No risk / Low. */
export function buildRiskInsightFallback(scored: ScoredRisk): RiskLlmJudgement {
  const competent = scored.riskLevel === "no_risk" || scored.riskLevel === "low";
  const basis = ` Overall alignment ${scored.overallPct}%.`;
  const coverage =
    scored.assessmentFlow === "vocational_units"
      ? `core units ${scored.corePct}%`
      : `core ${scored.corePct}% and fundamentals ${scored.fundamentalPct}%`;
  return {
    competent,
    insight: `${riskLevelLabel(scored.riskLevel)}.${basis} Coverage: ${coverage}.`,
  };
}

export const COMPETENCE_CONFLICT_PREFIX = "Competence check";

/**
 * Attach the competence judgement. The score-based risk level always stands;
 * when the competence check disagrees with it (competent but Medium/High, or
 * not competent but No risk/Low), a note asks the assessor to review.
 */
export function withCompetence(
  scored: ScoredRisk,
  judgement: RiskLlmJudgement,
): RiskAssessmentResult {
  const bandSupports = scored.riskLevel === "no_risk" || scored.riskLevel === "low";
  const conflict = judgement.competent !== bandSupports;
  const notes = [...(scored.riskNotes ?? [])];
  if (conflict) {
    notes.push(
      `${COMPETENCE_CONFLICT_PREFIX} (${judgement.competent ? "competent" : "not competent"}) differs from the ${riskLevelLabel(scored.riskLevel)} level; the level stands — assessor to review.`,
    );
  }
  return {
    ...scored,
    riskNotes: notes,
    competenceConflict: conflict,
    competence: judgement.competent ? "competent" : "not_competent",
    competenceSource: "ai",
    insight: judgement.insight,
  };
}

export async function judgeRiskWithLlm(
  scored: ScoredRisk,
  opts?: { deadlineMs?: number },
): Promise<RiskLlmJudgement> {
  const fallback = buildRiskInsightFallback(scored);
  if (!groqIsConfigured()) return fallback;
  if (Date.now() >= (opts?.deadlineMs ?? Infinity)) return fallback;

  const apiKey = loadGroqKeys()[0];
  if (!apiKey) return fallback;

  const requestMs = Math.min(
    assessConfig.extractRequestTimeoutMs,
    Math.max(
      8_000,
      (opts?.deadlineMs ?? Date.now() + 45_000) - Date.now() - 1_000,
    ),
  );

  try {
    const { data } = await generateJsonGroq(
      riskInsightUserPrompt(scored),
      riskInsightSystemPrompt(),
      {
        apiKey,
        maxTokens: 512,
        requestTimeoutMs: requestMs,
        responseSchema: riskLlmSchema,
      },
    );
    const parsed = riskLlmSchema.parse(data);
    const insight = parsed.insight.replace(/\s+/g, " ").trim().slice(0, 320);
    return {
      competent: Boolean(parsed.competent),
      insight: insight || fallback.insight,
    };
  } catch (err) {
    console.error(
      "[risk] Groq insight failed:",
      err instanceof Error ? err.message : err,
    );
    return fallback;
  }
}
