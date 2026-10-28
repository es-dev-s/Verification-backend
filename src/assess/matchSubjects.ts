import { generateJson } from "../lib/gemini.js";
import { assessConfig } from "./config.js";
import type { Rubric, RubricSubject } from "./loadRubric.js";
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
  /**
   * Topic words the keyword rule also needs before it credits the gate
   * ("draft*" = prefix). Unset → any project / thesis title counts (engineers).
   * Rubric variants / aliases of the gate still match on their own.
   */
  gateKeywordRequires?: string[];
  /**
   * Principle 2 (combined courses): each half of "A and B" is also matched on
   * its own, even when the whole title already matched something, so one
   * course can satisfy two rubric rows. Off unless the rubric turns it on.
   */
  combinedCourses?: boolean;
};

/** Matching options a rubric asks for (gate subject, gate topic words, combined courses). */
export function matchOptionsForRubric(rubric: Rubric): MatchOptions {
  const gate = rubric.tiers.tier3.gate;
  return {
    gateSubject: gate?.gateSubject,
    ...(gate?.keywordRuleRequires?.length
      ? { gateKeywordRequires: gate.keywordRuleRequires }
      : {}),
    ...(rubric.matching?.combinedCourses ? { combinedCourses: true } : {}),
  };
}

/** True when the name has one of the words ("draft*" matches drafting, draftsman …). */
export function hasTopicWord(name: string, words: readonly string[]): boolean {
  const toks = normalizeSubjectName(name).split(" ").filter(Boolean);
  return words.some((w) => {
    const word = w.toLowerCase().trim();
    if (!word) return false;
    if (word.endsWith("*")) {
      const stem = word.slice(0, -1);
      return toks.some((t) => t.startsWith(stem));
    }
    return toks.includes(word);
  });
}

/** Keyword rule for the gate: project/thesis title (+ topic words when the rubric asks). */
function keywordRuleCreditsGate(name: string, opts?: MatchOptions): boolean {
  if (!opts?.gateSubject || !looksLikeGateSubject(name)) return false;
  const required = opts.gateKeywordRequires;
  return !required?.length || hasTopicWord(name, required);
}

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
  if (opts?.combinedCourses) {
    // Principle 2: "Computer Aided Design and Solid Modelling" → 2D CAD + 3D.
    const have = new Set(out.map((m) => `${m.tier}|${m.rubricSubject}`));
    for (const part of compoundParts(row.name)) {
      const exact = findAllExact(part, index);
      const hits = exact.length
        ? exact.map((subject) => ({ subject, score: RULE_CONFIDENCE.canonical }))
        : tryRules(part, index);
      for (const h of hits) {
        const k = subjectKey(h.subject);
        if (have.has(k)) continue;
        have.add(k);
        out.push(
          toMatch(row, h.subject, "fuzzy", h.score, `Combined course: "${part}"`),
        );
      }
    }
  }
  if (opts?.gateSubject && keywordRuleCreditsGate(row.name, opts)) {
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

  const perRow: SubjectMatch[][] = [];
  for (const row of extracted) {
    const hits = matchRowSync(row, index, opts);
    if (hits.length) {
      perRow.push(hits);
      continue;
    }
    unclear.push(row);
  }
  for (const hits of creditSharedOnce(perRow, rubricSubjects)) matches.push(...hits);

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
        // A gate with topic words (312511) is not credited by the LLM for a
        // generic "Final Year Project" either.
        const gateBlocked =
          subject?.tier === "tier3" &&
          subject.name === opts?.gateSubject &&
          Boolean(opts?.gateKeywordRequires?.length) &&
          !hasTopicWord(row.name, opts!.gateKeywordRequires!);
        if (subject && !gateBlocked) {
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

const CATEGORY_RANK: Record<string, number> = { expected: 0, core: 0, optional: 1 };

/**
 * Shared sheet rows: one anzsco_subjects.json heading can be linked to several rubric
 * headings (its "id" plus "alsoIds"), so they all carry the same variants and one
 * transcript subject would otherwise hit each of them. Scoring counts unique rubric
 * headings, so that would count one subject several times.
 *
 * Rule: per transcript subject, at most one heading per shared row is credited.
 * Rows with no such clash go first; for a clash the kept heading is, in order:
 * one whose own rubric name the transcript subject equals (e.g. "Physical Metallurgy"
 * → "Physical Metallurgy / Phase Transformations"), one not yet credited by another
 * transcript subject, a counted (expected/core)
 * heading over an optional one, the higher confidence, then rubric order.
 * Hits on headings that do not share a row are untouched.
 */
export function creditSharedOnce(
  perRow: SubjectMatch[][],
  rubricSubjects: RubricSubject[],
): SubjectMatch[][] {
  const info = new Map<string, { shared?: string; order: number; own: Set<string> }>();
  rubricSubjects.forEach((s, order) =>
    info.set(`${s.tier}|${s.name}`, {
      shared: s.sharedVariantsFrom,
      order,
      // The heading name and each "/"-separated part of it.
      own: new Set(
        [s.name, ...s.name.split("/")]
          .flatMap((v) => expandVariantPatterns(v))
          .map((v) => normalizeSubjectName(v))
          .filter(Boolean),
      ),
    }),
  );
  const ownName = (m: SubjectMatch) =>
    info.get(`${m.tier}|${m.rubricSubject}`)?.own.has(normalizeSubjectName(m.transcriptName)) ?? false;
  const keyOf = (m: SubjectMatch) => `${m.tier}|${m.rubricSubject}`;
  const sharedOf = (m: SubjectMatch) => info.get(keyOf(m))?.shared;
  const clashes = (hits: SubjectMatch[]) => {
    const seen = new Set<string>();
    for (const m of hits) {
      const g = sharedOf(m);
      if (!g) continue;
      if (seen.has(g)) return true;
      seen.add(g);
    }
    return false;
  };

  const credited = new Set<string>();
  const out: SubjectMatch[][] = perRow.map((hits) => hits);
  perRow.forEach((hits) => {
    if (!clashes(hits)) for (const m of hits) credited.add(keyOf(m));
  });
  perRow.forEach((hits, i) => {
    if (!clashes(hits)) return;
    const byGroup = new Map<string, SubjectMatch[]>();
    for (const m of hits) {
      const g = sharedOf(m);
      if (g) byGroup.set(g, [...(byGroup.get(g) ?? []), m]);
    }
    const keep = new Set<SubjectMatch>(hits.filter((m) => !sharedOf(m)));
    for (const group of byGroup.values()) {
      const best = [...group].sort(
        (x, y) =>
          Number(ownName(y)) - Number(ownName(x)) ||
          Number(credited.has(keyOf(x))) - Number(credited.has(keyOf(y))) ||
          (CATEGORY_RANK[x.category ?? ""] ?? 2) - (CATEGORY_RANK[y.category ?? ""] ?? 2) ||
          y.confidence - x.confidence ||
          (info.get(keyOf(x))?.order ?? 0) - (info.get(keyOf(y))?.order ?? 0),
      )[0]!;
      keep.add(best);
      credited.add(keyOf(best));
    }
    out[i] = hits.filter((m) => keep.has(m));
  });
  return out;
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
