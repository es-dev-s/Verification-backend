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

export type ExperienceBoostOpts = {
  useLlm?: boolean;
  deadlineMs?: number;
  /** Occupation being scored — used for keyword + LLM relevance. */
  occupationTitle?: string;
  anzscoCode?: string;
};

/**
 * Heuristic + optional LLM: is work experience related to the occupation?
 * Positive boost only — never the main measure.
 */
export async function judgeWorkExperienceBoost(
  rows: ExperienceRowLike[],
  cvText: string | null,
  opts?: ExperienceBoostOpts,
): Promise<{ related: boolean; reason: string }> {
  const occupationTitle = opts?.occupationTitle ?? "Chemical Engineer";
  const anzscoCode = opts?.anzscoCode;

  const heuristic = heuristicOccupationRelated(
    rows,
    cvText,
    occupationTitle,
  );
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
      workExperienceSystemPrompt(occupationTitle, anzscoCode),
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

function heuristicOccupationRelated(
  rows: ExperienceRowLike[],
  cvText: string | null,
  occupationTitle: string,
): { related: boolean; reason: string } {
  const tokens = occupationTitle
    .toLowerCase()
    .replace(/[/()]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 3 && t !== "engineer" && t !== "engineering");

  const keywordRe =
    tokens.length > 0
      ? new RegExp(`\\b(${tokens.map(escapeRegex).join("|")})\\b`, "i")
      : null;

  for (const r of rows) {
    const blob = `${r.title ?? ""} ${r.employer ?? ""}`;
    if (keywordRe?.test(blob)) {
      return {
        related: true,
        reason: `Title/employer keywords indicate ${occupationTitle}-related work.`,
      };
    }
  }
  if (cvText && keywordRe?.test(cvText.slice(0, 8000))) {
    return {
      related: true,
      reason: `CV text indicates ${occupationTitle}-related experience.`,
    };
  }
  return {
    related: false,
    reason: `No ${occupationTitle}-specific experience detected.`,
  };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
