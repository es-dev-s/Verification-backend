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

export function riskInsightSystemPrompt(): string {
  return `You are an assessor assistant for ANZSCO academic risk review.
Given computed scores only, return JSON:
{
  "competent": boolean,
  "insight": string
}

Rules:
- competent=true when overall alignment and subject coverage support the occupation; false when gaps are material.
- insight: 1–2 short sentences max. Cite the numbers. No bullet lists. No fluff.
- Do not invent subjects or change the scores.`;
}

export function riskInsightUserPrompt(
  scored: Omit<
    RiskAssessmentResult,
    "competence" | "competenceSource" | "insight"
  >,
): string {
  return `ANZSCO ${scored.anzscoCode} — ${scored.title}
Fundamental: ${scored.fundamentalPct}%
Core: ${scored.corePct}%
Historical positive: ${scored.historicalPct}% (${scored.historical.totalCases} cases)
Overall alignment: ${scored.overallPct}% → ${riskLevelLabel(scored.riskLevel)}
Work experience boost: ${scored.workExperienceBoost ? `yes (+${scored.workExperienceDelta})` : "no"}
Missing major domains: ${scored.missingMajorDomains}
Reducing risk: ${scored.reducingRisk.join(" ")}
Increasing risk: ${scored.increasingRisk.join(" ")}`;
}

/** Deterministic fallback when Groq is unavailable. */
export function buildRiskInsightFallback(
  scored: Omit<
    RiskAssessmentResult,
    "competence" | "competenceSource" | "insight"
  >,
): RiskLlmJudgement {
  const competent =
    scored.overallPct >= 75 &&
    scored.corePct >= 60 &&
    scored.fundamentalPct >= 50;
  const work = scored.workExperienceBoost
    ? ` Related work experience improved alignment by ${scored.workExperienceDelta} points.`
    : "";
  return {
    competent,
    insight: `Overall alignment is ${scored.overallPct}% (${riskLevelLabel(scored.riskLevel)}), driven by core ${scored.corePct}% and fundamentals ${scored.fundamentalPct}%.${work}`,
  };
}

export async function judgeRiskWithLlm(
  scored: Omit<
    RiskAssessmentResult,
    "competence" | "competenceSource" | "insight"
  >,
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
