import { flattenRubricSubjects, subjectGroupLabels, type Rubric } from "./loadRubric.js";
import type { SubjectMatch } from "./schemas.js";
import type { ScoreResult } from "./score.js";

/**
 * Engineering Technologist (233914): anzsco_subjects.json sheet groups → rubric
 * tiers. The rubric rows carry the same heading ids (233914-T1.x / T2.x / T3.x),
 * so variants already merge by id; this map gives the card its tier headings.
 */
export const ET_GROUP_TIERS = {
  partA: "tier1",
  partB_core: "tier2",
  partB_optional: "tier2",
  partC_core: "tier3",
  partC_core_2: "tier3",
} as const satisfies Record<string, "tier1" | "tier2" | "tier3">;

export type EtTierRow = { name: string; matched: boolean; optional: boolean };

export type EtTierSummary = {
  tier: "tier1" | "tier2" | "tier3";
  /** Sheet group label(s) for this tier, e.g. "Foundational Subjects". */
  label: string;
  matched: number;
  /** Rubric denominator (Tier 1 / Tier 2); null for Tier 3 (gate). */
  expected: number | null;
  rows: EtTierRow[];
};

export type EtTierDetail = {
  tiers: EtTierSummary[];
  /** Tier 3 gate (capstone / final-year project) found. */
  gateMet: boolean;
};

const DEFAULT_LABEL: Record<EtTierSummary["tier"], string> = {
  tier1: "Foundational subjects",
  tier2: "Claimed stream",
  tier3: "Project / capstone",
};

/** "C.1 Canonical project / capstone categories" → "Canonical project / capstone categories"; drops a trailing "(…)". */
function shortLabel(label: string): string {
  return label.replace(/^[A-Z]\.\d+\s+/, "").replace(/\s*\([^)]*\)\s*$/, "").trim();
}

/** Tier 1 / Tier 2 / Tier 3 detail for the ET card, from ET's own scoring. */
export function etTierDetail(input: {
  rubric: Rubric;
  scored: Pick<ScoreResult, "foundationalMatched" | "foundationalExpected" | "coreMatched" | "coreExpected" | "tier3GateMet">;
  matches: SubjectMatch[];
}): EtTierDetail {
  const labels = subjectGroupLabels(input.rubric.anzscoCode, input.rubric.occupationId);
  const matchedNames = new Set(
    input.matches.filter((m) => m.rubricSubject && m.tier).map((m) => `${m.tier}|${m.rubricSubject}`),
  );
  const subjects = flattenRubricSubjects(input.rubric).filter((s) => s.variants.length > 0 || matchedNames.has(`${s.tier}|${s.name}`));
  const tiers: EtTierSummary[] = (["tier1", "tier2", "tier3"] as const).map((tier) => {
    const groupLabels = Object.entries(ET_GROUP_TIERS)
      .filter(([, t]) => t === tier)
      .map(([g]) => labels[g])
      .filter((l): l is string => Boolean(l))
      .map(shortLabel);
    const rows = subjects
      .filter((s) => s.tier === tier)
      .map((s) => ({
        name: s.name,
        matched: matchedNames.has(`${tier}|${s.name}`),
        optional: s.category === "optional",
      }));
    const counted =
      tier === "tier1"
        ? { matched: input.scored.foundationalMatched, expected: input.scored.foundationalExpected }
        : tier === "tier2"
          ? { matched: input.scored.coreMatched, expected: input.scored.coreExpected }
          : { matched: rows.filter((r) => r.matched).length, expected: null };
    return {
      tier,
      label: groupLabels[0] ?? DEFAULT_LABEL[tier],
      ...counted,
      rows,
    };
  });
  return { tiers, gateMet: input.scored.tier3GateMet };
}
