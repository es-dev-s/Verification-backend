import { generateJson } from "../lib/gemini.js";
import { assessConfig } from "./config.js";
import type { RubricSubject } from "./loadRubric.js";
import {
  bestSimilarity,
  expandVariantPatterns,
  normalizeSubjectName,
} from "./normalize.js";
import {
  unclearMatchSystemPrompt,
  unclearMatchUserPrompt,
} from "./prompts.js";
import {
  llmMatchDecisionSchema,
  type ExtractedSubjectRow,
  type MatchMethod,
  type QualificationType,
  type SubjectMatch,
} from "./schemas.js";

type VariantIndexEntry = {
  subject: RubricSubject;
  variantNorm: string;
  variantRaw: string;
};

function buildVariantIndex(subjects: RubricSubject[]): VariantIndexEntry[] {
  const entries: VariantIndexEntry[] = [];
  for (const subject of subjects) {
    const names = [subject.name, ...subject.variants];
    for (const raw of names) {
      for (const expanded of expandVariantPatterns(raw)) {
        const variantNorm = normalizeSubjectName(expanded);
        if (!variantNorm) continue;
        entries.push({ subject, variantNorm, variantRaw: expanded });
      }
    }
  }
  return entries;
}

function tryExact(
  name: string,
  index: VariantIndexEntry[],
): RubricSubject | null {
  const norm = normalizeSubjectName(name);
  if (!norm) return null;
  for (const e of index) {
    if (e.variantNorm === norm) return e.subject;
  }
  return null;
}

function tryFuzzy(
  name: string,
  index: VariantIndexEntry[],
  threshold: number,
): { subject: RubricSubject; score: number } | null {
  let best: { subject: RubricSubject; score: number } | null = null;
  // Dedupe by subject name — take best variant score per subject
  const bySubject = new Map<string, { subject: RubricSubject; score: number }>();
  for (const e of index) {
    const score = bestSimilarity(name, e.variantRaw);
    const prev = bySubject.get(e.subject.name);
    if (!prev || score > prev.score) {
      bySubject.set(e.subject.name, { subject: e.subject, score });
    }
  }
  for (const hit of bySubject.values()) {
    if (hit.score < threshold) continue;
    if (!best || hit.score > best.score) best = hit;
  }
  return best;
}

/**
 * Match extracted subjects against rubric variants.
 * Exact → fuzzy → optional LLM for leftovers.
 */
export async function matchSubjects(
  extracted: ExtractedSubjectRow[],
  rubricSubjects: RubricSubject[],
  opts?: { useLlm?: boolean; deadlineMs?: number },
): Promise<{ matches: SubjectMatch[]; unmatched: ExtractedSubjectRow[] }> {
  const index = buildVariantIndex(rubricSubjects);
  const matches: SubjectMatch[] = [];
  const unclear: ExtractedSubjectRow[] = [];

  // Principle 2: one transcript subject may satisfy multiple rubric subjects —
  // we allow multiple matches from one name only when exact hits differ.
  // For scoring uniqueness: each rubric expected/core subject counts once.

  for (const row of extracted) {
    const exactHits = findAllExact(row.name, index);
    if (exactHits.length) {
      for (const subject of exactHits) {
        matches.push(toMatch(row, subject, "exact", 1));
      }
      continue;
    }

    const fuzzy = tryFuzzy(row.name, index, assessConfig.fuzzyThreshold);
    if (fuzzy) {
      matches.push(toMatch(row, fuzzy.subject, "fuzzy", fuzzy.score));
      continue;
    }

    unclear.push(row);
  }

  if (opts?.useLlm !== false && unclear.length && Date.now() < (opts?.deadlineMs ?? Infinity)) {
    const llmMatches = await matchUnclearWithLlm(
      unclear,
      rubricSubjects,
      opts?.deadlineMs ?? Date.now() + 20_000,
    );
    const stillUnmatched: ExtractedSubjectRow[] = [];
    for (const row of unclear) {
      const d = llmMatches.get(row.name.toLowerCase());
      if (
        d &&
        (d.match === "yes" || d.match === "partial") &&
        d.matchedSubject
      ) {
        const subject = rubricSubjects.find((s) => s.name === d.matchedSubject);
        if (subject) {
          matches.push(
            toMatch(
              row,
              subject,
              "llm",
              d.confidence,
              d.reason,
            ),
          );
          continue;
        }
      }
      stillUnmatched.push(row);
      matches.push({
        transcriptName: row.name,
        transcriptCode: row.code ?? null,
        qualification: row.qualification as QualificationType,
        rubricSubject: null,
        tier: null,
        category: null,
        method: "none",
        confidence: 0,
        reason: d?.reason,
      });
    }
    return {
      matches,
      unmatched: stillUnmatched,
    };
  }

  for (const row of unclear) {
    matches.push({
      transcriptName: row.name,
      transcriptCode: row.code ?? null,
      qualification: row.qualification as QualificationType,
      rubricSubject: null,
      tier: null,
      category: null,
      method: "none",
      confidence: 0,
    });
  }

  return { matches, unmatched: unclear };
}

function findAllExact(
  name: string,
  index: VariantIndexEntry[],
): RubricSubject[] {
  const norm = normalizeSubjectName(name);
  if (!norm) return [];
  const byName = new Map<string, RubricSubject>();
  for (const e of index) {
    if (e.variantNorm === norm) byName.set(e.subject.name, e.subject);
  }
  // Also: if transcript contains two rubric concepts joined ("Heat and Mass Transfer")
  // exact on a variant already covers that when listed.
  void tryExact;
  return [...byName.values()];
}

function toMatch(
  row: ExtractedSubjectRow,
  subject: RubricSubject,
  method: MatchMethod,
  confidence: number,
  reason?: string,
): SubjectMatch {
  return {
    transcriptName: row.name,
    transcriptCode: row.code ?? null,
    qualification: row.qualification as QualificationType,
    rubricSubject: subject.name,
    tier: subject.tier,
    category: subject.category,
    method,
    confidence,
    reason,
  };
}

async function matchUnclearWithLlm(
  unclear: ExtractedSubjectRow[],
  rubricSubjects: RubricSubject[],
  deadlineMs: number,
): Promise<
  Map<
    string,
    {
      match: "yes" | "partial" | "no";
      matchedSubject: string | null;
      confidence: number;
      reason: string;
    }
  >
> {
  const out = new Map<
    string,
    {
      match: "yes" | "partial" | "no";
      matchedSubject: string | null;
      confidence: number;
      reason: string;
    }
  >();
  // Batch in groups of 15
  const batchSize = 15;
  for (let i = 0; i < unclear.length; i += batchSize) {
    if (Date.now() >= deadlineMs) break;
    const batch = unclear.slice(i, i + batchSize);
    try {
      const { data } = await generateJson(
        unclearMatchUserPrompt(
          batch.map((b) => b.name),
          rubricSubjects.map((s) => ({
            name: s.name,
            variants: s.variants.slice(0, 8),
          })),
        ),
        unclearMatchSystemPrompt(),
        {
          deadlineMs,
          maxTokens: 2048,
          responseSchema: llmMatchDecisionSchema,
        },
      );
      const parsed = llmMatchDecisionSchema.parse(data);
      for (const d of parsed.decisions) {
        out.set(d.transcriptName.toLowerCase(), {
          match: d.match,
          matchedSubject: d.matchedSubject,
          confidence: d.confidence,
          reason: d.reason,
        });
      }
    } catch (err) {
      console.error(
        "[assess] unclear match LLM failed:",
        err instanceof Error ? err.message : err,
      );
    }
  }
  return out;
}

/** Pure matcher for tests — no LLM. */
export function matchSubjectsSync(
  extracted: ExtractedSubjectRow[],
  rubricSubjects: RubricSubject[],
): { matches: SubjectMatch[]; unmatched: ExtractedSubjectRow[] } {
  // reuse async path without LLM by calling logic inline
  const index = buildVariantIndex(rubricSubjects);
  const matches: SubjectMatch[] = [];
  const unmatched: ExtractedSubjectRow[] = [];
  for (const row of extracted) {
    const exactHits = findAllExact(row.name, index);
    if (exactHits.length) {
      for (const subject of exactHits) {
        matches.push(toMatch(row, subject, "exact", 1));
      }
      continue;
    }
    const fuzzy = tryFuzzy(row.name, index, assessConfig.fuzzyThreshold);
    if (fuzzy) {
      matches.push(toMatch(row, fuzzy.subject, "fuzzy", fuzzy.score));
      continue;
    }
    unmatched.push(row);
    matches.push({
      transcriptName: row.name,
      transcriptCode: row.code ?? null,
      qualification: row.qualification as QualificationType,
      rubricSubject: null,
      tier: null,
      category: null,
      method: "none",
      confidence: 0,
    });
  }
  return { matches, unmatched };
}
