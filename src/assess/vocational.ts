import { assessConfig } from "./config.js";
import type { Rubric, VocationalOccupation, VocationalUnitRaw } from "./loadRubric.js";
import { bestSimilarity, normalizeSubjectName } from "./normalize.js";
import {
  normalizeUnitCode,
  splitUnitCode,
  UNIT_CODE_RE,
  type ConfidenceLevel,
  type Determination,
  type ExtractedSubjectRow,
  type QualificationType,
  type SubjectMatch,
  type TierOutcome,
  type UnitMatchType,
  type VocationalAssessmentDetail,
  type VocationalUnitMatch,
} from "./schemas.js";
import type { QualificationCheckResult, ScoreResult } from "./score.js";

/**
 * Vocational (unit-code) scorer, driven entirely by the rubric file
 * (flow "vocational_units"): core units with codes, band thresholds,
 * elective minimum and the flow's determination rules.
 *
 * Core-unit matching, tried in this order for every rubric unit:
 *  1. exact code (uppercase, spaces / dashes removed);
 *  2. same code ignoring a trailing release letter (UEENEEE101A ≈ UEENEEE101B);
 *  3. a code training.gov.au lists as equivalent (superseded / superseding,
 *     stored on the unit as `equivalentCodes`, each with its source page);
 *  4. a known typo of the code (`typoAliases`, e.g. BSBMSB402 for
 *     BSBSMB402) — counted and flagged;
 *  5. title only, for transcript lines that carry no code at all — matched
 *     against the training.gov.au title, lower confidence, flagged.
 *
 * Foundational units (when the rubric lists them) are matched the same way
 * and scored as Tier 1: at or above `noRisk` / `lowRisk` is fine, below is a
 * flag, which caps a verified result at conditional (as on the academic flow).
 * A "pool" core list (312311: Group A–E units) counts matched pool units
 * against the required total; it does not list every unmatched pool unit.
 *
 * Band → 0–100 confidence uses the same bases as the academic scale
 * (computeConfidenceScore): verified 78 + 0.18·core%, conditional
 * 52 + 0.22·core%, otherwise 8 + 0.34·core%; +4 for related work. There is no
 * Tier 3 gate in this flow, so no gate adjustment.
 */

/** Global form of UNIT_CODE_RE for scanning raw transcript text. */
const UNIT_CODE_SCAN_RE = /\b[A-Z]{3}[A-Z]{2,4}\d{3,4}[A-Z]?\b/g;

const TITLE_ONLY_CONFIDENCE = 0.6;
const TITLE_SIMILARITY_MIN = 0.9;

const CONFIDENCE: Record<UnitMatchType, number> = {
  exact: 1,
  release: 0.97,
  equivalent: 0.95,
  typo: 0.9,
  title: TITLE_ONLY_CONFIDENCE,
};

type CodeCandidate = {
  code: string | null;
  name: string;
  row: ExtractedSubjectRow | null;
};

/** Code without a trailing release letter ("UEENEEE101A" → "UEENEEE101"). */
export function stripReleaseLetter(code: string): string {
  return /\d[A-Z]$/.test(code) ? code.slice(0, -1) : code;
}

/** All unit codes printed in raw transcript text, with the rest of the line as the name. */
export function scanUnitCodes(text: string): Array<{ code: string; name: string }> {
  const out: Array<{ code: string; name: string }> = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const codes = [...line.matchAll(UNIT_CODE_SCAN_RE)].map((m) => m[0]);
    for (const code of codes) {
      const name = line
        .replace(UNIT_CODE_SCAN_RE, " ")
        .replace(/[|\t]+/g, " ")
        .replace(/^[\s\-–:()]+|[\s\-–:()]+$/g, "")
        .replace(/\s+/g, " ")
        .slice(0, 160);
      out.push({ code, name: codes.length === 1 ? name : name || code });
    }
  }
  return out;
}

/** True when any row or transcript text carries a training-package unit code. */
export function hasUnitCodes(rows: ExtractedSubjectRow[], texts: readonly string[] = []): boolean {
  return (
    rows.some((r) => {
      const c = normalizeUnitCode(r.code);
      return (c != null && UNIT_CODE_RE.test(c)) || UNIT_CODE_RE.test(r.name);
    }) || texts.some((t) => UNIT_CODE_RE.test(t))
  );
}

function collectCandidates(rows: ExtractedSubjectRow[], texts: readonly string[]): CodeCandidate[] {
  const byCode = new Map<string, CodeCandidate>();
  const titleOnly: CodeCandidate[] = [];
  for (const row of rows) {
    const given = normalizeUnitCode(row.code);
    const split = splitUnitCode(row.name);
    const code = given && UNIT_CODE_RE.test(given) ? given : split.code;
    if (code) {
      if (!byCode.has(code)) byCode.set(code, { code, name: split.name, row });
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

function unitLabel(u: { code: string | null; title: string }): string {
  return `${u.code ?? ""} — ${u.title}`.trim();
}

type UnitMatch = { unit: VocationalUnitRaw; cand: CodeCandidate; type: UnitMatchType; note: string; source?: string };

function matchUnit(
  unit: VocationalUnitRaw,
  cands: CodeCandidate[],
  used: Set<CodeCandidate>,
): UnitMatch | null {
  const code = normalizeUnitCode(unit.code);
  if (!code) return null;
  const free = cands.filter((c) => !used.has(c));
  const coded = free.filter((c) => c.code);

  const exact = coded.find((c) => c.code === code);
  if (exact) return { unit, cand: exact, type: "exact", note: "code matched" };

  const base = stripReleaseLetter(code);
  const release = coded.find((c) => stripReleaseLetter(c.code!) === base);
  if (release) {
    return { unit, cand: release, type: "release", note: `matched ${release.code} (different release of ${code})` };
  }

  for (const eq of unit.equivalentCodes ?? []) {
    const eqCode = normalizeUnitCode(eq.code)!;
    const hit = coded.find(
      (c) => c.code === eqCode || stripReleaseLetter(c.code!) === stripReleaseLetter(eqCode),
    );
    if (hit) {
      const rel = /this unit supersedes/i.test(eq.relation)
        ? "superseded code"
        : /supersedes this unit/i.test(eq.relation)
          ? "newer code"
          : "equivalent code";
      return {
        unit,
        cand: hit,
        type: "equivalent",
        note: `matched via ${rel} ${hit.code} (training.gov.au)`,
        source: eq.source,
      };
    }
  }

  for (const alias of unit.typoAliases ?? []) {
    const a = normalizeUnitCode(alias)!;
    const hit = coded.find((c) => c.code === a);
    if (hit) {
      return {
        unit,
        cand: hit,
        type: "typo",
        note: `${hit.code} treated as ${code} (typo; ${hit.code} does not exist on training.gov.au)`,
      };
    }
  }

  const title = unit.tgaTitle ?? unit.title;
  const byTitle = free.find((c) => !c.code && sameTitle(c.name, title));
  if (byTitle) {
    return { unit, cand: byTitle, type: "title", note: "title-only match (no code on the transcript line); check the unit" };
  }
  return null;
}

/** Band from matched core units and the rubric thresholds (21–24 / 15–20 / 9–14 / 0–8 for 312311; 39–44 / 28–38 / 17–27 / 0–16 for 312211). */
export function coreBand(
  matched: number,
  thresholds: { noRisk: number; lowRisk: number; mediumRisk: number },
): TierOutcome {
  if (matched >= thresholds.noRisk) return "no_risk";
  if (matched >= thresholds.lowRisk) return "low_risk";
  if (matched >= thresholds.mediumRisk) return "medium_risk";
  return "high_risk";
}

const BAND_KEY: Record<string, string> = {
  no_risk: "noRisk",
  low_risk: "lowRisk",
  medium_risk: "medium",
  high_risk: "high",
};

const RULE_RESULT: Record<string, Determination> = {
  verified: "verified_no_risk",
  conditional: "conditional",
  notVerified: "not_verified",
};

/**
 * Core band × elective status → determination, using the flow rules
 * (first match wins). With the elective minimum not set, the elective part
 * of each rule is ignored, so the core band alone decides.
 */
export function vocationalDetermination(
  band: TierOutcome,
  electives: VocationalAssessmentDetail["electiveStatus"],
  rules: VocationalOccupation["determinationRules"],
): Determination {
  const key = BAND_KEY[band] ?? "high";
  const electiveKey = electives === "met" ? "met" : "notMet";
  for (const rule of rules) {
    if (rule.when.coreUnits && !rule.when.coreUnits.includes(key)) continue;
    if (electives !== "not_assessed" && rule.when.electives && !rule.when.electives.includes(electiveKey)) {
      continue;
    }
    const result = RULE_RESULT[rule.result];
    if (result) return result;
  }
  // No rule (should not happen): fall back to the documented band mapping.
  if (band === "high_risk") return "not_verified";
  if (band === "medium_risk") return "conditional";
  return electives === "not_met" ? "conditional" : "verified_no_risk";
}

/** Same bases as computeConfidenceScore, with coverage = core-unit %. */
export function vocationalConfidenceScore(
  determination: Determination,
  corePct: number,
  workExperienceBoost: boolean,
): number {
  let score: number;
  if (determination === "verified_no_risk") score = 78 + corePct * 0.18;
  else if (determination === "conditional") score = 52 + corePct * 0.22;
  else score = 8 + corePct * 0.34;
  if (workExperienceBoost) score += 4;
  return Math.max(0, Math.min(100, Math.round(score)));
}

function confidenceLabel(det: Determination, score: number, boost: boolean, recommended: boolean): ConfidenceLevel | null {
  if (recommended) {
    if (det === "verified_no_risk") return assessConfig.confidence.verified_no_risk;
    if (det === "conditional") {
      return boost ? assessConfig.confidence.conditionalWithBoost : assessConfig.confidence.conditional;
    }
  }
  if (score >= 78) return "high";
  if (score >= 52) return "medium";
  if (score >= 35) return "low";
  return null;
}

/** Tier 1 band from matched Foundational units: noRisk / lowRisk, otherwise a flag. */
export function foundationalBand(
  matched: number,
  thresholds: { noRisk: number; lowRisk: number },
): TierOutcome {
  if (matched >= thresholds.noRisk) return "no_risk";
  if (matched >= thresholds.lowRisk) return "low_risk";
  return "flag";
}

function foundationalThresholds(occ: VocationalOccupation): { noRisk: number; lowRisk: number } | null {
  const f = occ.foundationalUnits;
  if (!f || f.total <= 0) return null;
  return { noRisk: f.thresholds.noRisk ?? f.total, lowRisk: f.thresholds.lowRisk ?? 0 };
}

/** Synthetic Rubric so the existing breakdown / candidate code works unchanged. */
export function vocationalRubric(occ: VocationalOccupation): Rubric {
  const t = bandThresholds(occ);
  const total = occ.coreUnits.total;
  const f = occ.foundationalUnits;
  const ft = foundationalThresholds(occ);
  return {
    anzscoCode: occ.anzsco,
    title: occ.title,
    occupationId: occ.id,
    format: "vocational_units",
    rubricVersion: occ.version,
    qualificationCheck: {
      requirement: occ.qualificationStatement,
      exampleTitles: [],
      levelPolicy: "diploma_ok",
    },
    tiers: {
      tier1:
        f && ft
          ? {
              label: "Foundational units",
              scoreDenominator: f.total,
              subjects: f.units.map((u) => ({
                name: unitLabel(u),
                category: "expected",
                variants: u.tgaTitle && u.tgaTitle !== u.title ? [u.tgaTitle] : [],
              })),
            }
          : { label: "Foundation (not used for unit-code occupations)", scoreDenominator: 0, subjects: [] },
      tier2: {
        label: occ.coreUnits.mode === "pool" ? `Core units (any ${total} of ${occ.coreUnits.units.length})` : "Core units",
        scoreDenominator: total,
        subjects: occ.coreUnits.units.map((u) => ({
          name: unitLabel(u),
          category: "core",
          variants: u.tgaTitle && u.tgaTitle !== u.title ? [u.tgaTitle] : [],
        })),
      },
      tier3: { label: "Electives", subjects: [] },
    },
    riskScoring: {
      tier1:
        f && ft
          ? {
              thresholds: [
                { matchedRange: [ft.noRisk, f.total], outcome: "no_risk", label: "No Risk" },
                { matchedRange: [ft.lowRisk, ft.noRisk - 1], outcome: "low_risk", label: "Low Risk" },
                { matchedRange: [0, ft.lowRisk - 1], outcome: "flag", label: "Flag" },
              ],
            }
          : { thresholds: [{ matchedRange: [0, 0], outcome: "no_risk", label: "Not used" }] },
      tier2: {
        thresholds: [
          { matchedRange: [t.noRisk, total], outcome: "no_risk", label: "No Risk" },
          { matchedRange: [t.lowRisk, t.noRisk - 1], outcome: "low_risk", label: "Low Risk" },
          { matchedRange: [t.mediumRisk, t.lowRisk - 1], outcome: "medium_risk", label: "Medium Risk" },
          { matchedRange: [0, t.mediumRisk - 1], outcome: "high_risk", label: "High Risk" },
        ],
      },
      overallDetermination: { combinationTable: [] },
    },
  };
}

function bandThresholds(occ: VocationalOccupation) {
  const th = occ.coreUnits.thresholds;
  return {
    noRisk: th.noRisk ?? occ.coreUnits.total,
    lowRisk: th.lowRisk ?? 0,
    mediumRisk: th.medium ?? th.mediumRisk ?? 0,
  };
}

export type VocationalScore = {
  rubric: Rubric;
  scored: ScoreResult;
  matches: SubjectMatch[];
  unmatched: ExtractedSubjectRow[];
  detail: VocationalAssessmentDetail;
};

/** Score one vocational occupation from extracted rows + raw transcript text. */
export function scoreVocational(input: {
  occupation: VocationalOccupation;
  rows: ExtractedSubjectRow[];
  transcriptTexts?: readonly string[];
  workExperienceBoost: boolean;
  /** Does the qualification route point at this occupation (e.g. UEE62122)? */
  qualificationMet: boolean;
  qualificationNote: string;
  /** Route cap (from Step 1 routing), merged with the qualification result. */
  qualificationCheck?: QualificationCheckResult;
}): VocationalScore {
  const occ = input.occupation;
  const rubric = vocationalRubric(occ);
  const thresholds = bandThresholds(occ);
  const cands = collectCandidates(input.rows, input.transcriptTexts ?? []);
  const used = new Set<CodeCandidate>();
  const flags: string[] = [];

  const unitMatches: UnitMatch[] = [];
  for (const unit of occ.coreUnits.units) {
    const m = matchUnit(unit, cands, used);
    if (m) {
      used.add(m.cand);
      unitMatches.push(m);
    }
  }

  const matchedCore: VocationalUnitMatch[] = unitMatches.map((m) => ({
    unitId: m.unit.id,
    code: m.unit.code!,
    title: m.unit.title,
    transcriptCode: m.cand.code,
    transcriptName: m.cand.name,
    matchType: m.type,
    note: m.note,
    confidence: CONFIDENCE[m.type],
    ...(m.source ? { source: m.source } : {}),
  }));
  for (const m of matchedCore) {
    if (m.matchType === "typo") flags.push(`${m.code}: ${m.note}.`);
    if (m.matchType === "title") flags.push(`${m.code}: matched on title only ("${m.transcriptName}") — confirm the unit.`);
  }

  // Foundational units (Tier 1), matched after the core units with the same rules.
  const foundationalMatches: UnitMatch[] = [];
  for (const unit of occ.foundationalUnits?.units ?? []) {
    const m = matchUnit(unit, cands, used);
    if (m) {
      used.add(m.cand);
      foundationalMatches.push(m);
    }
  }
  const toUnitMatch = (m: UnitMatch): VocationalUnitMatch => ({
    unitId: m.unit.id,
    code: m.unit.code!,
    title: m.unit.title,
    transcriptCode: m.cand.code,
    transcriptName: m.cand.name,
    matchType: m.type,
    note: m.note,
    confidence: CONFIDENCE[m.type],
    ...(m.source ? { source: m.source } : {}),
  });
  const matchedFoundational = foundationalMatches.map(toUnitMatch);
  for (const m of matchedFoundational) {
    if (m.matchType === "typo") flags.push(`${m.code}: ${m.note}.`);
    if (m.matchType === "title") flags.push(`${m.code}: matched on title only ("${m.transcriptName}") — confirm the unit.`);
  }
  const missingFoundational = (occ.foundationalUnits?.units ?? [])
    .filter((u) => !foundationalMatches.some((m) => m.unit === u))
    .map((u) => ({ unitId: u.id, code: u.code ?? "", title: u.title }));

  const pool = occ.coreUnits.mode === "pool";
  // A pool lists far more units than any one student takes: unmatched pool units are not "missing".
  const missingCore = pool
    ? []
    : occ.coreUnits.units
        .filter((u) => !unitMatches.some((m) => m.unit === u))
        .map((u) => ({ unitId: u.id, code: u.code ?? "", title: u.title }));

  // Codes training.gov.au maps without equivalence: shown, never counted.
  const nonEquivalent = new Map<string, string>();
  for (const u of [...occ.coreUnits.units, ...(occ.foundationalUnits?.units ?? [])]) {
    for (const ne of u.nonEquivalentCodes ?? []) nonEquivalent.set(normalizeUnitCode(ne.code)!, u.code ?? "");
  }
  const electivesFound: Array<{ code: string; name: string }> = [];
  for (const c of cands) {
    if (!c.code || used.has(c)) continue;
    const of = nonEquivalent.get(c.code) ?? nonEquivalent.get(stripReleaseLetter(c.code));
    if (of) {
      flags.push(
        `${c.code} found: training.gov.au maps it to unit ${of} but NOT as equivalent, so it is not counted; assessor to review.`,
      );
      continue;
    }
    electivesFound.push({ code: c.code, name: c.name });
  }

  const coreMatched = matchedCore.length;
  const coreTotal = occ.coreUnits.total;
  const band = coreBand(coreMatched, thresholds);
  if (pool) {
    flags.push(
      `Core units are a pool: ${coreMatched} of the ${occ.coreUnits.units.length} listed units found, counted against ${coreTotal} required.`,
    );
  }
  const fThresholds = foundationalThresholds(occ);
  const foundationalTotal = fThresholds ? occ.foundationalUnits!.total : 0;
  const foundationalMatched = matchedFoundational.length;
  const tier1Band: TierOutcome = fThresholds ? foundationalBand(foundationalMatched, fThresholds) : "no_risk";
  const minimum = occ.electives.minimumUnits;
  const electiveStatus: VocationalAssessmentDetail["electiveStatus"] =
    minimum == null ? "not_assessed" : electivesFound.length >= minimum ? "met" : "not_met";
  const electiveNote =
    minimum == null
      ? "Not assessed – minimum not set. The core-unit band alone decides; check the electives against the qualification packaging rules."
      : `${electivesFound.length} of the ${minimum} required elective units found (${electiveStatus === "met" ? "met" : "not met"}).`;
  if (minimum == null) flags.push("Elective minimum not set in the rubric: electives not assessed.");

  const coreDetermination = vocationalDetermination(band, electiveStatus, occ.determinationRules);
  // Tier 1 flag (too few Foundational units) caps verified at conditional.
  const tier1Capped = tier1Band === "flag" && coreDetermination === "verified_no_risk";
  if (fThresholds && tier1Band === "flag") {
    flags.push(
      `Foundational units: ${foundationalMatched} of ${foundationalTotal} found (below ${fThresholds.lowRisk}); verified is capped at conditional.`,
    );
  }
  const bandDetermination: Determination = tier1Capped ? "conditional" : coreDetermination;
  const qualificationNotes = [...(input.qualificationCheck?.notes ?? [])];
  const capQualification = !input.qualificationMet;
  if (capQualification && !qualificationNotes.includes(input.qualificationNote)) {
    qualificationNotes.push(input.qualificationNote);
  }
  const capped =
    (capQualification || Boolean(input.qualificationCheck?.capAtConditional)) &&
    bandDetermination === "verified_no_risk";
  const determination: Determination = capped ? "conditional" : bandDetermination;
  const recommended = (assessConfig.recommendOn as readonly string[]).includes(determination);
  const corePct = coreTotal > 0 ? Math.min(100, Math.round((coreMatched / coreTotal) * 1000) / 10) : 0;
  const foundationalPct =
    foundationalTotal > 0 ? Math.round((foundationalMatched / foundationalTotal) * 1000) / 10 : 0;
  const confidenceScore = vocationalConfidenceScore(determination, corePct, input.workExperienceBoost);

  const matchedCands = new Set([...unitMatches, ...foundationalMatches].map((m) => m.cand));
  const foundationalSubjectMatches: SubjectMatch[] = foundationalMatches.map((m) => ({
    transcriptName: m.cand.code ? `${m.cand.code} ${m.cand.name}`.trim() : m.cand.name,
    transcriptCode: m.cand.code,
    qualification: (m.cand.row?.qualification ?? "unknown") as QualificationType,
    rubricSubject: unitLabel(m.unit),
    tier: "tier1",
    category: "expected",
    method: m.type === "title" ? "fuzzy" : "exact",
    confidence: CONFIDENCE[m.type],
    reason: m.note,
  }));
  const coreSubjectMatches: SubjectMatch[] = unitMatches.map((m) => ({
    transcriptName: m.cand.code ? `${m.cand.code} ${m.cand.name}`.trim() : m.cand.name,
    transcriptCode: m.cand.code,
    qualification: (m.cand.row?.qualification ?? "unknown") as QualificationType,
    rubricSubject: unitLabel(m.unit),
    tier: "tier2",
    category: "core",
    method: m.type === "title" ? "fuzzy" : "exact",
    confidence: CONFIDENCE[m.type],
    reason: m.note,
  }));
  const matches: SubjectMatch[] = [...foundationalSubjectMatches, ...coreSubjectMatches];
  const unmatched = input.rows.filter((r) => !cands.some((c) => c.row === r && matchedCands.has(c)));

  const detail: VocationalAssessmentDetail = {
    occupationId: occ.id,
    qualificationCodes: occ.qualificationCodes,
    coreMatched,
    coreTotal,
    coreBand: band,
    thresholds,
    matchedCore,
    missingCore,
    electivesFound,
    electiveStatus,
    electiveMinimum: minimum,
    electiveNote,
    qualificationMet: input.qualificationMet,
    qualificationNote: input.qualificationNote,
    flags,
    coreMode: pool ? "pool" : "all",
    ...(fThresholds
      ? {
          foundationalMatched,
          foundationalTotal,
          foundationalBand: tier1Band,
          foundationalThresholds: fThresholds,
          matchedFoundational,
          missingFoundational,
        }
      : {}),
  };

  const scored: ScoreResult = {
    foundationalMatched,
    foundationalExpected: foundationalTotal,
    foundationalPct,
    coreMatched,
    coreExpected: coreTotal,
    corePct,
    tier1Outcome: tier1Band,
    tier2Outcome: band,
    tier3GateMet: false,
    determination: recommended ? determination : "no_match",
    recommended,
    confidence: recommended
      ? confidenceLabel(determination, confidenceScore, input.workExperienceBoost, true)
      : null,
    confidenceScore,
    capstoneApplies: false,
    anzscoCode: recommended ? occ.anzsco : null,
    title: recommended ? occ.title : null,
    qualificationNotes,
    qualificationCapped: capped,
    bandDetermination: determination,
    gateDowngraded: false,
    routeCapped: capped && !capQualification && Boolean(input.qualificationCheck?.routeCapped),
  };
  return { rubric, scored, matches, unmatched, detail };
}
