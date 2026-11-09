/**
 * Skill level 2 telecommunications group (Engineering Associate).
 *
 * Runs only when Gate 1 has opened Engineering Associate and the qualification
 * is ICT60220. Ranks three occupations from the transcript units:
 *   313213 Telecommunications Network Planner
 *   313212 Telecommunication Field Engineer
 *   313214 Telecommunications Technical Officer or Technologist
 *
 * Unit lists come from anzsco_subjects.json. A unit code is matched first;
 * the unit name is used only when the transcript line has no code. A unit
 * that sits in more than one group is counted once.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Rubric } from "./loadRubric.js";
import { bestSimilarity, normalizeSubjectName } from "./normalize.js";
import { findQualificationCodes } from "./route.js";
import type { ScoreResult } from "./score.js";
import {
  normalizeUnitCode,
  splitUnitCode,
  UNIT_CODE_RE,
  type ExtractedSubjectRow,
  type SubjectMatch,
} from "./schemas.js";
import { scanUnitCodes, stripReleaseLetter } from "./vocational.js";

export const ICT60220 = "ICT60220";

export const TELECOM_ANZSCO = {
  planner: "313213",
  field: "313212",
  officer: "313214",
} as const;

export const TELECOM_ANZSCO_CODES = [
  TELECOM_ANZSCO.field,
  TELECOM_ANZSCO.planner,
  TELECOM_ANZSCO.officer,
] as const;

/** Shown on the occupation card. Joint ranks share Eligible. */
export type TelecomSuggestionStatus = "recommended" | "eligible" | "rejected" | "review";

export type TelecomScored = {
  rubric: Rubric;
  scored: ScoreResult;
  matches: SubjectMatch[];
  unmatched: ExtractedSubjectRow[];
  /** Lower sorts first. Equal values are a joint rank (no tie-break). */
  order: number;
  status: TelecomSuggestionStatus;
};

type Unit = { code: string; title: string };

type Cand = { code: string | null; name: string; row: ExtractedSubjectRow | null };

type Sheet = {
  anzscoCode: string;
  title: string;
  groups: Record<string, { subjects?: Array<{ name?: string }> }>;
};

const TITLE_SIMILARITY_MIN = 0.9;
const GROUP_KEYS = ["group_a", "group_b", "group_c", "group_d", "group_e", "group_f", "group_g"] as const;

let sheets: Sheet[] | null = null;

function loadSheets(): Sheet[] {
  if (sheets) return sheets;
  const here = dirname(fileURLToPath(import.meta.url));
  const path = resolve(here, "../lib/anzsco_subjects.json");
  sheets = JSON.parse(readFileSync(path, "utf8")) as Sheet[];
  return sheets;
}

function sheetFor(code: string): Sheet | undefined {
  return loadSheets().find((s) => s.anzscoCode === code);
}

function unitsIn(sheet: Sheet | undefined, key: string): Unit[] {
  const out: Unit[] = [];
  for (const subject of sheet?.groups[key]?.subjects ?? []) {
    const parsed = splitUnitCode(subject.name ?? "");
    const code = normalizeUnitCode(parsed.code);
    if (!code) continue;
    out.push({ code, title: parsed.name });
  }
  return out;
}

function uniqueUnits(list: Unit[]): Unit[] {
  const seen = new Set<string>();
  const out: Unit[] = [];
  for (const unit of list) {
    if (seen.has(unit.code)) continue;
    seen.add(unit.code);
    out.push(unit);
  }
  return out;
}

/** ICT60220 on the qualification title or the transcript. The specialisation is ignored. */
export function hasIct60220(
  qualifications: readonly { title?: string | null; texts?: readonly string[] | null }[] | undefined,
  texts: readonly string[] = [],
): boolean {
  const blob = [
    ...(qualifications ?? []).flatMap((q) => [q.title ?? "", ...(q.texts ?? [])]),
    ...texts,
  ].join("\n");
  return findQualificationCodes(blob).includes(ICT60220);
}

export function isTelecomAnzsco(codeOrId: string | undefined): boolean {
  const code = String(codeOrId ?? "").replace(/\s+/g, "");
  return (
    (TELECOM_ANZSCO_CODES as readonly string[]).includes(code) ||
    code === "telecommunications-network-planner"
  );
}

function collect(rows: readonly ExtractedSubjectRow[], texts: readonly string[]): Cand[] {
  const byCode = new Map<string, Cand>();
  const titleOnly: Cand[] = [];
  for (const row of rows) {
    const given = normalizeUnitCode(row.code);
    const split = splitUnitCode(row.name);
    const code = given && UNIT_CODE_RE.test(given) ? given : split.code;
    if (code) {
      if (!byCode.has(code)) byCode.set(code, { code, name: split.name || row.name, row });
    } else {
      titleOnly.push({ code: null, name: row.name, row });
    }
  }
  for (const text of texts) {
    for (const hit of scanUnitCodes(text)) {
      if (!byCode.has(hit.code)) byCode.set(hit.code, { code: hit.code, name: hit.name, row: null });
    }
  }
  return [...byCode.values(), ...titleOnly];
}

function sameTitle(a: string, b: string): boolean {
  const na = normalizeSubjectName(a);
  const nb = normalizeSubjectName(b);
  if (!na || !nb) return false;
  return na === nb || bestSimilarity(na, nb) >= TITLE_SIMILARITY_MIN;
}

function matchList(units: Unit[], cands: Cand[]): { matched: Unit[]; missing: Unit[]; hits: Array<{ unit: Unit; cand: Cand }> } {
  const used = new Set<Cand>();
  const hits: Array<{ unit: Unit; cand: Cand }> = [];
  for (const unit of units) {
    const free = cands.filter((c) => !used.has(c));
    const coded = free.filter((c) => c.code);
    const exact = coded.find((c) => c.code === unit.code);
    const release = exact
      ? null
      : coded.find((c) => stripReleaseLetter(c.code!) === stripReleaseLetter(unit.code));
    const byTitle = exact || release ? null : free.find((c) => !c.code && sameTitle(c.name, unit.title));
    const cand = exact ?? release ?? byTitle ?? null;
    if (!cand) continue;
    used.add(cand);
    hits.push({ unit, cand });
  }
  const matchedCodes = new Set(hits.map((h) => h.unit.code));
  return {
    matched: units.filter((u) => matchedCodes.has(u.code)),
    missing: units.filter((u) => !matchedCodes.has(u.code)),
    hits,
  };
}

function pct(matched: number, total: number): number {
  if (!total) return 0;
  return Math.round((matched / total) * 100);
}

function unitLabel(unit: Unit): string {
  return `${unit.code} - ${unit.title}`;
}

function rubricFor(code: string, title: string, foundational: Unit[], core: Unit[]): Rubric {
  const subject = (unit: Unit, category: string) => ({
    name: unitLabel(unit),
    category,
    variants: [] as string[],
  });
  return {
    anzscoCode: code,
    title,
    occupationId: `telecom-${code}`,
    format: "vocational_units",
    qualificationCheck: {
      requirement: "ICT60220 Advanced Diploma of Information Technology",
      exampleTitles: [],
      levelPolicy: "diploma_ok",
    },
    tiers: {
      tier1: {
        label: "Foundational units",
        scoreDenominator: foundational.length,
        subjects: foundational.map((u) => subject(u, "expected")),
      },
      tier2: {
        label: "Core units",
        scoreDenominator: core.length,
        subjects: core.map((u) => subject(u, "core")),
      },
      tier3: { label: "Not used", subjects: [] },
    },
    riskScoring: {
      tier1: { thresholds: [{ matchedRange: [0, foundational.length], outcome: "no_risk", label: "Foundational" }] },
      tier2: { thresholds: [{ matchedRange: [0, core.length], outcome: "no_risk", label: "Core" }] },
      overallDetermination: { combinationTable: [] },
    },
  };
}

function toMatch(unit: Unit, cand: Cand, tier: "tier1" | "tier2", category: string): SubjectMatch {
  return {
    transcriptName: cand.name || unit.title,
    transcriptCode: cand.code,
    qualification: cand.row?.qualification ?? "advanced_diploma",
    rubricSubject: unitLabel(unit),
    tier,
    category,
    method: "exact",
    confidence: cand.code ? 1 : 0.6,
    reason: cand.code ? "code matched" : "title-only match (no code on the transcript line)",
  };
}

function card(input: {
  code: string;
  title: string;
  status: TelecomSuggestionStatus;
  order: number;
  recommended: boolean;
  confidenceScore: number;
  foundational: Unit[];
  foundationalHits: Array<{ unit: Unit; cand: Cand }>;
  core: Unit[];
  coreHits: Array<{ unit: Unit; cand: Cand }>;
  note: string;
  rows: readonly ExtractedSubjectRow[];
}): TelecomScored {
  const foundationalMatched = input.foundationalHits.length;
  const coreMatched = input.coreHits.length;
  const matches = [
    ...input.foundationalHits.map((h) => toMatch(h.unit, h.cand, "tier1", "expected")),
    ...input.coreHits.map((h) => toMatch(h.unit, h.cand, "tier2", "core")),
  ];
  const usedRows = new Set(
    [...input.foundationalHits, ...input.coreHits].map((h) => h.cand.row).filter((r): r is ExtractedSubjectRow => r != null),
  );
  const determination =
    input.status === "recommended"
      ? "verified_no_risk"
      : input.status === "eligible"
        ? "conditional"
        : input.status === "rejected"
          ? "not_verified"
          : "no_match";
  const scored: ScoreResult = {
    foundationalMatched,
    foundationalExpected: input.foundational.length,
    foundationalPct: pct(foundationalMatched, input.foundational.length),
    coreMatched,
    coreExpected: input.core.length,
    corePct: pct(coreMatched, input.core.length),
    tier1Outcome: foundationalMatched === input.foundational.length ? "no_risk" : "high_risk",
    tier2Outcome: coreMatched === input.core.length ? "no_risk" : "high_risk",
    tier3GateMet: false,
    determination,
    recommended: input.recommended,
    confidence: input.recommended ? "high" : null,
    confidenceScore: input.confidenceScore,
    capstoneApplies: false,
    anzscoCode: input.code,
    title: input.title,
    qualificationNotes: [input.note],
    qualificationCapped: false,
    bandDetermination: determination === "no_match" ? "not_verified" : determination,
    gateDowngraded: false,
    routeCapped: false,
  };
  return {
    rubric: rubricFor(input.code, input.title, input.foundational, input.core),
    scored,
    matches,
    unmatched: input.rows.filter((r) => !usedRows.has(r)),
    order: input.order,
    status: input.status,
  };
}

function missingNote(units: Unit[]): string {
  const list = units.map(unitLabel).join("; ");
  return `Foundational units missing: ${list}. No recommendation among Telecommunication Field Engineer (313212), Telecommunications Network Planner (313213) and Telecommunications Technical Officer or Technologist (313214).`;
}

/**
 * Rank the three telecommunications associate occupations.
 * Returns nothing when the subject lists are missing.
 */
export function scoreTelecomGroup(
  rows: readonly ExtractedSubjectRow[],
  texts: readonly string[] = [],
): TelecomScored[] {
  const planner = sheetFor(TELECOM_ANZSCO.planner);
  const field = sheetFor(TELECOM_ANZSCO.field) ?? sheetFor(TELECOM_ANZSCO.officer);
  const officer = sheetFor(TELECOM_ANZSCO.officer) ?? field;
  const foundational = unitsIn(planner, "units_foundational");
  const groupG = unitsIn(planner, "units_core");
  const coreAG = uniqueUnits(GROUP_KEYS.flatMap((key) => unitsIn(field, key)));
  if (!foundational.length || !groupG.length || !coreAG.length || !officer) return [];

  const cands = collect(rows, texts);
  const found = matchList(foundational, cands);
  const gee = matchList(groupG, cands);
  const ag = matchList(coreAG, cands);
  const titles = {
    [TELECOM_ANZSCO.planner]: planner?.title ?? "Telecommunications Network Planner",
    [TELECOM_ANZSCO.field]: sheetFor(TELECOM_ANZSCO.field)?.title ?? "Telecommunication Field Engineer",
    [TELECOM_ANZSCO.officer]: officer.title,
  };
  const shared = {
    foundational,
    foundationalHits: found.hits,
    rows,
  };

  if (found.missing.length) {
    const note = missingNote(found.missing);
    return [TELECOM_ANZSCO.planner, TELECOM_ANZSCO.field, TELECOM_ANZSCO.officer].map((code) => {
      const core = code === TELECOM_ANZSCO.planner ? groupG : coreAG;
      const coreHits = code === TELECOM_ANZSCO.planner ? gee.hits : ag.hits;
      return card({
        ...shared,
        code,
        title: titles[code],
        status: "review",
        order: 0,
        recommended: false,
        confidenceScore: 0,
        core,
        coreHits,
        note,
      });
    });
  }

  if (!gee.missing.length) {
    const plannerNote =
      "All six foundational units and all five telecommunications network engineering units are on the transcript. Telecommunications Network Planner is the best fit.";
    const eligibleNote =
      "Eligible, ranked equally. Network Planner is the best fit because every telecommunications network engineering unit is present. The qualification title is not used.";
    return [
      card({
        ...shared,
        code: TELECOM_ANZSCO.planner,
        title: titles[TELECOM_ANZSCO.planner],
        status: "recommended",
        order: 0,
        recommended: true,
        confidenceScore: 100,
        core: groupG,
        coreHits: gee.hits,
        note: plannerNote,
      }),
      card({
        ...shared,
        code: TELECOM_ANZSCO.field,
        title: titles[TELECOM_ANZSCO.field],
        status: "eligible",
        order: 1,
        recommended: false,
        confidenceScore: 100,
        core: coreAG,
        coreHits: ag.hits,
        note: eligibleNote,
      }),
      card({
        ...shared,
        code: TELECOM_ANZSCO.officer,
        title: titles[TELECOM_ANZSCO.officer],
        status: "eligible",
        order: 1,
        recommended: false,
        confidenceScore: 100,
        core: coreAG,
        coreHits: ag.hits,
        note: eligibleNote,
      }),
    ];
  }

  const missingG = gee.missing.map(unitLabel).join("; ");
  const rejectedNote = `Rejected. Telecommunications network engineering units missing: ${missingG}. The qualification title does not qualify Network Planner.`;
  const associates = [TELECOM_ANZSCO.field, TELECOM_ANZSCO.officer].map((code) => {
    const ownSheet = sheetFor(code) ?? field;
    const ownCore = uniqueUnits(GROUP_KEYS.flatMap((key) => unitsIn(ownSheet, key)));
    const own = matchList(ownCore.length ? ownCore : coreAG, cands);
    const coverage = pct(own.matched.length, (ownCore.length ? ownCore : coreAG).length);
    return { code, core: ownCore.length ? ownCore : coreAG, hits: own.hits, coverage };
  });
  const best = Math.max(...associates.map((a) => a.coverage));
  const eligible = associates.map((a) =>
    card({
      ...shared,
      code: a.code,
      title: titles[a.code],
      status: "eligible",
      order: a.coverage === best ? 0 : 1,
      recommended: false,
      confidenceScore: a.coverage,
      core: a.core,
      coreHits: a.hits,
      note: `Eligible. Ranked by core units from Groups A–G: ${a.hits.length} of ${a.core.length} (${a.coverage}%). Network Planner is rejected because a telecommunications network engineering unit is missing.`,
    }),
  );
  return [
    ...eligible,
    card({
      ...shared,
      code: TELECOM_ANZSCO.planner,
      title: titles[TELECOM_ANZSCO.planner],
      status: "rejected",
      order: 2,
      recommended: false,
      confidenceScore: 0,
      core: groupG,
      coreHits: gee.hits,
      note: rejectedNote,
    }),
  ];
}
