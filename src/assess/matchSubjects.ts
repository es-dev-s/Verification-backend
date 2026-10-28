import { generateJson } from "../lib/gemini.js";
import { assessConfig } from "./config.js";
import type { RubricSubject } from "./loadRubric.js";
import {
  bestSimilarity,
  canonicalTokens,
  compoundParts,
  coreFromCanonical,
  expandVariantPatterns,
  normalizeSubjectName,
  ruleMatch,
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
  canonical: string;
  core: string[];
};

export type MatchOptions = {
  /**
   * Rubric tier-3 gate subject name. Any transcript subject that looks like a
   * final-year project / thesis / capstone / dissertation is matched to it.
   */
  gateSubject?: string;
};

/** Confidence assigned to rule-based (non-exact) matches. */
const RULE_CONFIDENCE = {
  canonical: 0.97,
  core_equal: 0.93,
  containment: 0.88,
  gate: 0.9,
} as const;

/** Max rubric subjects one transcript subject may satisfy via containment. */
const MAX_CONTAINMENT_HITS = 3;

const GATE_RE = /\b(project|thesis|capstone|dissertation)\b/i;
/** Management / planning style courses that merely mention "project". */
const GATE_EXCLUDE_RE =
  /\b(management|planning|planner|appraisal|scheduling|finance|financing|economics|estimation|estimating|costing|control|administration|procurement|mini|minor)\b/i;

/** True when a transcript subject name looks like the tier-3 gate (project/thesis). */
export function looksLikeGateSubject(name: string): boolean {
  return GATE_RE.test(name) && !GATE_EXCLUDE_RE.test(name);
}

function buildVariantIndex(subjects: RubricSubject[]): VariantIndexEntry[] {
  const entries: VariantIndexEntry[] = [];
  const seen = new Set<string>();
  for (const subject of subjects) {
    const names = [subject.name, ...subject.variants];
    for (const raw of names) {
      for (const expanded of expandVariantPatterns(raw)) {
        const variantNorm = normalizeSubjectName(expanded);
        if (!variantNorm) continue;
        const key = `${subject.tier}|${subject.name}|${variantNorm}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const canon = canonicalTokens(expanded);
        entries.push({
          subject,
          variantNorm,
          variantRaw: expanded,
          canonical: canon.join(" "),
          core: coreFromCanonical(canon),
        });
      }
    }
  }
  return entries;
}

function subjectKey(s: RubricSubject): string {
  return `${s.tier}|${s.name}`;
}

/**
 * Rule-based matching (abbreviations, plural/singular, level suffixes,
 * stopword-insensitive core equality, guarded containment).
 */
function tryRules(
  name: string,
  index: VariantIndexEntry[],
): Array<{ subject: RubricSubject; score: number }> {
  const canon = canonicalTokens(name);
  const probe = { canonical: canon.join(" "), core: coreFromCanonical(canon) };
  if (!probe.canonical) return [];
  const strong = new Map<string, { subject: RubricSubject; score: number }>();
  const contain = new Map<string, { subject: RubricSubject; score: number }>();
  for (const e of index) {
    const kind = ruleMatch(probe, e);
    if (!kind) continue;
    const score = RULE_CONFIDENCE[kind];
    const target = kind === "containment" ? contain : strong;
    const k = subjectKey(e.subject);
    const prev = target.get(k);
    if (!prev || score > prev.score) target.set(k, { subject: e.subject, score });
  }
  if (!strong.size) {
    // Compound titles: each half may equal its own rubric subject.
    for (const part of compoundParts(name)) {
      const pc = canonicalTokens(part);
      const pp = { canonical: pc.join(" "), core: coreFromCanonical(pc) };
      for (const e of index) {
        const kind = ruleMatch(pp, e);
        if (kind !== "canonical" && kind !== "core_equal") continue;
        const k = subjectKey(e.subject);
        if (!strong.has(k)) {
          strong.set(k, { subject: e.subject, score: RULE_CONFIDENCE.core_equal });
        }
      }
    }
  }
  if (strong.size) return [...strong.values()];
  return [...contain.values()].slice(0, MAX_CONTAINMENT_HITS);
}

/** Exact → rule-based → fuzzy for one row (no LLM). */
function matchRowSync(
  row: ExtractedSubjectRow,
  index: VariantIndexEntry[],
  opts?: MatchOptions,
): SubjectMatch[] {
  const out: SubjectMatch[] = [];
  const exactHits = findAllExact(row.name, index);
  if (exactHits.length) {
    for (const subject of exactHits) out.push(toMatch(row, subject, "exact", 1));
  } else {
    const ruleHits = tryRules(row.name, index);
    if (ruleHits.length) {
      for (const h of ruleHits) out.push(toMatch(row, h.subject, "fuzzy", h.score));
    } else {
      const fuzzy = tryFuzzy(row.name, index, assessConfig.fuzzyThreshold);
      if (fuzzy) out.push(toMatch(row, fuzzy.subject, "fuzzy", fuzzy.score));
    }
  }
  if (opts?.gateSubject && looksLikeGateSubject(row.name)) {
    const gate = index.find(
      (e) => e.subject.tier === "tier3" && e.subject.name === opts.gateSubject,
    )?.subject;
    if (gate && !out.some((m) => m.rubricSubject === gate.name && m.tier === "tier3")) {
      out.push(
        toMatch(row, gate, "fuzzy", RULE_CONFIDENCE.gate, "Project / thesis keyword rule"),
      );
    }
  }
  return out;
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
    const prev = bySubject.get(subjectKey(e.subject));
    if (!prev || score > prev.score) {
      bySubject.set(subjectKey(e.subject), { subject: e.subject, score });
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
  opts?: {
    useLlm?: boolean;
    deadlineMs?: number;
    occupationTitle?: string;
    anzscoCode?: string;
  } & MatchOptions,
): Promise<{ matches: SubjectMatch[]; unmatched: ExtractedSubjectRow[] }> {
  const index = buildVariantIndex(rubricSubjects);
  const matches: SubjectMatch[] = [];
  const unclear: ExtractedSubjectRow[] = [];

  // Principle 2: one transcript subject may satisfy multiple rubric subjects —
  // we allow multiple matches from one name only when exact hits differ.
  // For scoring uniqueness: each rubric expected/core subject counts once.

  for (const row of extracted) {
    const hits = matchRowSync(row, index, opts);
    if (hits.length) {
      matches.push(...hits);
      continue;
    }
    unclear.push(row);
  }

  if (opts?.useLlm !== false && unclear.length && Date.now() < (opts?.deadlineMs ?? Infinity)) {
    const llmMatches = await matchUnclearWithLlm(
      unclear,
      rubricSubjects,
      opts?.deadlineMs ?? Date.now() + 20_000,
      opts?.occupationTitle,
      opts?.anzscoCode,
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
    if (e.variantNorm === norm) byName.set(subjectKey(e.subject), e.subject);
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
  occupationTitle?: string,
  anzscoCode?: string,
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
        unclearMatchSystemPrompt(occupationTitle, anzscoCode),
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
  opts?: MatchOptions,
): { matches: SubjectMatch[]; unmatched: ExtractedSubjectRow[] } {
  const index = buildVariantIndex(rubricSubjects);
  const matches: SubjectMatch[] = [];
  const unmatched: ExtractedSubjectRow[] = [];
  for (const row of extracted) {
    const hits = matchRowSync(row, index, opts);
    if (hits.length) {
      matches.push(...hits);
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
