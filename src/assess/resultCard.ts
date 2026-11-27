import type { ExtractedSubjectRow, QualificationType } from "./schemas.js";

/**
 * Board result cards (PBTE and the same yearly marks-sheet layout) are often
 * uploaded as certificates. A page that prints a subject / marks table is
 * still a transcript: its rows are read here, and yearly cards that share a
 * registration number are one qualification.
 */

const YEAR_WORD: Record<string, number> = {
  first: 1,
  "1st": 1,
  second: 2,
  "2nd": 2,
  third: 3,
  "3rd": 3,
  fourth: 4,
  "4th": 4,
  fifth: 5,
  "5th": 5,
};

const CODE_RE =
  /(?:^|[\s|])(?:(\d{1,2})\s+\|?\s*)?([A-Z]{2,5}\d[A-Z0-9]{0,6}|(?:GEN|ENG|MATH|COMP|PHY|MGM|CH|ET|EL|EE)[A-Z0-9]{1,6})(?![A-Z])(?:\s*\(?[A-Z.]{0,8}\)?)?\s*[-–—]\s*/gi;

export type ResultCard = {
  registrationNumber: string | null;
  examYear: number | null;
  studyYear: number | null;
  /** "Electrical Technology" */
  program: string | null;
  /** Diploma of Associate Engineer. */
  dae: boolean;
  board: string | null;
  subjects: ExtractedSubjectRow[];
};

export type CombinedResultCards = {
  registrationNumber: string;
  title: string;
  years: number;
  completionYear: number | null;
  degreeLevel: "diploma";
};

/** True when the page prints a subject column and a marks column. */
export function isSubjectMarksTable(text: string | null | undefined): boolean {
  if (!text) return false;
  return (
    /subjects?\s*\/\s*papers/i.test(text) &&
    /maximum\s+marks/i.test(text) &&
    /marks\s+obtained/i.test(text)
  );
}

function titleCase(value: string): string {
  return value
    .toLowerCase()
    .replace(/(^|[^a-z0-9])([a-z])/g, (_, lead: string, ch: string) => lead + ch.toUpperCase())
    .replace(/\b(Of|And|In|The|A|To)\b/g, (word) => word.toLowerCase());
}

function wordYear(raw: string | undefined): number | null {
  if (!raw) return null;
  const key = raw.toLowerCase();
  if (YEAR_WORD[key]) return YEAR_WORD[key];
  const n = Number(key);
  return n >= 1 && n <= 5 ? n : null;
}

function headerOf(text: string): string {
  return text.split(/detail is as under/i)[0] ?? text;
}

function cleanName(raw: string): string {
  let s = raw.replace(/\s+/g, " ").trim();
  s = s.split(/\s+\((?:paper|practical|sessional|theory)\b/i)[0] ?? s;
  s = s.split(/\s+\|/)[0] ?? s;
  s = s.replace(/\s+\d{2,4}\s*$/g, "").trim();
  s = s
    .replace(/\bPRINCIPALS\b/gi, "PRINCIPLES")
    .replace(/\bDISTRUBUTION\b/gi, "DISTRIBUTION")
    .replace(/\bDIGIIAL\b/gi, "DIGITAL")
    .replace(/\bFQUIPMENT\b/gi, "EQUIPMENT");
  const parts = s.split(/\s+/).filter(Boolean);
  for (let n = Math.floor(parts.length / 2); n >= 2; n--) {
    const a = parts.slice(0, n).join(" ");
    const b = parts.slice(n, n * 2).join(" ");
    if (a.toLowerCase() === b.toLowerCase()) {
      s = a;
      break;
    }
  }
  const words = s.split(/\s+/);
  const collapsed: string[] = [];
  for (const word of words) {
    if (collapsed.length && collapsed[collapsed.length - 1]!.toLowerCase() === word.toLowerCase()) continue;
    collapsed.push(word);
  }
  s = collapsed.join(" ");
  const first = collapsed[0]?.toLowerCase();
  if (first && collapsed.length >= 4) {
    const again = collapsed.findIndex((w, i) => i >= 2 && w.toLowerCase() === first);
    if (again > 0) s = collapsed.slice(0, again).join(" ");
  }
  s = titleCase(s).replace(/\s+/g, " ").trim();
  return s.slice(0, 120);
}

function subjectsIn(text: string, opts: {
  documentId?: string | null;
  qualification: QualificationType | "unknown";
  studyYear: number | null;
}): ExtractedSubjectRow[] {
  const body = text.split(/detail is as under/i)[1] ?? text;
  CODE_RE.lastIndex = 0;
  const matches = [...body.matchAll(CODE_RE)];
  const rows: ExtractedSubjectRow[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < matches.length; i++) {
    const match = matches[i]!;
    const code = match[2]!.toUpperCase();
    const start = (match.index ?? 0) + match[0].length;
    const end = matches[i + 1]?.index ?? body.length;
    const name = cleanName(body.slice(start, end));
    if (name.length < 3 || /^(practical|sessional|paper|theory)\b/i.test(name)) continue;
    const key = `${code}|${name.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({
      name,
      code,
      credits: null,
      grade: null,
      yearOrSemester: opts.studyYear != null ? `Year ${opts.studyYear}` : null,
      qualification: opts.qualification === "unknown" ? "diploma" : opts.qualification,
      sourceSnippet: body.slice(start, Math.min(end, start + 160)).replace(/\s+/g, " ").trim(),
      isRepeat: false,
      documentId: opts.documentId ?? null,
    });
  }
  return rows;
}

/** Award title for one card. Yearly cards are combined separately. */
export function resultCardTitle(card: ResultCard): string | null {
  if (card.dae && card.program) return `DAE ${card.program}`;
  if (card.program) return card.program;
  if (card.dae) return "Diploma of Associate Engineer";
  return null;
}

/** One yearly marks sheet. Null when the page has no subject / marks table. */
export function parseResultCard(
  text: string,
  opts?: {
    documentId?: string | null;
    qualification?: QualificationType | "unknown";
  },
): ResultCard | null {
  if (!isSubjectMarksTable(text)) return null;
  const head = headerOf(text);
  const registration = head.match(/registration\s*no\.?\s*[:.]?\s*([0-9]+(?:\s*-\s*[0-9]+)+)/i);
  const exam = head.match(/examination,?\s*((?:19|20)\d{2})/i);
  const yearRaw =
    head.match(/\(\s*(first|second|third|fourth|fifth|1st|2nd|3rd|4th|5th)\s+year\s*\)/i) ??
    head.match(/\b(first|second|third|fourth|fifth)\s+year\b/i);
  const program = head.match(/\b([A-Za-z]{3,})\s+technology\s*\(/i);
  const board = head.match(/([A-Z][A-Z .']{4,}?BOARD OF TECHNICAL EDUCATION)/i);
  const studyYear = wordYear(yearRaw?.[1]);
  const qualification = opts?.qualification ?? "diploma";
  return {
    registrationNumber: registration?.[1]?.replace(/\s+/g, "") ?? null,
    examYear: exam?.[1] ? Number(exam[1]) : null,
    studyYear,
    program: program?.[1] ? `${titleCase(program[1])} Technology` : null,
    dae: /diploma\s+of\s+associate\s+engineer/i.test(text),
    board: board?.[1] ? titleCase(board[1].replace(/\s+/g, " ").trim()) : null,
    subjects: subjectsIn(text, {
      documentId: opts?.documentId,
      qualification,
      studyYear,
    }),
  };
}

/**
 * Yearly cards that share a registration number are one diploma. The title
 * is "DAE {program}" when the award is Diploma of Associate Engineer.
 * Duration is the highest year of study printed (a third-year card is year 3).
 * Completion is the latest examination year.
 */
export function combineResultCards(cards: readonly ResultCard[]): CombinedResultCards | null {
  const grouped = new Map<string, ResultCard[]>();
  for (const card of cards) {
    if (!card.registrationNumber) continue;
    const list = grouped.get(card.registrationNumber) ?? [];
    list.push(card);
    grouped.set(card.registrationNumber, list);
  }
  let best: ResultCard[] | null = null;
  for (const list of grouped.values()) {
    if (!best || list.length > best.length) best = list;
  }
  if (!best?.length) return null;
  const program = best.map((c) => c.program).find(Boolean) ?? null;
  const dae = best.some((c) => c.dae);
  if (!dae && !program) return null;
  const studyYears = best.map((c) => c.studyYear).filter((n): n is number => n != null);
  const years = studyYears.length ? Math.max(...studyYears) : 0;
  if (years < 1) return null;
  const exams = best.map((c) => c.examYear).filter((n): n is number => n != null);
  const title = dae && program ? `DAE ${program}` : dae ? "Diploma of Associate Engineer" : program!;
  return {
    registrationNumber: best[0]!.registrationNumber!,
    title,
    years,
    completionYear: exams.length ? Math.max(...exams) : null,
    degreeLevel: "diploma",
  };
}

/** Subject rows from every marks-table document. Documents that yield none are left for the transcript reader. */
export function subjectsFromMarksTables(
  documents: readonly { id: string; text: string | null; degreeLevel?: string | null }[],
  levelOf: (doc: { degreeLevel?: string | null }) => QualificationType | "unknown",
): { rows: ExtractedSubjectRow[]; documentIds: Set<string> } {
  const rows: ExtractedSubjectRow[] = [];
  const documentIds = new Set<string>();
  for (const doc of documents) {
    if (!doc.text) continue;
    const level = levelOf(doc);
    const card = parseResultCard(doc.text, {
      documentId: doc.id,
      qualification: level === "unknown" ? "diploma" : level,
    });
    if (!card?.subjects.length) continue;
    documentIds.add(doc.id);
    rows.push(...card.subjects);
  }
  return { rows, documentIds };
}
