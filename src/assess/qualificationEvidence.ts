/**
 * Qualification evidence read from the transcript rows (no DB, no LLM):
 *  - term parsing ("Year 3 Semester 2" → term 6) and counted programme length
 *    (used by Gate 1, see gate1.ts); with no usable years / semesters the
 *    length is converted from the credit total when there is one,
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

/**
 * "SE3" / "SE 3" is semester 3 (e.g. "Semester : SE3" grade sheets). A
 * semester word before it is kept once ("Semester : SE3" → "semester : 3").
 * Bare "S3" is not a semester. Input is lower-case.
 */
function withSeSemester(s: string): string {
  return s
    .replace(/\b(sem(?:ester)?\.?\s*[-:#.]?\s*)se\s?(\d{1,2})\b/g, "$1$2")
    .replace(/\bse\s?(\d{1,2})\b/g, "semester $1");
}

/** Parse a printed year / semester ("Year 3 Sem 2", "Semester V", "SE3", "Fall 2019"). Null when unknown. */
export function parseTerm(raw: string | null | undefined): TermInfo | null {
  if (!raw) return null;
  const s = withSeSemester(` ${raw.toLowerCase().replace(/[_,;()]/g, " ").replace(/\s+/g, " ")} `);

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

// ---------------------------------------------------------------------------
// Period headings in the transcript text
// ---------------------------------------------------------------------------

const H_TERM = "(?:semester|sem|trimester|term|quarter|qtr)";
const H_YEAR = "(?:year|yr|level|part)";
/** One period token ("SEM : 3", "Semester III", "3rd Semester", "Second Year"). */
const H_ONE = `(?:${H_TERM}\\.?\\s*[-:#.]?\\s*se\\s?\\d{1,2}|${H_TERM}\\.?\\s*[-:#.]?\\s*${NUM}|${NUM}\\s*-?\\s*${H_TERM}|${H_YEAR}\\.?\\s*[-:#.]?\\s*${NUM}|${NUM}\\s*-?\\s*${H_YEAR})`;
const ONE_RE = new RegExp(`^${H_ONE}\\b`, "i");
/** A year and its semester printed in one heading ("Year 2 Semester 1"). */
const FOLLOW_RE = new RegExp(`^[\\s,;:/–—-]+${H_ONE}\\b`, "i");
/** Another period heading later on the same line (the other column). */
const NEXT_RE = new RegExp(`^[\\s|]*${H_ONE}\\b`, "i");
/** Words allowed after a heading on the same line (session / result columns, not a subject title). */
const HEADING_TAIL_WORDS = new Set([
  "trial", "attempt", "spi", "cpi", "sgpa", "cgpa", "gpa", "credits", "credit", "hrs", "hours", "week",
  "result", "results", "exam", "examination", "session", "odd", "even", "regular", "supplementary",
  "backlog", "marks", "total", "grade", "grades", "pass", "passed", "held", "month", "autumn", "spring",
  "fall", "summer", "winter", "year", "semester", "code", "subject", "name", "status", "remarks",
  "with", "from", "and", "the", "of", "in", "for",
]);

export type TextPeriodHeading = {
  /** Character offset of the heading in the text. */
  offset: number;
  /** Heading as printed (cleaned), e.g. "SEM :3" or "Year 2, First Semester". */
  label: string;
  term: TermInfo;
};

const PAGE_MARK_RE = /^---\s*page\s+\d+\s*---$/i;
const EXPLICIT_YEAR_RE = new RegExp(
  `\\b(?:${H_YEAR})\\b|\\by\\s?\\d\\s*[-/ ]?\\s*[stq]\\s?\\d`,
  "i",
);
const YEAR_TOKEN_RE = new RegExp(
  `\\b(?:${H_YEAR}\\.?\\s*[-:#.]?\\s*${NUM}|${NUM}\\s*-?\\s*${H_YEAR})\\b`,
  "i",
);

/** The printed text names a year of study ("Year 2", "Second Year", "Y2S1"). */
function mentionsYear(raw: string | null | undefined): boolean {
  return !!raw && EXPLICIT_YEAR_RE.test(raw);
}

/** Year words from a heading, for prefixing a later semester on the same page. */
function yearToken(raw: string, yearOfStudy: number): string {
  const m = raw.match(YEAR_TOKEN_RE);
  return m ? m[0].replace(/\s+/g, " ").trim() : `Year ${yearOfStudy}`;
}

/**
 * "First Semester" / "Sem 2": the printed number is the term inside one year.
 * "Semester 5" / "SEM : 7" is a running count and must not be renumbered.
 */
function withinYearTerm(term: TermInfo): boolean {
  return term.unit !== "year" && term.termIndex != null && term.termIndex <= term.termsPerYear;
}

type YearCarry = { label: string; yearOfStudy: number };

/**
 * Join a within-year semester ("I Semester", "First Semester") to the year it
 * belongs to, so the printed 1 / 2 becomes the programme semester
 * (Year 3 + I Semester → semester 5). The year carries across pages. When the
 * semester number goes backwards and no new year heading was printed, the next
 * year is used. A running number ("SEM : 7") is left as printed.
 */
function placeHeading(
  rawLabel: string,
  term: TermInfo,
  state: { carry: YearCarry | null; lastSem: number | null },
): { label: string; term: TermInfo } {
  const label = rawLabel.replace(/\s+/g, " ").trim();
  if (term.unit === "year" && term.yearOfStudy != null) {
    state.carry = { label, yearOfStudy: term.yearOfStudy };
    state.lastSem = null;
    return { label, term };
  }
  if (mentionsYear(label) && term.yearOfStudy != null) {
    state.carry = { label: yearToken(label, term.yearOfStudy), yearOfStudy: term.yearOfStudy };
    state.lastSem = term.termInYear;
    return { label, term };
  }
  if (!withinYearTerm(term) || term.termIndex == null) {
    state.lastSem = null;
    return { label, term };
  }
  const semNo = term.termIndex;
  if (!state.carry) state.carry = { label: "Year 1", yearOfStudy: 1 };
  if (state.lastSem != null && semNo < state.lastSem) {
    const next = state.carry.yearOfStudy + 1;
    state.carry = { label: `Year ${next}`, yearOfStudy: next };
  }
  state.lastSem = semNo;
  // "II YEAR, I SEMESTER" is misread (the "I" becomes the year). Keep the
  // printed wording when it parses to this year and semester; otherwise use
  // "Year 2 semester 1", which cannot be read the other way.
  const expected = (state.carry.yearOfStudy - 1) * term.termsPerYear + semNo;
  const printed = `${state.carry.label}, ${label}`;
  const printedTerm = parseTerm(printed);
  if (printedTerm?.yearOfStudy === state.carry.yearOfStudy && printedTerm.termIndex === expected) {
    return { label: printed, term: printedTerm };
  }
  const canonical = `Year ${state.carry.yearOfStudy} ${term.unit} ${semNo}`;
  const canonicalTerm = parseTerm(canonical);
  if (canonicalTerm?.termIndex === expected) return { label: canonical, term: canonicalTerm };
  return { label, term };
}

/** Period headings in one "|"-separated cell, including a second column ("I SEMESTER    II SEMESTER"). */
function headingsInCell(
  cell: string,
  cellOffset: number,
  state: { carry: YearCarry | null; lastSem: number | null },
  out: TextPeriodHeading[],
): void {
  let pos = 0;
  for (let n = 0; n < 8 && pos < cell.length; n++) {
    const slice = cell.slice(pos);
    const lead = slice.match(/^[\s*•·>#\-–—]*/)![0].length;
    if (lead >= slice.length) break;
    const head = slice.slice(lead);
    const m = head.match(ONE_RE);
    if (!m) break;
    let raw = m[0];
    let consumed = lead + m[0].length;
    const follow = head.slice(m[0].length).match(FOLLOW_RE);
    if (follow) {
      const second = follow[0].replace(/^[\s,;:/–—-]+/, "");
      const t1 = parseTerm(raw);
      const t2 = parseTerm(second);
      const complement =
        !!t1 &&
        !!t2 &&
        t1.unit !== "calendar" &&
        t2.unit !== "calendar" &&
        (t1.unit === "year") !== (t2.unit === "year");
      if (complement) {
        raw = `${raw} ${second}`.replace(/\s+/g, " ").trim();
        consumed += follow[0].length;
      }
    }
    const tail = head.slice(consumed - lead);
    const another = NEXT_RE.test(tail);
    if (!another) {
      const words = tail.toLowerCase().match(/[a-z]{3,}/g) ?? [];
      if (!words.every((w) => HEADING_TAIL_WORDS.has(w))) break;
    }
    const term = parseTerm(raw);
    if (term && term.unit !== "calendar") {
      const placed = placeHeading(raw, term, state);
      out.push({ offset: cellOffset + pos + lead, label: placed.label, term: placed.term });
    } else {
      break;
    }
    if (!another) break;
    pos += consumed;
  }
}

/**
 * Year / semester headings printed in a transcript's text, in order. A heading
 * starts a line (or a "|"-separated cell) and may share the line with
 * session columns ("SEM : 3 | TRIAL : 2 | SPI: 3.61") or a second semester
 * column ("I SEMESTER    II SEMESTER"), but not with a subject title.
 * A year heading is joined to the following within-year semesters and kept
 * across page breaks ("Year 3" then "I Semester" → "Year 3, I Semester",
 * semester 5). Repeating "I / II Semester" with no year heading is numbered
 * in reading order.
 */
export function periodHeadingsOf(text: string | null | undefined): TextPeriodHeading[] {
  if (!text) return [];
  const out: TextPeriodHeading[] = [];
  const state: { carry: YearCarry | null; lastSem: number | null } = { carry: null, lastSem: null };
  let lineStart = 0;
  for (const line of text.split("\n")) {
    if (PAGE_MARK_RE.test(line.trim())) {
      lineStart += line.length + 1;
      continue;
    }
    let cellStart = 0;
    for (const cell of line.split("|")) {
      headingsInCell(cell, lineStart + cellStart, state, out);
      cellStart += cell.length + 1;
    }
    lineStart += line.length + 1;
  }
  return out;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Where a subject row is printed in the text (unit code first, then its name); -1 when not found. */
function rowOffsetIn(text: string, row: Pick<ExtractedSubjectRow, "name" | "code">): number {
  const code = row.code?.trim();
  if (code && code.length >= 4) {
    const m = new RegExp(`(?<![A-Za-z0-9])${escapeRe(code)}(?![A-Za-z0-9])`).exec(text);
    if (m) return m.index;
  }
  const words = row.name.match(/[A-Za-z0-9]+/g) ?? [];
  for (const take of [words.length, Math.min(words.length, 3)]) {
    if (!take || words.slice(0, take).join("").length < 6) continue;
    const re = new RegExp(words.slice(0, take).map(escapeRe).join("[^A-Za-z0-9]{1,6}"), "i");
    const m = re.exec(text);
    if (m) return m.index;
  }
  return -1;
}

/** Heading above this character: on a two-column line, the one in the subject's column. */
function headingAbove(text: string, headings: readonly TextPeriodHeading[], at: number): TextPeriodHeading | null {
  const lineStart = text.lastIndexOf("\n", Math.max(0, at - 1)) + 1;
  const col = at - lineStart;
  let best: TextPeriodHeading | null = null;
  let bestLine = -1;
  for (const h of headings) {
    if (h.offset > at) break;
    const hLine = text.lastIndexOf("\n", Math.max(0, h.offset - 1)) + 1;
    const hCol = h.offset - hLine;
    if (hLine !== bestLine) {
      bestLine = hLine;
      best = h;
    } else if (hCol <= col) {
      best = h;
    }
  }
  return best;
}

/**
 * Fill each row's year / semester from the heading it is printed under in its
 * transcript's text. Used on every read, so saved subjects benefit without
 * being extracted again.
 *
 * A row keeps a label that already names its year. A bare semester ("First
 * Semester") is replaced when the heading joined that semester to the page
 * year ("Year 2, First Semester"). An empty label, or an exam session such as
 * "W2019", is filled from the heading.
 */
export function applyTextPeriods<T extends ExtractedSubjectRow>(
  rows: readonly T[],
  documents: ReadonlyArray<{ id: string; text?: string | null }>,
): T[] {
  const headings = new Map<string, TextPeriodHeading[]>();
  const texts = new Map<string, string>();
  for (const d of documents) {
    const h = periodHeadingsOf(d.text);
    // Two or more distinct periods: a single stray match is not a layout.
    if (new Set(h.map((x) => x.term.label)).size >= 2) {
      headings.set(d.id, h);
      texts.set(d.id, d.text!);
    }
  }
  if (!headings.size) return [...rows];
  const only = documents.length === 1 ? documents[0]!.id : null;
  return rows.map((r) => {
    const docId = r.documentId ?? only;
    const h = docId ? headings.get(docId) : undefined;
    if (!h) return r;
    const text = texts.get(docId!)!;
    const at = rowOffsetIn(text, r);
    if (at < 0) return r;
    const under = headingAbove(text, h, at);
    if (!under) return r;
    const own = parseTerm(r.yearOrSemester);
    // A heading that adds the page year is more specific than "First Semester".
    if (own && own.unit !== "calendar") {
      const richer =
        under.term.unit !== "year" &&
        mentionsYear(under.label) &&
        !mentionsYear(r.yearOrSemester);
      if (!richer) return r;
    }
    return { ...r, yearOrSemester: under.label };
  });
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
  /** Where countedYears came from (null when nothing could be counted). */
  source: "terms" | "credits" | null;
  /** Set when countedYears was converted from the credit total. */
  creditConversion: CreditConversion | null;
  /** First and last study period printed (display only; null for calendar years or no periods). */
  span?: { unit: Exclude<TermUnit, "calendar">; first: number; last: number } | null;
};

export type CreditSystem = "default" | "ects" | "usSemester" | "australianCreditPoints";

export type CreditConversion = {
  credits: number;
  perYear: number;
  system: CreditSystem;
  years: number;
  /** Flag text, e.g. "Converted from credits (240 credits ÷ 60 per year)". */
  label: string;
};

/** Extra context for the credit conversion (all optional). */
export type CreditContext = {
  country?: string | null;
  /** Transcript texts at this level (to spot "ECTS", "credit points", "semester hours"). */
  texts?: readonly string[] | null;
  /** Credit total entered by the assessor (replaces the transcript total). */
  creditTotalOverride?: number | null;
};

function parseCredits(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const m = raw.match(/(\d+(?:\.\d+)?)/);
  return m ? Number(m[1]) : null;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const roundHalf = (n: number) => Math.round(n * 2) / 2;
const round1 = (n: number) => Math.round(n * 10) / 10;

const ECTS_RE = /\bects\b|european credit transfer/i;
const AU_CP_RE = /\bcredit\s*points?\b|\bunits? of credit\b|\buoc\b/i;
const US_SCH_RE = /\b(?:semester|credit)\s*(?:credit\s*)?hours?\b|\bsch\b/i;

/** Credit system of a transcript, when detectable (else "default"). */
export function detectCreditSystem(
  rows: readonly Pick<ExtractedSubjectRow, "credits">[],
  ctx: CreditContext = {},
): CreditSystem {
  const cfg = evidenceConfig.duration.credits;
  const text = [...rows.map((r) => r.credits ?? ""), ...(ctx.texts ?? [])].join("\n");
  const country = (ctx.country ?? "").toLowerCase();
  if (ECTS_RE.test(text)) return "ects";
  if (/\baustralia/.test(country)) return "australianCreditPoints";
  if (/\b(united states|usa|u\.s\.a?\.?)\b|^us$/.test(country)) return "usSemester";
  if (country && cfg.ectsCountries.some((c) => country.includes(c))) return "ects";
  if (US_SCH_RE.test(text)) return "usSemester";
  if (AU_CP_RE.test(text) && /\baustralia/i.test(text)) return "australianCreditPoints";
  return "default";
}

/** Credits per full-time year for a credit system (evidenceConfig.duration.credits). */
export function creditsPerYear(system: CreditSystem): number {
  const cfg = evidenceConfig.duration.credits;
  return system === "default" ? cfg.defaultPerYear : cfg.perYear[system];
}

/** Convert a credit total to years; null when there are no credits or the result is implausible. */
export function creditsToYears(
  credits: number | null | undefined,
  system: CreditSystem,
): CreditConversion | null {
  const cfg = evidenceConfig.duration.credits;
  if (credits == null || !Number.isFinite(credits) || credits <= 0) return null;
  const perYear = creditsPerYear(system);
  const years = roundHalf(credits / perYear);
  if (years < cfg.minYears || years > cfg.maxYears) return null;
  return {
    credits: round2(credits),
    perYear,
    system,
    years,
    label: `Converted from credits (${round1(credits)} credits ÷ ${perYear} per year)`,
  };
}

const HEAD_NUM =
  "\\d{1,2}(?:st|nd|rd|th)?|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|viii|vii|iii|ii|iv|vi|ix|i|v|x";
/** Semester word with a number beside it ("I SEMESTER", "Semester 3", "2nd Semester"). */
const SEM_HEAD_RE = new RegExp(
  `^(?:sem(?:ester)?\\.?\\s*[-:#.]?\\s*(?:se\\s?(?=\\d))?(${HEAD_NUM})|(${HEAD_NUM})\\s*[-:#.]?\\s*sem(?:ester)?)\\b`,
  "i",
);
const YEAR_OF_STUDY_RE = new RegExp(`\\byear\\s+of\\s+study\\s*[-:#.]?\\s*(${HEAD_NUM})\\b`, "gi");

function studyYearToken(raw: string | undefined): number | null {
  const n = toNum(raw);
  return n != null && n >= 1 && n <= 7 ? n : null;
}

/** Year of study anywhere in the text ("IV YEAR", "3rd Year", "Year of study: 3"). Not a calendar year. */
const YEAR_ANY_RE = new RegExp(
  `\\b(?:(?:year|yr)(?:\\s+of\\s+study)?\\.?\\s*[-:#.]?\\s*(${HEAD_NUM})|(${HEAD_NUM})\\s*[-:#.]?\\s*(?:year|yr))\\b`,
  "gi",
);

/** Highest year-of-study number printed on the transcript ("IV YEAR" → 4, "3rd Year" mid-line → 3). */
function maxStudyYear(text: string): number | null {
  const found: number[] = [];
  const push = (raw: string | undefined) => {
    const n = studyYearToken(raw);
    if (n != null) found.push(n);
  };
  YEAR_ANY_RE.lastIndex = 0;
  for (const m of text.matchAll(YEAR_ANY_RE)) push(m[1] ?? m[2]);
  YEAR_OF_STUDY_RE.lastIndex = 0;
  for (const m of text.matchAll(YEAR_OF_STUDY_RE)) push(m[1]);
  return found.length ? Math.max(...found) : null;
}

/** Highest year of study printed on a subject row. A bare "Semester 5" does not count. */
function maxRowStudyYear(rows: readonly ExtractedSubjectRow[]): number | null {
  let max: number | null = null;
  for (const row of rows) {
    if (!mentionsYear(row.yearOrSemester)) continue;
    const year = parseTerm(row.yearOrSemester)?.yearOfStudy ?? null;
    if (year != null && (max == null || year > max)) max = year;
  }
  return max;
}

/**
 * Numbered semester headings in reading order. Each one counts as 1, whatever
 * number is printed beside it. "Semester Project" has no number, so it is skipped.
 */
function semesterHeadingCount(text: string): number {
  let n = 0;
  for (const line of text.split("\n")) {
    for (const cell of line.split("|")) {
      let rest = cell;
      for (let i = 0; i < 6 && rest.trim(); i++) {
        const lead = rest.match(/^[\s*•·>#\-–—]*/)![0].length;
        const m = rest.slice(lead).match(SEM_HEAD_RE);
        const num = studyYearToken(m?.[1] ?? m?.[2]) ?? toNum(m?.[1] ?? m?.[2]);
        if (!m || num == null || num < 1 || num > 16) break;
        n++;
        rest = rest.slice(lead + m[0].length);
      }
    }
  }
  return n;
}

function yearDuration(year: number): Pick<
  DurationCount,
  "countedYears" | "unit" | "method" | "finalYear" | "span"
> {
  return {
    countedYears: year,
    unit: "year",
    method: `year ${year} printed on the transcript`,
    finalYear: year,
    span: { unit: "year", first: year, last: year },
  };
}

/**
 * Duration from the transcript text. Numbered semester headings are one
 * semester each (8 headings → 4 years). A printed year of study replaces that
 * count when it is higher: three Year 3 transcripts whose semesters restart
 * at 1 and 2 are 3 years, not 2. A lower year mention does not shorten a
 * longer semester span. Null when the text has neither.
 */
function durationFromHeadings(texts: readonly string[] | null | undefined): Pick<
  DurationCount,
  "countedYears" | "unit" | "method" | "finalYear" | "span"
> | null {
  if (!texts?.some((t) => t?.trim())) return null;
  const blob = texts.filter(Boolean).join("\n");
  const year = maxStudyYear(blob);
  const headings = semesterHeadingCount(blob);
  if (headings >= 2) {
    const finalYear = Math.ceil(headings / 2);
    if (year == null || year <= finalYear) {
      return {
        countedYears: roundHalf(headings / 2),
        unit: "semester",
        method: `${headings} semester headings on the transcript`,
        finalYear,
        span: { unit: "semester", first: 1, last: headings },
      };
    }
  }
  if (year != null) return yearDuration(year);
  return null;
}

/** A printed year of study replaces a shorter semester count. A year span is left as counted. */
function withHigherPrintedYear(count: DurationCount, printedYear: number | null): DurationCount {
  if (printedYear == null || count.unit === "year") return count;
  const ceiling = count.finalYear ?? count.countedYears ?? 0;
  if (count.countedYears != null && printedYear <= ceiling) return count;
  return {
    ...count,
    ...yearDuration(printedYear),
    confidence: "high",
    source: "terms",
    creditConversion: null,
  };
}

/**
 * Count programme length from the rows of one qualification: a year number
 * printed on the transcript, otherwise the number of semester headings, then
 * the years / semesters on the subject rows; when those cannot be counted
 * reliably, the credit total (assessor value first) converted to years.
 * A half year is then rounded up to the whole year (duration.roundHalfUp).
 */
export function countDuration(
  rows: readonly ExtractedSubjectRow[],
  ctx: CreditContext = {},
): DurationCount {
  return roundedUpCount(countDurationUnrounded(rows, ctx));
}

/**
 * Final step: a counted half year (3.5) becomes the next whole year (4) when
 * evidenceConfig.duration.roundHalfUp is on. The raw count stays in the
 * method text. Assessor entries never pass through here.
 */
export function roundedUpCount(count: DurationCount): DurationCount {
  const raw = count.countedYears;
  if (!evidenceConfig.duration.roundHalfUp || raw == null || Number.isInteger(raw)) return count;
  const years = Math.ceil(raw);
  const note = `${raw} years counted, rounded up to ${years}`;
  return {
    ...count,
    countedYears: years,
    method: count.method ? `${count.method}; ${note}` : note,
    creditConversion: count.creditConversion ? { ...count.creditConversion, years } : count.creditConversion,
  };
}

function countDurationUnrounded(
  rows: readonly ExtractedSubjectRow[],
  ctx: CreditContext,
): DurationCount {
  const byTerms = countFromTerms(rows);
  const headed = durationFromHeadings(ctx.texts);
  const printedYear = Math.max(
    maxStudyYear((ctx.texts ?? []).filter(Boolean).join("\n")) ?? 0,
    maxRowStudyYear(rows) ?? 0,
  ) || null;
  if (headed) {
    const counted = withHigherPrintedYear(
      {
        ...byTerms,
        ...headed,
        confidence: "high",
        source: "terms",
        creditConversion: null,
      },
      printedYear,
    );
    return counted;
  }
  if (isReliableCount(byTerms)) return withHigherPrintedYear(byTerms, printedYear);
  const credits = ctx.creditTotalOverride ?? byTerms.creditTotal;
  const conversion = creditsToYears(credits, detectCreditSystem(rows, ctx));
  if (!conversion) return byTerms;
  return {
    ...byTerms,
    countedYears: conversion.years,
    unit: null,
    confidence: "medium",
    method: `${conversion.label.charAt(0).toLowerCase()}${conversion.label.slice(1)}; ${byTerms.method}`,
    source: "credits",
    creditConversion: conversion,
  };
}

/** Count programme length from the printed years / semesters only. */
function countFromTerms(rows: readonly ExtractedSubjectRow[]): DurationCount {
  const cfg = evidenceConfig.duration;
  const credits = rows
    .filter((r) => !r.isRepeat)
    .map((r) => parseCredits(r.credits))
    .filter((n): n is number => n != null);
  const creditTotal = credits.length ? round2(credits.reduce((a, b) => a + b, 0)) : null;
  const terms = rows.map((r) => parseTerm(r.yearOrSemester)).filter((t): t is TermInfo => !!t);
  const base = {
    creditTotal,
    rowsWithTerm: terms.length,
    rowCount: rows.length,
    creditConversion: null,
  };

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
      source: null,
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
  let startsLate = false;
  let printedSpan: DurationCount["span"] = null;

  if (study.length >= calendar.length) {
    const subYear = study.filter((t) => t.unit !== "year");
    if (subYear.length) {
      // Most common terms-per-year among the semester-like rows.
      const tpyCounts = new Map<number, number>();
      for (const t of subYear) tpyCounts.set(t.termsPerYear, (tpyCounts.get(t.termsPerYear) ?? 0) + 1);
      const tpy = [...tpyCounts.entries()].sort((a, b) => b[1] - a[1])[0]![0];
      unit = subYear.find((t) => t.termsPerYear === tpy)!.unit;
      // Each row covers a range of terms in this unit: a semester row one term,
      // a year-only row ("Year 2") every term of that year.
      const ranges = study.map((t): [number, number] => {
        if (t.unit === "year") {
          const y = t.yearOfStudy ?? 1;
          return [(y - 1) * tpy + 1, y * tpy];
        }
        const hi = Math.ceil((t.termIndex! / t.termsPerYear) * tpy);
        const lo = Math.max(1, Math.ceil(((t.termIndex! - 1) / t.termsPerYear) * tpy + 0.0001));
        return [Math.min(lo, hi), hi];
      });
      const minIdx = Math.min(...ranges.map((r) => r[0]));
      const maxIdx = Math.max(...ranges.map((r) => r[1]));
      const covered = new Set<number>();
      for (const [lo, hi] of ranges) for (let i = lo; i <= hi; i++) covered.add(i);
      const span = maxIdx - minIdx + 1;
      // The span actually studied (first to last term printed), not the
      // highest term number: a transcript printing semesters 3–8 is 3 years.
      counted = span / tpy;
      coverage = covered.size / span;
      finalYear = Math.ceil(maxIdx / tpy);
      method =
        minIdx === 1
          ? `${unit}s 1–${maxIdx} printed (${covered.size} of ${span} ${unit}s have subjects)`
          : `${unit}s ${minIdx}–${maxIdx} printed: ${span} ${unit}s studied (${covered.size} of ${span} have subjects)`;
      startsLate = minIdx > 1;
      printedSpan = { unit: unit as Exclude<TermUnit, "calendar">, first: minIdx, last: maxIdx };
    } else {
      unit = "year";
      const years = study.map((t) => t.yearOfStudy!);
      const minYear = Math.min(...years);
      const maxYear = Math.max(...years);
      const distinct = new Set(years).size;
      counted = maxYear - minYear + 1;
      coverage = distinct / counted;
      finalYear = maxYear;
      method =
        minYear === 1
          ? `years 1–${maxYear} printed (${distinct} of ${counted} years have subjects)`
          : `years ${minYear}–${maxYear} printed: ${counted} years studied (${distinct} of ${counted} have subjects)`;
      startsLate = minYear > 1;
      printedSpan = { unit: "year", first: minYear, last: maxYear };
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
  // Starting later than the first period and spanning under the minimum
  // programme length reads as a partial record (e.g. one year's results),
  // not a whole programme: not counted from the periods.
  if (startsLate && counted < evidenceConfig.gate.notEligibleBelowYears) {
    confidence = "low";
    method = `${method}; too short a span to be the whole programme`;
  }
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
    source: "terms",
    span: printedSpan,
  };
}

export function isReliableCount(c: DurationCount): boolean {
  return c.countedYears != null && c.confidence !== "low";
}

/** Credit context of one qualification (country, transcript texts, assessor credit total). */
export function creditContextOf(q: QualificationInfo | null | undefined): CreditContext {
  if (!q) return {};
  return {
    country: q.country ?? null,
    texts: q.texts ?? null,
    creditTotalOverride: q.creditTotalOverride ?? null,
  };
}

/** Rows and duration count for each qualification level on the case. */
export type LevelDurationBasis = {
  level: QualificationType;
  title: string | null;
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
      count: countDuration(atLevel, creditContextOf(q)),
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
    note: null,
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
