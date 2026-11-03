import { loadAllAcademicRubrics, scoringSubjects, type Rubric } from "../assess/loadRubric.js";
import type { SubjectMatch } from "../assess/schemas.js";
import type { ComponentSplit } from "./schemas.js";

/**
 * Doc 05 §5–6: inside Fundamental and Core, 70% Major + 30% Supporting.
 *
 * - "rubric": the rubric marks some counted Tier 2 core rows as Supporting
 *   ("(supporting)" labels or importance "recommended"). Major = the other
 *   counted rows. Score = 0.7 × Major% + 0.3 × Supporting%.
 * - "derived": the rubric has no Major/Supporting marking for the tier. Per
 *   doc 05 + each occupation's flow doc, Major = the counted rows (Tier 1
 *   "Expected" / Tier 2 "Core") and Supporting = the tier's Optional /
 *   Elective rows. Those rows must never reduce the score (flow docs:
 *   "their absence must never reduce the risk score"), so the 70/30 mix only
 *   applies when it raises the score: max(Major%, 0.7 × Major% + 0.3 × Supporting%).
 * - "plain": no rubric (vocational, telecom group) or the names could not be
 *   reconciled with the assessed counts: the plain coverage % is used.
 */
export const MAJOR_WEIGHT = 0.7;
export const SUPPORTING_WEIGHT = 0.3;

function pct(matched: number, total: number): number {
  return total > 0 ? Math.round((matched / total) * 1000) / 10 : 0;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

export function plainSplit(plainPct: number): ComponentSplit {
  return {
    method: "plain",
    pct: round1(plainPct),
    majorMatched: 0,
    majorTotal: 0,
    majorPct: round1(plainPct),
    supportingMatched: 0,
    supportingTotal: 0,
    supportingPct: null,
    missingMajor: [],
    missingSupporting: [],
  };
}

/**
 * Split one tier. `plain` is the assessed coverage (matched ÷ counted) and
 * `plainMatched` its matched count; both stay authoritative for the Major part.
 */
export function splitTier(
  rubric: Rubric,
  tier: "tier1" | "tier2",
  covered: ReadonlySet<string>,
  plain: { pct: number; matched: number },
): ComponentSplit {
  const counted = scoringSubjects(rubric, tier);
  const marked = counted.filter((s) => s.weight === "supporting");
  if (marked.length && marked.length < counted.length) {
    const major = counted.filter((s) => s.weight !== "supporting");
    const majorHit = major.filter((s) => covered.has(s.name));
    const suppHit = marked.filter((s) => covered.has(s.name));
    if (majorHit.length + suppHit.length !== plain.matched) return plainSplit(plain.pct);
    const majorPct = pct(majorHit.length, major.length);
    const supportingPct = pct(suppHit.length, marked.length);
    return {
      method: "rubric",
      pct: round1(MAJOR_WEIGHT * majorPct + SUPPORTING_WEIGHT * supportingPct),
      majorMatched: majorHit.length,
      majorTotal: major.length,
      majorPct,
      supportingMatched: suppHit.length,
      supportingTotal: marked.length,
      supportingPct,
      missingMajor: major.filter((s) => !covered.has(s.name)).map((s) => s.name),
      missingSupporting: marked.filter((s) => !covered.has(s.name)).map((s) => s.name),
    };
  }
  const supporting = rubric.tiers[tier].subjects.filter((s) => s.category === "optional");
  const majorPct = round1(plain.pct);
  const suppHit = supporting.filter((s) => covered.has(s.name));
  const supportingPct = supporting.length ? pct(suppHit.length, supporting.length) : null;
  const mixed = supportingPct == null ? majorPct : MAJOR_WEIGHT * majorPct + SUPPORTING_WEIGHT * supportingPct;
  return {
    method: "derived",
    pct: round1(Math.max(majorPct, mixed)),
    majorMatched: plain.matched,
    majorTotal: counted.length,
    majorPct,
    supportingMatched: suppHit.length,
    supportingTotal: supporting.length,
    supportingPct,
    missingMajor: counted.filter((s) => !covered.has(s.name)).map((s) => s.name),
    missingSupporting: [],
  };
}

let rubricsCache: Rubric[] | null = null;

/** The academic rubric scored for a candidate (code + title; shared codes such as 233999 need the title). */
export function academicRubricFor(anzscoCode: string, title?: string | null): Rubric | null {
  try {
    rubricsCache ??= loadAllAcademicRubrics();
  } catch {
    return null;
  }
  const code = anzscoCode.replace(/\s+/g, "");
  const same = rubricsCache.filter((r) => r.anzscoCode.replace(/\s+/g, "") === code);
  if (same.length <= 1) return same[0] ?? null;
  const t = (title ?? "").trim().toLowerCase();
  return same.find((r) => r.title.trim().toLowerCase() === t) ?? null;
}

/** Fundamental (Tier 1) and Core (Tier 2) component scores with the Major / Supporting split. */
export function riskComponentSplits(input: {
  rubric: Rubric | null;
  matches: ReadonlyArray<Pick<SubjectMatch, "rubricSubject" | "tier" | "method">>;
  fundamental: { pct: number; matched: number };
  core: { pct: number; matched: number };
}): { fundamental: ComponentSplit; core: ComponentSplit } {
  if (!input.rubric) {
    return { fundamental: plainSplit(input.fundamental.pct), core: plainSplit(input.core.pct) };
  }
  const coveredIn = (tier: "tier1" | "tier2") =>
    new Set(
      input.matches
        .filter((m) => m.tier === tier && m.rubricSubject && m.method !== "none")
        .map((m) => m.rubricSubject as string),
    );
  return {
    fundamental: splitTier(input.rubric, "tier1", coveredIn("tier1"), input.fundamental),
    core: splitTier(input.rubric, "tier2", coveredIn("tier2"), input.core),
  };
}
