import {
  generateJsonGroq,
  groqIsConfigured,
  loadGroqKeys,
} from "../lib/groqClient.js";
import { assessConfig } from "./config.js";
import {
  workExperienceTop3SystemPrompt,
  workExperienceTop3UserPrompt,
} from "./prompts.js";
import {
  workExperienceTop3AnalysisSchema,
  type MatchedJob,
  type WorkExperienceTop3Analysis,
} from "./schemas.js";

export type ExperienceRowLike = {
  employer?: string | null;
  title?: string | null;
  domainFinal?: boolean | null;
  domainSuggested?: boolean | null;
};

export type OccupationCandidateLike = {
  anzscoCode: string;
  title: string;
};

export type OccupationWorkJudgement = {
  anzscoCode: string;
  related: boolean;
  matchedJobs: MatchedJob[];
  analysis: string;
};

export type AnalyzeWorkExperienceOpts = {
  useLlm?: boolean;
  deadlineMs?: number;
};

/**
 * Ask Groq whether confirmed DB work rows are relevant to each top ANZSCO.
 * Positive signal only — never used as the main academic measure.
 * No keyword heuristics: if LLM is off/unavailable, all return related=false.
 */
export async function analyzeWorkExperienceForCandidates(
  rows: ExperienceRowLike[],
  occupations: OccupationCandidateLike[],
  opts?: AnalyzeWorkExperienceOpts,
): Promise<OccupationWorkJudgement[]> {
  const empty = occupations.map((o) => ({
    anzscoCode: o.anzscoCode,
    related: false,
    matchedJobs: [] as MatchedJob[],
    analysis: "",
  }));

  if (!occupations.length) return empty;
  if (opts?.useLlm === false) return empty;
  if (!rows.some((r) => (r.title ?? "").trim() || (r.employer ?? "").trim())) {
    return empty;
  }
  if (!groqIsConfigured()) {
    console.warn(
      "[assess] work experience analysis skipped: Groq not configured",
    );
    return empty;
  }
  if (Date.now() >= (opts?.deadlineMs ?? Infinity)) return empty;

  const apiKey = loadGroqKeys()[0];
  if (!apiKey) return empty;

  const jobsSummary = rows
    .map((r, i) => {
      const related = r.domainFinal ?? r.domainSuggested;
      const relatedLabel =
        related == null ? "unknown" : related ? "true" : "false";
      return `${i + 1}. title=${r.title?.trim() || "?"} | employer=${r.employer?.trim() || "?"} | engineeringRelated=${relatedLabel}`;
    })
    .join("\n");

  const occupationsSummary = occupations
    .map((o, i) => `${i + 1}. ANZSCO ${o.anzscoCode} — ${o.title}`)
    .join("\n");

  const requestMs = Math.min(
    assessConfig.extractRequestTimeoutMs,
    Math.max(8_000, (opts?.deadlineMs ?? Date.now() + 45_000) - Date.now() - 1_000),
  );

  try {
    const { data } = await generateJsonGroq(
      workExperienceTop3UserPrompt(jobsSummary, occupationsSummary),
      workExperienceTop3SystemPrompt(),
      {
        apiKey,
        maxTokens: 1024,
        requestTimeoutMs: requestMs,
        responseSchema: workExperienceTop3AnalysisSchema,
      },
    );
    const parsed = workExperienceTop3AnalysisSchema.parse(
      data,
    ) as WorkExperienceTop3Analysis;
    return mergeJudgements(occupations, parsed, rows);
  } catch (err) {
    console.error(
      "[assess] work experience Groq failed:",
      err instanceof Error ? err.message : err,
    );
    return empty;
  }
}

function mergeJudgements(
  occupations: OccupationCandidateLike[],
  parsed: WorkExperienceTop3Analysis,
  rows: ExperienceRowLike[],
): OccupationWorkJudgement[] {
  const byCode = new Map(
    parsed.occupations.map((o) => [normalizeCode(o.anzscoCode), o]),
  );

  return occupations.map((occ) => {
    const hit = byCode.get(normalizeCode(occ.anzscoCode));
    if (!hit) {
      return {
        anzscoCode: occ.anzscoCode,
        related: false,
        matchedJobs: [],
        analysis: "",
      };
    }

    const matchedJobs = (hit.matchedJobs ?? [])
      .map((j) => sanitizeMatchedJob(j, rows))
      .filter((j): j is MatchedJob => j != null);

    const related = Boolean(hit.related) && matchedJobs.length > 0;
    const analysis = related ? truncateAnalysis(hit.analysis ?? "") : "";

    return {
      anzscoCode: occ.anzscoCode,
      related,
      matchedJobs: related ? matchedJobs : [],
      analysis,
    };
  });
}

function sanitizeMatchedJob(
  job: { title?: string; employer?: string | null },
  rows: ExperienceRowLike[],
): MatchedJob | null {
  const title = (job.title ?? "").trim();
  if (!title) return null;

  const titleLower = title.toLowerCase();
  const row =
    rows.find((r) => (r.title ?? "").trim().toLowerCase() === titleLower) ??
    rows.find((r) =>
      (r.title ?? "").trim().toLowerCase().includes(titleLower),
    ) ??
    rows.find((r) =>
      titleLower.includes((r.title ?? "").trim().toLowerCase()) &&
      (r.title ?? "").trim().length > 0,
    );

  if (!row?.title?.trim()) {
    // Still accept LLM title if it roughly matches some row text
    const blobHit = rows.find((r) => {
      const blob = `${r.title ?? ""} ${r.employer ?? ""}`.toLowerCase();
      return blob.includes(titleLower) || titleLower.includes(blob.trim());
    });
    if (!blobHit) return null;
    return {
      title: blobHit.title?.trim() || title,
      employer: blobHit.employer?.trim() || job.employer?.trim() || null,
    };
  }

  return {
    title: row.title.trim(),
    employer: row.employer?.trim() || job.employer?.trim() || null,
  };
}

function truncateAnalysis(text: string): string {
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (!cleaned) return "";
  const sentences = cleaned.match(/[^.!?]+[.!?]+|[^.!?]+$/g) ?? [cleaned];
  return sentences
    .slice(0, 2)
    .map((s) => s.trim())
    .filter(Boolean)
    .join(" ")
    .slice(0, 280);
}

function normalizeCode(code: string): string {
  return code.replace(/\s+/g, "").toLowerCase();
}
