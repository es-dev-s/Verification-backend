/**
 * Qualification evidence read from the transcript rows (no DB, no LLM):
 *  - term parsing ("Year 3 Semester 2" → term 6) and counted programme length
 *    (used by Gate 1, see gate1.ts),
 *  - an explicit "is this an engineering qualification?" decision,
 *  - the final-year project pick for the Tier 3 gate.
 * Policy numbers live in evidenceConfig.ts.
 */
import { evidenceConfig } from "./evidenceConfig.js";
import { hasTopicWord } from "./matchSubjects.js";
import type { QualificationInfo } from "./qualificationCheck.js";
import { isEngineeringTitle } from "./route.js";
import type {
  EngineeringDecision,
  ExtractedSubjectRow,
  FinalProjectEvidence,
  QualificationType,
  SubjectMatch,
  TermUnit,
} from "./schemas.js";

// ---------------------------------------------------------------------------
// Term parsing
// ---------------------------------------------------------------------------

export type TermInfo = {
  unit: TermUnit;
  /** Year of study (1-based) when known. */
  yearOfStudy: number | null;
  /** Term within the year (1-based) when known. */
  termInYear: number | null;
  /** Sortable index in this unit (Year 3 Sem 2 → 6; "Year 2" → 2). */
  termIndex: number | null;
  termsPerYear: number;
  /** Academic start year for calendar-dated rows. */
  academicYear: number | null;
  /** Short label, e.g. "semester 6", "year 2", "2019/20". */
  label: string;
};

const WORD_NUM: Record<string, number> = {
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5,
  sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10,
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
};
const ROMAN: Record<string, number> = {
  i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8, ix: 9, x: 10,
};

const NUM =
  "(\\d{1,3}(?:st|nd|rd|th)?|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|one|two|three|four|five|six|seven|eight|nine|ten|viii|vii|iii|ii|iv|vi|ix|i|v|x)";
const TERM_WORD = "(semester|sem|trimester|tri|quarter|qtr|term)";
const YEAR_WORD = "(year|yr|level|part)";

function toNum(tok: string | undefined): number | null {
  if (!tok) return null;
  const t = tok.toLowerCase();
  const d = t.match(/^(\d{1,3})/);
  if (d) return Number(d[1]);
  return WORD_NUM[t] ?? ROMAN[t] ?? null;
}

function termsPerYearFor(word: string): number {
  if (/^tri/.test(word)) return 3;
  if (/^q/.test(word)) return 4;
  return 2;
}

function unitFor(word: string): TermUnit {
  if (/^tri/.test(word)) return "trimester";
  if (/^q/.test(word)) return "quarter";
  return "semester";
}

/** Parse a printed year / semester ("Year 3 Sem 2", "Semester V", "Fall 2019"). Null when unknown. */
export function parseTerm(raw: string | null | undefined): TermInfo | null {
  if (!raw) return null;
  const s = ` ${raw.toLowerCase().replace(/[_,;()]/g, " ").replace(/\s+/g, " ")} `;

  let yearOfStudy: number | null = null;
  let termNum: number | null = null;
  let termWord = "semester";

  const compact = s.match(/\by\s?(\d)\s*[-/ ]?\s*(s|t)\s?(\d{1,2})\b/);
  if (compact) {
    yearOfStudy = Number(compact[1]);
    termNum = Number(compact[3]);
    termWord = compact[2] === "t" ? "term" : "semester";
  } else {
    const yA = s.match(new RegExp(`\\b${YEAR_WORD}\\.?\\s*[-:#]?\\s*${NUM}\\b`));
    const yB = s.match(new RegExp(`\\b${NUM}\\s*-?\\s*${YEAR_WORD}\\b`));
    const yWord = yA?.[1] ?? yB?.[2];
    let y = yA ? toNum(yA[2]) : yB ? toNum(yB[1]) : null;
    if (y != null && yWord === "level" && y >= 100) y = Math.floor(y / 100);
    if (y != null && y >= 1 && y <= 7) yearOfStudy = y;

    const tA = s.match(new RegExp(`\\b${TERM_WORD}\\.?\\s*[-:#]?\\s*${NUM}\\b`));
    const tB = s.match(new RegExp(`\\b${NUM}\\s*-?\\s*${TERM_WORD}\\b`));
    const t = tA ? toNum(tA[2]) : tB ? toNum(tB[1]) : null;
    if (t != null && t >= 1 && t <= 16) {
      termNum = t;
      termWord = (tA?.[1] ?? tB?.[2])!;
    }
  }

  const calYears = [...s.matchAll(/\b(19[5-9]\d|20\d{2})\b/g)].map((m) => Number(m[1]));
  const season = s.match(/\b(fall|autumn|spring|summer|winter)\b/)?.[1] ?? null;

  const tpy = termsPerYearFor(termWord);
  const unit = unitFor(termWord);

  if (yearOfStudy != null && termNum != null) {
    // Term printed within the year (Sem 2 of Year 3) or running (Year 3, Sem 6).
    const inYear = termNum <= tpy ? termNum : ((termNum - 1) % tpy) + 1;
    const index = termNum <= tpy ? (yearOfStudy - 1) * tpy + termNum : termNum;
    return {
      unit,
      yearOfStudy,
      termInYear: inYear,
      termIndex: index,
      termsPerYear: tpy,
      academicYear: null,
      label: `${unit} ${index}`,
    };
  }
  // "Semester 5" (running count). A low term next to a calendar year is a
  // calendar term ("Semester 1, 2019") and handled below.
  if (termNum != null && !(calYears.length && termNum <= tpy)) {
    return {
      unit,
      yearOfStudy: Math.ceil(termNum / tpy),
      termInYear: ((termNum - 1) % tpy) + 1,
      termIndex: termNum,
      termsPerYear: tpy,
      academicYear: null,
      label: `${unit} ${termNum}`,
    };
  }
  if (yearOfStudy != null) {
    return {
      unit: "year",
      yearOfStudy,
      termInYear: null,
      termIndex: yearOfStudy,
      termsPerYear: 1,
      academicYear: null,
      label: `year ${yearOfStudy}`,
    };
  }
  if (calYears.length) {
    const first = Math.min(...calYears);
    // Northern-hemisphere seasons: an academic year starts in the fall.
    const academicYear =
      season && season !== "fall" && season !== "autumn" && calYears.length === 1
        ? first - 1
        : first;
    return {
      unit: "calendar",
      yearOfStudy: null,
      termInYear: termNum,
      termIndex: null,
      termsPerYear: 1,
      academicYear,
      label: season || calYears.length === 1 ? `${academicYear}/${String((academicYear + 1) % 100).padStart(2, "0")}` : `${first}`,
    };
  }
  return null;
}

/** Row with its parsed term attached (in-memory only; not a DB column). */
export function withTermIndex<T extends ExtractedSubjectRow>(row: T): T {
  const t = parseTerm(row.yearOrSemester);
  if (!t) return row;
  return { ...row, termIndex: t.termIndex, termUnit: t.unit };
}

/** Year position of a term (Year 3 Sem 2 of 2 → 3; calendar → academic year). */
function yearOf(t: TermInfo): number | null {
  if (t.unit === "calendar") return t.academicYear;
  return t.yearOfStudy;
}

// ---------------------------------------------------------------------------
// Counted duration
// ---------------------------------------------------------------------------

export type DurationCount = {
  countedYears: number | null;
  unit: TermUnit | null;
  confidence: "high" | "medium" | "low";
  /** Plain description of how the count was made. */
  method: string;
  creditTotal: number | null;
  /** Last year of study (or academic year) seen; used for the final-year project. */
  finalYear: number | null;
  rowsWithTerm: number;
  rowCount: number;
};

function parseCredits(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const m = raw.match(/(\d+(?:\.\d+)?)/);
  return m ? Number(m[1]) : null;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const roundHalf = (n: number) => Math.round(n * 2) / 2;

/** Count programme length from the rows of one qualification. */
export function countDuration(rows: readonly ExtractedSubjectRow[]): DurationCount {
  const cfg = evidenceConfig.duration;
  const credits = rows
    .filter((r) => !r.isRepeat)
    .map((r) => parseCredits(r.credits))
    .filter((n): n is number => n != null);
  const creditTotal = credits.length ? round2(credits.reduce((a, b) => a + b, 0)) : null;
  const terms = rows.map((r) => parseTerm(r.yearOrSemester)).filter((t): t is TermInfo => !!t);
  const base = { creditTotal, rowsWithTerm: terms.length, rowCount: rows.length };

  if (
    !rows.length ||
    terms.length < cfg.minTermRows ||
    terms.length < cfg.minTermCoverage * rows.length
  ) {
    return {
      ...base,
      countedYears: null,
      unit: null,
      confidence: "low",
      finalYear: null,
      method: terms.length
        ? `only ${terms.length} of ${rows.length} subjects show a year or semester`
        : "no year or semester printed next to the subjects",
    };
  }

  const calendar = terms.filter((t) => t.unit === "calendar");
  const study = terms.filter((t) => t.unit !== "calendar");
  const shareWithTerm = terms.length / rows.length;

  let counted: number;
  let coverage: number;
  let unit: TermUnit;
  let method: string;
  let finalYear: number;
  let maxConfidence: "high" | "medium" = "high";

  if (study.length >= calendar.length) {
    const subYear = study.filter((t) => t.unit !== "year");
    if (subYear.length) {
      // Most common terms-per-year among the semester-like rows.
      const tpyCounts = new Map<number, number>();
      for (const t of subYear) tpyCounts.set(t.termsPerYear, (tpyCounts.get(t.termsPerYear) ?? 0) + 1);
      const tpy = [...tpyCounts.entries()].sort((a, b) => b[1] - a[1])[0]![0];
      unit = subYear.find((t) => t.termsPerYear === tpy)!.unit;
      const indexes = study.map((t) =>
        t.unit === "year" ? (t.yearOfStudy ?? 1) * tpy : (t.termIndex! / t.termsPerYear) * tpy,
      );
      const maxIdx = Math.max(...indexes);
      const distinct = new Set(indexes.map((i) => Math.ceil(i))).size;
      counted = maxIdx / tpy;
      coverage = distinct / Math.ceil(maxIdx);
      finalYear = Math.ceil(counted);
      method = `highest ${unit} printed: ${Math.ceil(maxIdx)} (${distinct} of ${Math.ceil(maxIdx)} ${unit}s have subjects)`;
    } else {
      unit = "year";
      const years = study.map((t) => t.yearOfStudy!);
      const maxYear = Math.max(...years);
      const distinct = new Set(years).size;
      counted = maxYear;
      coverage = distinct / maxYear;
      finalYear = maxYear;
      method = `highest year printed: ${maxYear} (${distinct} of ${maxYear} years have subjects)`;
    }
  } else {
    unit = "calendar";
    const years = calendar.map((t) => t.academicYear!);
    const min = Math.min(...years);
    const max = Math.max(...years);
    const distinct = new Set(years).size;
    counted = max - min + 1;
    coverage = distinct / counted;
    finalYear = max;
    // Calendar dates include gaps / extensions: never better than medium.
    maxConfidence = "medium";
    method = `academic years printed: ${min}–${max} (${distinct} of ${counted} years have subjects)`;
  }

  let confidence: "high" | "medium" | "low" =
    coverage >= 0.75 ? "high" : coverage >= 0.5 ? "medium" : "low";
  if (confidence === "high" && (shareWithTerm < 0.75 || maxConfidence === "medium")) {
    confidence = "medium";
  }
  return {
    ...base,
    countedYears: roundHalf(counted),
    unit,
    confidence,
    method,
    finalYear,
  };
}

export function isReliableCount(c: DurationCount): boolean {
  return c.countedYears != null && c.confidence !== "low";
}

/** Rows and stated duration for each qualification level on the case. */
export type LevelDurationBasis = {
  level: QualificationType;
  title: string | null;
  statedYears: number | null;
  count: DurationCount;
};

export function durationBasisFor(
  rows: readonly ExtractedSubjectRow[],
  qualifications: readonly QualificationInfo[],
): LevelDurationBasis[] {
  const out: LevelDurationBasis[] = [];
  const known = qualifications.filter((q) => q.level !== "unknown");
  const single = known.length === 1 && qualifications.length === 1;
  const levels: Array<{ level: QualificationType; q?: QualificationInfo }> = known.length
    ? known.map((q) => ({ level: q.level, q }))
    : [...new Set(rows.map((r) => r.qualification).filter((l) => l !== "unknown"))].map(
        (level) => ({ level }),
      );
  const seen = new Set<string>();
  for (const { level, q } of levels) {
    if (seen.has(level)) continue;
    seen.add(level);
    const atLevel = rows.filter(
      (r) => r.qualification === level || (single && r.qualification === "unknown"),
    );
    if (!atLevel.length && !q) continue;
    out.push({
      level,
      title: q?.title ?? null,
      statedYears: q?.durationYears ?? null,
      count: countDuration(atLevel),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Engineering or not
// ---------------------------------------------------------------------------

const ENGINEERING_FIELD_WORDS = [
  "mechanical", "mech", "electrical", "electronic*", "civil", "chemical", "mechatronic*",
  "aeronautic*", "aerospace", "structural", "petroleum", "mining", "telecommunication*",
  "automation", "instrumentation", "draft*", "draught*", "naval", "marine", "biomedical",
  "manufactur*", "robotic*", "geotechnical", "metallurg*", "agricultural engineering",
] as const;

/** Subject words that read as engineering coursework. */
const ENGINEERING_SUBJECT_WORDS = [
  "engineer*", "engg", "mechanic*", "thermodynamic*", "statics", "circuit*", "electronic*",
  "electrical", "structur*", "fluid*", "hydraul*", "hydrolog*", "surveying", "geotechn*",
  "machine*", "machining", "vibration*", "turbomachin*", "heat", "combustion", "propulsion",
  "aerodynamic*", "control", "signal*", "microprocessor*", "microcontroller*", "embedded",
  "electromagnetic*", "telecommunication*", "antenna*", "power", "concrete", "steel", "soil*",
  "transportation", "highway*", "manufactur*", "cad", "autocad", "drafting",
  "drawing", "mechatronic*", "robot*", "automation", "instrumentation", "materials",
  "metallurg*", "welding", "petroleum", "reservoir", "drilling", "mining", "mineral*",
  "finite", "kinematics", "dynamics", "strength", "workshop", "dsp", "vlsi", "plc",
] as const;

export const NOT_ENGINEERING_NOTE =
  "qualification does not appear to be engineering, assessor to review";

export function looksLikeEngineeringSubject(name: string): boolean {
  return hasTopicWord(name, ENGINEERING_SUBJECT_WORDS);
}

function titleSignal(
  qualifications: readonly QualificationInfo[],
  relatedField?: boolean,
): EngineeringDecision["titleSignal"] {
  const titles = qualifications.map((q) => q.title?.trim() ?? "").filter(Boolean);
  if (titles.some((t) => isEngineeringTitle(t))) return "engineering";
  if (relatedField || titles.some((t) => hasTopicWord(t, ENGINEERING_FIELD_WORDS))) return "related";
  if (titles.length) return "other";
  return "none";
}

/**
 * Explicit engineering decision for the case, from the qualification titles and
 * the subject list (share of subjects that read as engineering or matched an
 * engineering rubric core subject).
 */
export function decideEngineering(input: {
  qualifications: readonly QualificationInfo[];
  rows: readonly ExtractedSubjectRow[];
  /** Transcript names matched to a Tier 2 (core) subject of any academic rubric. */
  coreMatchedNames?: ReadonlySet<string>;
  /** True when the qualification was classified as a vocational / drafting engineering field. */
  relatedField?: boolean;
  /** Step 2 checkbox (assessor confirmed an engineering-titled degree). */
  engineeringTitledDegree?: boolean | null;
  /** Engineering subject share (0–1) entered by the assessor; replaces the computed share. */
  subjectShareOverride?: number | null;
}): EngineeringDecision {
  const cfg = evidenceConfig.engineering;
  const names = [
    ...new Set(input.rows.filter((r) => !r.isRepeat).map((r) => r.name.trim()).filter(Boolean)),
  ];
  const eng = names.filter(
    (n) => input.coreMatchedNames?.has(n) || looksLikeEngineeringSubject(n),
  ).length;
  const override = input.subjectShareOverride;
  const share =
    override != null && Number.isFinite(override)
      ? round2(Math.min(1, Math.max(0, override)))
      : names.length
        ? round2(eng / names.length)
        : null;
  const signal = titleSignal(input.qualifications, input.relatedField);
  const pct = share == null ? "no" : `${Math.round(share * 100)}%`;
  const base = { titleSignal: signal, subjectShare: share, subjectsConsidered: names.length };
  const strong = share != null && share >= cfg.strongShare;
  const weak = share != null && share < cfg.weakShare;

  if (input.engineeringTitledDegree === true) {
    return { ...base, decision: "yes", reason: "assessor ticked engineering-titled degree in Verify details", capped: false, note: null };
  }
  if (signal === "engineering") {
    return { ...base, decision: "yes", reason: `title names engineering; ${pct} of subjects are engineering`, capped: false, note: null };
  }
  if (signal === "related" && strong) {
    return { ...base, decision: "yes", reason: `title names an engineering field; ${pct} of subjects are engineering`, capped: false, note: null };
  }
  if (signal === "other" && weak && names.length >= cfg.minSubjects) {
    return {
      ...base,
      decision: "no",
      reason: `title does not name engineering and only ${pct} of subjects are engineering`,
      capped: false,
      note: NOT_ENGINEERING_NOTE,
    };
  }
  const reason =
    signal === "none"
      ? `no qualification title on file; ${pct} of subjects are engineering`
      : signal === "related"
        ? `title names an engineering field but only ${pct} of subjects are engineering`
        : names.length < cfg.minSubjects
          ? `title does not name engineering; too few subjects (${names.length}) to judge`
          : `title does not name engineering; ${pct} of subjects are engineering`;
  return {
    ...base,
    decision: "unclear",
    reason,
    capped: false,
    note: `Engineering or not: unclear (${reason}), assessor to review`,
  };
}

/** Transcript names matched to a Tier 2 core subject in any of the given match lists. */
export function coreMatchedNamesOf(matchLists: readonly (readonly SubjectMatch[])[]): Set<string> {
  const out = new Set<string>();
  for (const list of matchLists) {
    for (const m of list) {
      if (m.tier === "tier2" && m.method !== "none") out.add(m.transcriptName.trim());
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Final-year project
// ---------------------------------------------------------------------------

export const PROJECT_NOT_FINAL_YEAR_NOTE = "project found but not in final year";

/**
 * Pick the gate (project / thesis) match, preferring the last year or term,
 * and move it first among the gate matches. Without term info the first gate
 * match is kept (current behaviour).
 */
export function preferFinalYearGate(
  matches: SubjectMatch[],
  rows: readonly ExtractedSubjectRow[],
  gateName: string,
): { matches: SubjectMatch[]; finalProject: FinalProjectEvidence | null } {
  const isGate = (m: SubjectMatch) =>
    m.tier === "tier3" && m.rubricSubject === gateName && m.method !== "none";
  const gates = matches.filter(isGate);
  if (!gates.length) return { matches, finalProject: null };

  const termOf = (m: SubjectMatch): TermInfo | null => {
    const row = rows.find(
      (r) => r.name === m.transcriptName && (r.qualification === m.qualification || m.qualification === "unknown"),
    ) ?? rows.find((r) => r.name === m.transcriptName);
    return parseTerm(row?.yearOrSemester);
  };
  const withTerms = gates.map((m) => ({ m, t: termOf(m) }));
  const termed = withTerms.filter((g) => g.t);
  if (!termed.length) {
    return {
      matches,
      finalProject: { title: gates[0]!.transcriptName, term: null, inFinalYear: null, note: null },
    };
  }

  // Final year of the level the gate rows belong to.
  const level = termed[0]!.m.qualification;
  const levelRows = rows.filter((r) => r.qualification === level || level === "unknown");
  const finalYear = countDuration(levelRows).finalYear ??
    Math.max(...termed.map((g) => yearOf(g.t!) ?? 0));
  const sortKey = (t: TermInfo) =>
    t.unit === "calendar" ? (t.academicYear ?? 0) * 10 + (t.termInYear ?? 0) : (t.termIndex ?? 0) / t.termsPerYear;
  termed.sort((a, b) => sortKey(b.t!) - sortKey(a.t!));
  const pick = termed[0]!;
  const inFinalYear = yearOf(pick.t!) != null && yearOf(pick.t!)! >= finalYear;
  // Swap the pick into the first gate position (other rows keep their order).
  const reordered = [...matches];
  const firstGate = reordered.findIndex(isGate);
  const at = reordered.indexOf(pick.m);
  if (firstGate >= 0 && at > firstGate) {
    reordered[at] = reordered[firstGate]!;
    reordered[firstGate] = pick.m;
  }
  return {
    matches: reordered,
    finalProject: {
      title: pick.m.transcriptName,
      term: pick.t!.label,
      inFinalYear,
      note: inFinalYear ? null : PROJECT_NOT_FINAL_YEAR_NOTE,
    },
  };
}
