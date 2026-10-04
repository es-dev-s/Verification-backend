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
  if (!result.recommended) {
    return (
      `No ANZSCO occupation match. ` +
      `Best coverage against ${title}: foundational ${result.foundationalMatched}/${result.foundationalExpected} (${result.foundationalPct}%), ` +
      `core ${result.coreMatched}/${result.coreExpected} (${result.corePct}%). ` +
      `Tier 1: ${result.tier1Outcome ?? "n/a"}; Tier 2: ${result.tier2Outcome ?? "n/a"}; ` +
      `major project/thesis gate: ${result.tier3GateMet ? "met" : "not met"}.`
    );
  }
  const boost = result.workExperienceBoost
    ? ` Related ${title} work experience provided a positive confidence boost.`
    : "";
  return (
    `Recommended ANZSCO ${result.anzscoCode} (${title}) with ${result.confidence} confidence ` +
    `(${result.determination.replace(/_/g, " ")}). ` +
    `Foundational ${result.foundationalMatched}/${result.foundationalExpected} (${result.foundationalPct}%), ` +
    `core ${result.coreMatched}/${result.coreExpected} (${result.corePct}%). ` +
    `Major project/thesis gate ${result.tier3GateMet ? "met" : "not met"}.` +
    boost
  );
}

export async function writeExplanation(
  result: AssessmentResult,
  opts?: { useLlm?: boolean; deadlineMs?: number },
): Promise<string> {
  const fallback = buildExplanationFallback(result);
  if (opts?.useLlm === false) return fallback;
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
