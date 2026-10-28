import { generateJson } from "../lib/gemini.js";
import {
  explanationSystemPrompt,
  explanationUserPrompt,
} from "./prompts.js";
import { z } from "zod";
import type { AssessmentResult } from "./schemas.js";

const explanationSchema = z.object({
  explanation: z.string(),
});

/** Deterministic fallback explanation from computed numbers. */
export function buildExplanationFallback(result: AssessmentResult): string {
  const title =
    result.title ??
    result.candidates?.[0]?.title ??
    "occupation";
  if (result.assessmentFlow === "vocational_units") return vocationalExplanation(result, title);
  if (!result.recommended) {
    return (
      `No ANZSCO occupation match. ` +
      `Best coverage against ${title}: foundational ${result.foundationalMatched}/${result.foundationalExpected} (${result.foundationalPct}%), ` +
      `core ${result.coreMatched}/${result.coreExpected} (${result.corePct}%). ` +
      `Tier 1: ${result.tier1Outcome ?? "n/a"}; Tier 2: ${result.tier2Outcome ?? "n/a"}; ` +
      `major project/thesis gate: ${result.tier3GateMet ? "met" : "not met"}.`
    );
  }
  const analysis =
    result.candidates?.find((c) => c.anzscoCode === result.anzscoCode)
      ?.workExperienceAnalysis ?? null;
  const boost = result.workExperienceBoost
    ? analysis?.analysis
      ? ` ${analysis.analysis}`
      : ` Related ${title} work experience provided a positive confidence boost.`
    : "";
  return (
    `Recommended ANZSCO ${result.anzscoCode} (${title}) with ${result.confidence} confidence ` +
    `(${result.determination.replace(/_/g, " ")}). ` +
    `Foundational ${result.foundationalMatched}/${result.foundationalExpected} (${result.foundationalPct}%), ` +
    `core ${result.coreMatched}/${result.coreExpected} (${result.corePct}%). ` +
    `Major project/thesis gate ${result.tier3GateMet ? "met" : "not met"}.` +
    boost +
    qualificationSentence(result)
  );
}

const BAND_LABEL: Record<string, string> = {
  no_risk: "No Risk",
  low_risk: "Low Risk",
  medium_risk: "Medium Risk",
  high_risk: "High Risk",
};

/** Unit-code occupations: core units, band, electives, qualification. */
function vocationalExplanation(result: AssessmentResult, title: string): string {
  const cand =
    result.candidates?.find((c) => c.vocational && c.anzscoCode === result.anzscoCode) ??
    result.candidates?.find((c) => c.vocational);
  const v = cand?.vocational;
  const band = BAND_LABEL[v?.coreBand ?? result.tier2Outcome ?? ""] ?? "n/a";
  const head = result.recommended
    ? `Recommended ANZSCO ${result.anzscoCode} (${title}) with ${result.confidence} confidence ` +
      `(${result.determination.replace(/_/g, " ")}). `
    : `No ANZSCO occupation match. Best unit-code coverage against ${cand?.title ?? title}: `;
  return (
    head +
    `Core units ${result.coreMatched}/${result.coreExpected} (${band}).` +
    (v ? ` Electives: ${v.electiveNote}` : "") +
    qualificationSentence(result)
  );
}

/** Step 1 qualification-check notes, as one trailing sentence (or ""). */
function qualificationSentence(result: AssessmentResult): string {
  const notes = result.qualificationNotes ?? [];
  return notes.length ? ` Qualification check: ${notes.join(" ")}` : "";
}

export async function writeExplanation(
  result: AssessmentResult,
  opts?: { useLlm?: boolean; deadlineMs?: number },
): Promise<string> {
  const fallback = buildExplanationFallback(result);
  if (opts?.useLlm === false) return fallback;
  // Unit-code occupations: the deterministic text is exact (no tier wording).
  if (result.assessmentFlow === "vocational_units") return fallback;
  if (Date.now() >= (opts?.deadlineMs ?? Infinity)) return fallback;

  try {
    const { data } = await generateJson(
      explanationUserPrompt({
        anzscoCode: result.anzscoCode,
        title: result.title,
        recommended: result.recommended,
        confidence: result.confidence,
        determination: result.determination,
        foundationalMatched: result.foundationalMatched,
        foundationalExpected: result.foundationalExpected,
        foundationalPct: result.foundationalPct,
        coreMatched: result.coreMatched,
        coreExpected: result.coreExpected,
        corePct: result.corePct,
        tier1Outcome: result.tier1Outcome,
        tier2Outcome: result.tier2Outcome,
        tier3GateMet: result.tier3GateMet,
        workExperienceBoost: result.workExperienceBoost,
      }),
      explanationSystemPrompt(result.title ?? undefined, result.anzscoCode ?? undefined),
      {
        deadlineMs: opts?.deadlineMs,
        maxTokens: 512,
        responseSchema: explanationSchema,
      },
    );
    const parsed = explanationSchema.parse(data);
    return parsed.explanation?.trim() || fallback;
  } catch {
    return fallback;
  }
}
