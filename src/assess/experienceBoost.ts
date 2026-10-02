import { generateJson } from "../lib/gemini.js";
import {
  workExperienceSystemPrompt,
  workExperienceUserPrompt,
} from "./prompts.js";
import { workExperienceRelevanceSchema } from "./schemas.js";

export type ExperienceRowLike = {
  employer?: string | null;
  title?: string | null;
  domainFinal?: boolean | null;
  domainSuggested?: boolean | null;
};

/**
 * Heuristic + optional LLM: is work experience related to chemical engineering?
 * Positive boost only — never the main measure.
 */
export async function judgeWorkExperienceBoost(
  rows: ExperienceRowLike[],
  cvText: string | null,
  opts?: { useLlm?: boolean; deadlineMs?: number },
): Promise<{ related: boolean; reason: string }> {
  // Fast path: existing domain flags + keyword heuristics
  const heuristic = heuristicChemicalEng(rows, cvText);
  if (heuristic.related) return heuristic;

  if (opts?.useLlm === false) return heuristic;
  if (!rows.length && !cvText?.trim()) return heuristic;
  if (Date.now() >= (opts?.deadlineMs ?? Infinity)) return heuristic;

  try {
    const summary = rows
      .map(
        (r, i) =>
          `${i + 1}. ${r.title ?? "?"} @ ${r.employer ?? "?"} (domainFinal=${r.domainFinal ?? r.domainSuggested ?? "?"})`,
      )
      .join("\n");
    const { data } = await generateJson(
      workExperienceUserPrompt(summary, cvText),
      workExperienceSystemPrompt(),
      {
        deadlineMs: opts?.deadlineMs,
        maxTokens: 512,
        responseSchema: workExperienceRelevanceSchema,
      },
    );
    const parsed = workExperienceRelevanceSchema.parse(data);
    return { related: parsed.related, reason: parsed.reason };
  } catch (err) {
    console.error(
      "[assess] work experience LLM failed:",
      err instanceof Error ? err.message : err,
    );
    return heuristic;
  }
}

const CHEM_KEYWORDS =
  /\b(chemical engineer|process engineer|petrochemical|refinery|reactor|heat exchanger|mass transfer|process design|process control|polymer|pharmaceutical process|plant design)\b/i;

function heuristicChemicalEng(
  rows: ExperienceRowLike[],
  cvText: string | null,
): { related: boolean; reason: string } {
  for (const r of rows) {
    const blob = `${r.title ?? ""} ${r.employer ?? ""}`;
    if (CHEM_KEYWORDS.test(blob)) {
      return {
        related: true,
        reason: "Title/employer keywords indicate chemical/process engineering work.",
      };
    }
  }
  if (cvText && CHEM_KEYWORDS.test(cvText.slice(0, 8000))) {
    return {
      related: true,
      reason: "CV text indicates chemical/process engineering experience.",
    };
  }
  // Domain flags alone are "engineering-related", not chemical-specific — do not boost
  return { related: false, reason: "No chemical-engineering-specific experience detected." };
}
