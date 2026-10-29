/**
 * Gate 1: qualification eligibility, decided BEFORE any scoring.
 *
 * Rules are checked top to bottom and the first match decides:
 *  1. Not engineering, counted duration under 2 years, or certificate-level
 *     only → NOT ELIGIBLE (nothing is scored).
 *  2. Unusual case → MANUAL REVIEW (nothing is scored): a Diploma (AQF 5); a
 *     3-year degree from a programme / country that may be recognised higher
 *     (config hook); a combined degree (3+2); a non-engineering bachelor
 *     followed by an engineering master; an engineering master (or doctorate)
 *     with no bachelor on file; part-time, bridging or credit-transfer study;
 *     stated vs counted duration differing by more than the tolerance.
 *  3. Engineering Bachelor / Honours / Master counted ≥ 4 years → Professional
 *     Engineer (priority 1) + Engineering Technologist (priority 2).
 *  4. Engineering Bachelor counted 3 to < 4 years → Engineering Technologist only.
 *  5. Advanced Diploma / Associate Degree counted ≥ 2 years → Engineering Associate only.
 *
 * With several qualifications the highest-level engineering qualification is
 * used (durations are never added together). The counted duration comes from
 * the printed years / semesters; when the transcript does not print them, the
 * stated duration is used and the result carries a fallback flag.
 *
 * Detection is heuristic (titles, training-package codes, transcript text):
 * no schema change, no LLM call.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { evidenceConfig } from "./evidenceConfig.js";
import { degreeLevelFromTitle } from "./extractSubjects.js";
import type { VocationalOccupation } from "./loadRubric.js";
import type { QualificationInfo } from "./qualificationCheck.js";
import { countDuration, decideEngineering, isReliableCount } from "./qualificationEvidence.js";
import { classifyQualification, findQualificationCodes } from "./route.js";
import type {
  EngineeringDecision,
  ExtractedSubjectRow,
  Gate1AwardLevel,
  Gate1Decision,
  Gate1Qualification,
  Gate1Track,
  Gate1TrackId,
} from "./schemas.js";

// ---------------------------------------------------------------------------
// Tracks (from src/lib/anzsco_skill_levels.json)
// ---------------------------------------------------------------------------

type SkillLevelsFile = {
  occupations: Array<{ anzscoCode: string; occupation: string; category: string; skillLevel: number }>;
};

const CATEGORY_TO_TRACK: Record<string, Gate1TrackId> = {
  "Professional Engineer": "professional_engineer",
  "Engineering Technologist": "engineering_technologist",
  "Engineering Associate": "engineering_associate",
};

export const TRACK_LABELS: Record<Gate1TrackId, string> = {
  professional_engineer: "Professional Engineer",
  engineering_technologist: "Engineering Technologist",
  engineering_associate: "Engineering Associate",
};

const TRACK_ORDER: Gate1TrackId[] = [
  "professional_engineer",
  "engineering_technologist",
  "engineering_associate",
];

let skillLevels: SkillLevelsFile | null = null;
function loadSkillLevels(): SkillLevelsFile {
  if (!skillLevels) {
    const here = dirname(fileURLToPath(import.meta.url));
    const path = resolve(here, "../lib/anzsco_skill_levels.json");
    skillLevels = JSON.parse(readFileSync(path, "utf8")) as SkillLevelsFile;
  }
  return skillLevels;
}

export function trackOccupations(track: Gate1TrackId): Array<{ anzscoCode: string; occupation: string }> {
  return loadSkillLevels().occupations.filter((o) => CATEGORY_TO_TRACK[o.category] === track);
}

/** Track an ANZSCO code belongs to (null when not an Engineers Australia occupation). */
export function trackForAnzsco(anzscoCode: string): Gate1TrackId | null {
  const code = anzscoCode.replace(/\s+/g, "");
  const occ = loadSkillLevels().occupations.find((o) => o.anzscoCode === code);
  return occ ? (CATEGORY_TO_TRACK[occ.category] ?? null) : null;
}

// ---------------------------------------------------------------------------
// Award level / AQF
// ---------------------------------------------------------------------------

export const AQF: Record<Gate1AwardLevel, number | null> = {
  certificate: 4,
  diploma: 5,
  advanced_diploma: 6,
  associate_degree: 6,
  bachelor: 7,
  honours: 8,
  graduate_diploma: 8,
  master: 9,
  doctorate: 10,
  unknown: null,
};

const ROMAN_CERT: Record<string, number> = { i: 1, ii: 2, iii: 3, iv: 4, "1": 1, "2": 2, "3": 3, "4": 4 };

/** Award level + AQF level of one qualification. */
export function awardLevelOf(
  q: Pick<QualificationInfo, "level" | "title" | "rawLevel" | "texts" | "awardOverride">,
): {
  award: Gate1AwardLevel;
  aqfLevel: number | null;
} {
  // Award level chosen by the assessor (Upload & details / Verify details).
  if (q.awardOverride && q.awardOverride in AQF) {
    return { award: q.awardOverride, aqfLevel: AQF[q.awardOverride] };
  }
  return detectAwardLevel(q);
}

/** Award level read from the title, DB level and qualification codes (no override). */
export function detectAwardLevel(q: Pick<QualificationInfo, "level" | "title" | "rawLevel" | "texts">): {
  award: Gate1AwardLevel;
  aqfLevel: number | null;
} {
  const title = (q.title ?? "").trim();
  const t = title.toLowerCase();
  const titleLevel = degreeLevelFromTitle(title);
  const codeDigit = (() => {
    const codes = findQualificationCodes(title);
    const fromTexts = codes.length ? codes : (q.texts ?? []).flatMap((x) => findQualificationCodes(x));
    const digits = [...new Set(fromTexts.map((c) => Number(c[3])))].filter((d) => d >= 1 && d <= 8);
    return digits.length === 1 ? digits[0] : null;
  })();
  const out = (award: Gate1AwardLevel, aqf: number | null = AQF[award]) => ({ award, aqfLevel: aqf });

  if (q.rawLevel === "phd" || /\b(?:ph\.?\s?d|doctor\s+of|doctorate|d\.?\s?eng)\b/.test(t)) {
    return out("doctorate");
  }
  if (/\b(?:post\s*-?\s*graduate|graduate)\s+(?:diploma|certificate)\b/.test(t)) {
    return out("graduate_diploma");
  }
  const degreeInTitle = titleLevel === "bachelor" || titleLevel === "master";
  const certMatch = /\bcert(?:ificate)?\.?\s*(iv|iii|ii|i|[1-4])?\b/.exec(t);
  if (!degreeInTitle && certMatch) {
    const n = certMatch[1] ? ROMAN_CERT[certMatch[1]] : null;
    return out("certificate", n ?? 4);
  }
  if (!degreeInTitle && !titleLevel && codeDigit != null && codeDigit <= 4) {
    return out("certificate", codeDigit);
  }
  if (titleLevel === "master" || (q.level === "master" && titleLevel !== "bachelor")) return out("master");
  if (titleLevel === "bachelor" || q.level === "bachelor") {
    return /\bhon(?:ou)?rs?\b|\bhons\b/.test(t) ? out("honours") : out("bachelor");
  }
  if (q.level === "associate_degree" || titleLevel === "associate_degree") return out("associate_degree");
  if (q.level === "advanced_diploma" || titleLevel === "advanced_diploma") return out("advanced_diploma");
  if (q.level === "diploma" || titleLevel === "diploma") {
    if (codeDigit === 6) return out("advanced_diploma");
    if (codeDigit === 8) return out("graduate_diploma");
    return out("diploma");
  }
  if (codeDigit === 5) return out("diploma");
  if (codeDigit === 6) return out("advanced_diploma");
  if (codeDigit === 8) return out("graduate_diploma");
  return out("unknown");
}

const isDegreeAward = (a: Gate1AwardLevel) =>
  a === "bachelor" || a === "honours" || a === "master" || a === "doctorate";
const isPostgraduate = (a: Gate1AwardLevel) =>
  a === "master" || a === "doctorate" || a === "graduate_diploma";

// ---------------------------------------------------------------------------
// Unusual-case flags (heuristic)
// ---------------------------------------------------------------------------

export const FLAG = {
  combined: "combined / integrated degree (3+2)",
  partTime: "part-time study",
  bridging: "bridging / lateral-entry study",
  creditTransfer: "credit transfer / advanced standing",
  recognisedHigher: "3-year degree that may be recognised at a higher level",
} as const;

const COMBINED_TITLE_RE =
  /\b(?:integrated|dual[\s-]degree|double[\s-]degree|combined[\s-]degree)\b|\b(?:b\.?\s?(?:e|eng|tech|sc)|bachelor)\b\.?[^,;]*?(?:[/&+]|\band\b|-)\s*(?:m\.?\s?(?:e|eng|tech|sc)|master)\b/i;
const COMBINED_TEXT_RE = /\b(?:integrated|dual|double|combined)\s+(?:degree|programme|program|course)\b|\b3\s*\+\s*2\b/i;
const PART_TIME_TITLE_RE = /\bpart[\s-]?time\b/i;
const PART_TIME_TEXT_RE =
  /\b(?:mode(?:\s+of\s+(?:study|attendance))?|attendance(?:\s+(?:mode|type))?|study\s+(?:mode|load|type)|enrol(?:l)?ment(?:\s+(?:type|status))?|load|status)\s*[:\-]?\s*part[\s-]?time\b|\bpart[\s-]?time\s+(?:student|study|programme|program|course|basis|mode)\b/i;
const BRIDGING_TITLE_RE = /\b(?:bridging|lateral\s+entry|top[\s-]?up|conversion)\b/i;
const BRIDGING_TEXT_RE =
  /\blateral\s+entry\b|\bbridging\s+(?:course|program(?:me)?|study|studies|subject|unit)s?\b|\bdirect\s+(?:second|2nd|third|3rd)[\s-]year\s+(?:entry|admission)\b/i;
const CREDIT_TITLE_RE = /\bcredit\s+transfer\b|\badvanced\s+standing\b/i;
const CREDIT_TEXT_RE =
  /\b(?:credit\s+transfer|advanced\s+standing|exemptions?)\s+(?:granted|awarded|approved|given)\b|\b(?:granted|awarded|approved)\s+(?:credit\s+transfer|advanced\s+standing|exemptions?)\b/i;
const CREDIT_GRADE_RE =
  /^(?:ct|crt|credit\s*transfer(?:red)?|transfer(?:red)?(?:\s+credit)?|advanced\s+standing|adv\.?\s*st(?:anding)?|ex|exe|exempt(?:ed|ion)?|rpl|recogni[sz]ed\s+prior\s+learning)$/i;
const CREDIT_NAME_RE = /\b(?:credit\s+transfer|advanced\s+standing|exempt(?:ed|ion)?|rpl)\b/i;
/** Rows with a credit-transfer grade / name at or above which the flag is raised. */
const CREDIT_ROWS_MIN = 2;

function flagsFor(
  q: QualificationInfo,
  rows: readonly ExtractedSubjectRow[],
): string[] {
  const title = q.title ?? "";
  const texts = q.texts ?? [];
  const anyText = (re: RegExp) => texts.some((t) => re.test(t));
  const flags: string[] = [];
  if (COMBINED_TITLE_RE.test(title) || anyText(COMBINED_TEXT_RE)) flags.push(FLAG.combined);
  if (PART_TIME_TITLE_RE.test(title) || anyText(PART_TIME_TEXT_RE)) flags.push(FLAG.partTime);
  if (BRIDGING_TITLE_RE.test(title) || anyText(BRIDGING_TEXT_RE)) flags.push(FLAG.bridging);
  const creditRows = rows.filter(
    (r) => CREDIT_GRADE_RE.test((r.grade ?? "").trim()) || CREDIT_NAME_RE.test(r.name ?? ""),
  ).length;
  if (CREDIT_TITLE_RE.test(title) || anyText(CREDIT_TEXT_RE) || creditRows >= CREDIT_ROWS_MIN) {
    flags.push(FLAG.creditTransfer);
  }
  return flags;
}

/** Config hook: does this qualification match a "may be recognised higher" entry? */
export function matchesRecognisedHigher(
  q: Pick<QualificationInfo, "title" | "country" | "institution">,
  entries: typeof evidenceConfig.gate.recognisedHigherProgrammes = evidenceConfig.gate.recognisedHigherProgrammes,
): string | null {
  const has = (hay: string | null | undefined, needle: string) =>
    (hay ?? "").toLowerCase().includes(needle.toLowerCase());
  for (const e of entries) {
    if (!e.titlePattern && !e.country && !e.institution) continue;
    let ok = true;
    if (e.titlePattern) {
      try {
        ok &&= new RegExp(e.titlePattern, "i").test(q.title ?? "");
      } catch {
        ok = false;
      }
    }
    if (e.country) ok &&= has(q.country, e.country);
    if (e.institution) ok &&= has(q.institution, e.institution);
    if (ok) return e.note ?? FLAG.recognisedHigher;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

export type Gate1Input = {
  qualifications: readonly QualificationInfo[];
  rows: readonly ExtractedSubjectRow[];
  /** Step 2 checkbox (assessor confirmed an engineering-titled degree). */
  engineeringTitledDegree?: boolean | null;
  vocational?: readonly VocationalOccupation[];
  /** ANZSCO codes that have an academic scoring rubric (for "assess manually" notes). */
  rubricCodes?: readonly string[];
};

type QualEval = {
  q: QualificationInfo;
  award: Gate1AwardLevel;
  aqf: number | null;
  engineering: EngineeringDecision;
  stated: number | null;
  counted: number | null;
  used: number | null;
  source: "counted" | "stated" | "none";
  /** True when the counted duration was entered by the assessor. */
  manualCount: boolean;
  method: string;
  mismatch: boolean;
  flags: string[];
};

type Outcome =
  | { kind: "open"; rule: 3 | 4 | 5; reason: string }
  | { kind: "manual"; reason: string }
  | { kind: "fail"; reason: string }
  | { kind: "skip"; reason: string };

const EPS = 1e-9;
const yrs = (n: number) => `${n} year${n === 1 ? "" : "s"}`;
const label = (e: QualEval) => e.q.title?.trim() || AWARD_LABELS[e.award];

export const AWARD_LABELS: Record<Gate1AwardLevel, string> = {
  certificate: "Certificate",
  diploma: "Diploma",
  advanced_diploma: "Advanced Diploma",
  associate_degree: "Associate Degree",
  bachelor: "Bachelor",
  honours: "Honours degree",
  graduate_diploma: "Graduate Diploma / Certificate",
  master: "Master",
  doctorate: "Doctorate",
  unknown: "Qualification (level not identified)",
};

export const RULE_LABELS: Record<1 | 2 | 3 | 4 | 5, string> = {
  1: "Rule 1: not eligible (not engineering, under 2 years, or certificate only)",
  2: "Rule 2: unusual case, manual review",
  3: "Rule 3: engineering Bachelor / Honours / Master, 4 years or more",
  4: "Rule 4: engineering Bachelor, 3 to under 4 years",
  5: "Rule 5: Advanced Diploma / Associate Degree, 2 years or more",
};

function basisLabel(e: Pick<QualEval, "source" | "manualCount">): string {
  if (e.source !== "counted") return "stated duration";
  return e.manualCount ? "counted duration entered manually" : "counted from the transcript";
}

/** Title used for the engineering title signal: degree title plus field of study. */
function withFieldOfStudy(q: QualificationInfo): QualificationInfo {
  const field = q.fieldOfStudy?.trim();
  const title = q.title?.trim() ?? "";
  if (!field || title.toLowerCase().includes(field.toLowerCase())) return q;
  return { ...q, title: title ? `${title} (${field})` : field };
}

export function rowsFor(
  q: QualificationInfo,
  rows: readonly ExtractedSubjectRow[],
  single: boolean,
): ExtractedSubjectRow[] {
  return rows.filter(
    (r) =>
      (q.level !== "unknown" && r.qualification === q.level) ||
      (single && r.qualification === "unknown"),
  );
}

function evaluateQualification(
  q: QualificationInfo,
  input: Gate1Input,
  single: boolean,
  degreeCount: number,
): QualEval {
  const { award, aqfLevel } = awardLevelOf(q);
  const rows = rowsFor(q, input.rows, single);
  const routed = classifyQualification(
    { level: q.level, rawLevel: q.rawLevel, title: q.title, texts: q.texts },
    input.vocational ?? [],
  );
  // The Step 2 tick says "an engineering-titled degree": apply it to a degree
  // when it is the only degree, or when the degree has no title on file.
  const tickApplies =
    input.engineeringTitledDegree === true &&
    isDegreeAward(award) &&
    (degreeCount === 1 || !q.title?.trim());
  const engineering = decideEngineering({
    qualifications: [withFieldOfStudy(q)],
    rows,
    relatedField: routed.route === "vocational" || routed.route === "draftsperson_academic",
    engineeringTitledDegree: tickApplies ? true : null,
    subjectShareOverride: q.engineeringShareOverride ?? null,
  });
  const count = countDuration(rows);
  // A counted duration entered by the assessor (Transcript data / Verify
  // details) replaces the transcript count.
  const manualCount = q.countedYearsOverride ?? null;
  const counted = manualCount ?? (isReliableCount(count) ? count.countedYears : null);
  const stated = q.durationYears ?? null;
  const used = counted ?? stated;
  const source = counted != null ? "counted" : stated != null ? "stated" : "none";
  const tol = evidenceConfig.duration.toleranceYears;
  const mismatch = counted != null && stated != null && Math.abs(counted - stated) > tol + EPS;
  return {
    q,
    award,
    aqf: aqfLevel,
    engineering,
    stated,
    counted,
    used,
    source,
    manualCount: manualCount != null,
    method:
      manualCount != null
        ? `entered manually (transcript count: ${count.countedYears != null ? yrs(count.countedYears) : "none"})`
        : count.method,
    mismatch,
    flags: flagsFor(q, rows),
  };
}

function outcomeFor(e: QualEval, all: readonly QualEval[]): Outcome {
  const g = evidenceConfig.gate;
  const name = label(e);
  const d = e.used;
  const basis = basisLabel(e);
  if (e.award === "certificate") {
    return { kind: "fail", reason: `"${name}" is certificate level (below AQF 5).` };
  }
  if (isPostgraduate(e.award) && !(d != null && isDegreeAward(e.award) && d >= g.professionalMinYears - EPS)) {
    // Decision (b): a postgraduate engineering award is judged together with
    // the bachelor; with no bachelor on file it goes to manual review.
    const bachelorOnFile = all.some((o) => o.award === "bachelor" || o.award === "honours");
    if (!bachelorOnFile) {
      return {
        kind: "manual",
        reason: `engineering ${AWARD_LABELS[e.award]} "${name}" with no bachelor on file.`,
      };
    }
    return { kind: "skip", reason: `${AWARD_LABELS[e.award]}: the bachelor on file decides.` };
  }
  if (d == null) {
    return {
      kind: "manual",
      reason: `the duration of "${name}" is not stated and could not be counted from the transcript.`,
    };
  }
  if (d < g.notEligibleBelowYears - EPS) {
    return { kind: "fail", reason: `"${name}" is under ${g.notEligibleBelowYears} years (${yrs(d)}, ${basis}).` };
  }
  if (e.mismatch) {
    return {
      kind: "manual",
      reason: `stated duration (${yrs(e.stated!)}) and counted duration (${yrs(e.counted!)}) of "${name}" differ by more than ${evidenceConfig.duration.toleranceYears} years.`,
    };
  }
  if (e.award === "diploma") {
    return { kind: "manual", reason: `"${name}" is a Diploma (AQF 5).` };
  }
  const higher = e.award === "bachelor" || e.award === "honours" ? matchesRecognisedHigher(e.q) : null;
  if (higher && d >= g.technologistMinYears - EPS && d < g.professionalMinYears - EPS) {
    return { kind: "manual", reason: `"${name}" is a 3-year degree that may be recognised at a higher level (${higher}).` };
  }
  if (isDegreeAward(e.award) && d >= g.professionalMinYears - EPS) {
    return {
      kind: "open",
      rule: 3,
      reason: `"${name}" is an engineering ${AWARD_LABELS[e.award]} of ${yrs(d)} (${basis}).`,
    };
  }
  if (e.award === "bachelor" || e.award === "honours") {
    if (d >= g.technologistMinYears - EPS) {
      return {
        kind: "open",
        rule: 4,
        reason: `"${name}" is an engineering ${AWARD_LABELS[e.award]} of ${yrs(d)} (${basis}).`,
      };
    }
    return {
      kind: "manual",
      reason: `engineering ${AWARD_LABELS[e.award]} "${name}" is only ${yrs(d)} (possible top-up or bridging degree).`,
    };
  }
  if (e.award === "advanced_diploma" || e.award === "associate_degree") {
    if (d >= g.associateMinYears - EPS) {
      return {
        kind: "open",
        rule: 5,
        reason: `"${name}" is an engineering ${AWARD_LABELS[e.award]} of ${yrs(d)} (${basis}).`,
      };
    }
  }
  return { kind: "manual", reason: `the level of "${name}" could not be identified.` };
}

function trackNotes(track: Gate1TrackId, input: Gate1Input): string[] {
  const notes: string[] = [];
  const rubricCodes = new Set(input.rubricCodes ?? []);
  const vocational = input.vocational ?? [];
  for (const o of trackOccupations(track)) {
    const voc = vocational.find((v) => v.anzsco === o.anzscoCode);
    if (rubricCodes.has(o.anzscoCode)) continue;
    if (voc?.scoringEnabled) continue;
    notes.push(
      voc
        ? `${o.occupation} (${o.anzscoCode}): unit-code scoring is not switched on yet (${voc.disabledReason ?? "rubric incomplete"}); assess manually.`
        : `${o.occupation} (${o.anzscoCode}): no scoring rubric yet; assess manually.`,
    );
  }
  return input.rubricCodes ? notes : [];
}

const BELOW_PE =
  "Below the minimum level and duration required for Professional Engineer assessment (an engineering Bachelor, Honours or Master of at least 4 years).";
const BELOW_TECH =
  "Below the minimum level and duration required for Engineering Technologist assessment (an engineering Bachelor of at least 3 years).";

function buildTracks(rule: 1 | 2 | 3 | 4 | 5, input: Gate1Input, blockedReason: string): Gate1Track[] {
  const open: Partial<Record<Gate1TrackId, { priority: number; reason: string }>> = {};
  const closed: Partial<Record<Gate1TrackId, string>> = {};
  if (rule === 3) {
    open.professional_engineer = { priority: 1, reason: "4-year engineering qualification: assess first." };
    open.engineering_technologist = { priority: 2, reason: "Also open (a 4-year degree meets the 3-year minimum)." };
    closed.engineering_associate =
      "Not assessed: the qualification meets the Professional Engineer level (Associate is for Advanced Diploma / Associate Degree qualifications).";
  } else if (rule === 4) {
    open.engineering_technologist = { priority: 1, reason: "3-year engineering bachelor." };
    closed.professional_engineer = BELOW_PE;
    closed.engineering_associate = "Not assessed: the qualification meets the Engineering Technologist level.";
  } else if (rule === 5) {
    open.engineering_associate = { priority: 1, reason: "Engineering Advanced Diploma / Associate Degree of 2 years or more." };
    closed.professional_engineer = BELOW_PE;
    closed.engineering_technologist = BELOW_TECH;
  }
  return TRACK_ORDER.map((track) => {
    const o = open[track];
    return {
      track,
      label: TRACK_LABELS[track],
      open: Boolean(o),
      priority: o?.priority ?? null,
      reason: o?.reason ?? closed[track] ?? `Not assessed: ${blockedReason}`,
      anzscoCodes: trackOccupations(track).map((x) => x.anzscoCode),
      notes: o ? trackNotes(track, input) : [],
    };
  });
}

export function evaluateGate1(input: Gate1Input): Gate1Decision {
  const quals = input.qualifications;
  const single = quals.length === 1;
  const degreeCount = quals.filter((q) => isDegreeAward(awardLevelOf(q).award)).length;
  const evals = quals.map((q) => evaluateQualification(q, input, single, degreeCount));
  const outcomes = new Map<QualEval, Outcome>();
  const notes: string[] = [];

  const finish = (
    result: Gate1Decision["result"],
    rule: 1 | 2 | 3 | 4 | 5,
    reason: string,
    usedEval: QualEval | null,
  ): Gate1Decision => {
    const fallback = usedEval ? usedEval.source === "stated" : false;
    const blocked =
      result === "not_eligible" ? "Gate 1 result is not eligible." : "Gate 1 needs manual review.";
    return {
      result,
      rule,
      ruleLabel: RULE_LABELS[rule],
      reason,
      qualificationUsed: usedEval ? label(usedEval) : null,
      tracks: buildTracks(rule, input, blocked),
      qualifications: evals.map((e) => ({
        title: e.q.title?.trim() || null,
        level: e.q.level,
        award: e.award,
        aqfLevel: e.aqf,
        engineering: e.engineering.decision,
        engineeringReason: e.engineering.reason,
        statedYears: e.stated,
        countedYears: e.counted,
        durationYears: e.used,
        durationSource: e.source,
        durationMethod: e.method,
        flags: [...e.flags, ...(e.mismatch ? ["stated and counted duration differ"] : [])],
        used: e === usedEval,
        outcome: outcomeText(e, outcomes.get(e)),
      })),
      durationFallback: fallback,
      fallbackNote: fallback
        ? `Duration taken from the stated programme length (${yrs(usedEval!.stated!)}): the transcript does not print years or semesters that could be counted. Confirm before relying on it.`
        : null,
      engineering: usedEval ? usedEval.engineering : null,
      notes,
    };
  };

  // No qualification on file.
  if (!evals.length) {
    return finish("manual_review", 2, "Manual review needed: no qualification is on file for this case.", null);
  }

  // ---- Rule 1: not eligible ----------------------------------------------
  const engYes = evals.filter((e) => e.engineering.decision === "yes");
  if (evals.every((e) => e.engineering.decision === "no")) {
    const e = evals[0];
    return finish(
      "not_eligible",
      1,
      `Not eligible: the qualification on file is not an engineering qualification (${e.engineering.reason}).`,
      e,
    );
  }
  const knownAwards = evals.filter((e) => e.award !== "unknown");
  if (knownAwards.length && knownAwards.every((e) => e.award === "certificate")) {
    return finish(
      "not_eligible",
      1,
      "Not eligible: certificate-level qualification only (below AQF 5).",
      knownAwards[0],
    );
  }
  // Postgraduate awards are never failed on length here (decision b handles them).
  if (
    engYes.length &&
    engYes.every(
      (e) => !isPostgraduate(e.award) && e.used != null && e.used < evidenceConfig.gate.notEligibleBelowYears - EPS,
    )
  ) {
    const top = [...engYes].sort((a, b) => (b.used ?? 0) - (a.used ?? 0))[0];
    return finish(
      "not_eligible",
      1,
      `Not eligible: the engineering qualification is under ${evidenceConfig.gate.notEligibleBelowYears} years (${yrs(top.used!)}, ${basisLabel(top)}).`,
      top,
    );
  }

  // ---- Rule 2 (case-level): unusual study patterns -------------------------
  const considered = evals.filter((e) => e.engineering.decision !== "no");
  const engMaster = evals.find((e) => (e.award === "master" || e.award === "doctorate") && e.engineering.decision === "yes");
  const nonEngBachelor = evals.find((e) => (e.award === "bachelor" || e.award === "honours") && e.engineering.decision === "no");
  if (engMaster && nonEngBachelor) {
    return finish(
      "manual_review",
      2,
      `Manual review needed: non-engineering bachelor ("${label(nonEngBachelor)}") followed by an engineering master ("${label(engMaster)}").`,
      engMaster,
    );
  }
  for (const flag of [FLAG.combined, FLAG.partTime, FLAG.bridging, FLAG.creditTransfer]) {
    const hit = considered.find((e) => e.flags.includes(flag));
    if (hit) {
      return finish("manual_review", 2, `Manual review needed: ${flag} ("${label(hit)}").`, hit);
    }
  }

  // ---- Highest-level engineering qualification decides ---------------------
  const candidates = [...engYes].sort((a, b) => (b.aqf ?? 0) - (a.aqf ?? 0));
  for (const e of candidates) {
    const o = outcomeFor(e, evals);
    outcomes.set(e, o);
    if (o.kind === "open") {
      const reason =
        o.rule === 3
          ? `Professional Engineer and Engineering Technologist tracks open: ${o.reason}`
          : o.rule === 4
            ? `Engineering Technologist track only: ${o.reason}`
            : `Engineering Associate track only: ${o.reason}`;
      return finish("open", o.rule, reason, e);
    }
    if (o.kind === "manual") {
      return finish("manual_review", 2, `Manual review needed: ${o.reason}`, e);
    }
  }
  const failed = candidates.find((e) => outcomes.get(e)?.kind === "fail");
  if (failed) {
    return finish("not_eligible", 1, `Not eligible: ${outcomes.get(failed)!.reason}`, failed);
  }

  // Only unclear (or skipped) qualifications left.
  const unclear = evals.find((e) => e.engineering.decision === "unclear");
  if (unclear) {
    return finish(
      "manual_review",
      2,
      `Manual review needed: could not confirm that "${label(unclear)}" is an engineering qualification (${unclear.engineering.reason}).`,
      unclear,
    );
  }
  return finish("manual_review", 2, "Manual review needed: no rule matched this qualification set.", null);
}

function outcomeText(e: QualEval, o: Outcome | undefined): string {
  if (e.engineering.decision === "no") return "not engineering";
  if (!o) return e.engineering.decision === "unclear" ? "engineering unclear" : "not used";
  switch (o.kind) {
    case "open":
      return `passes (rule ${o.rule})`;
    case "manual":
      return "manual review";
    case "fail":
      return "below minimum";
    case "skip":
      return "not used (the bachelor decides)";
  }
}

/** True when Gate 1 lets scoring run. */
export function gateIsOpen(g: Gate1Decision | null | undefined): boolean {
  return g?.result === "open";
}

export function openTracks(g: Gate1Decision): Array<{ track: Gate1TrackId; priority: number }> {
  return g.tracks
    .filter((t) => t.open && t.priority != null)
    .map((t) => ({ track: t.track, priority: t.priority! }))
    .sort((a, b) => a.priority - b.priority);
}
