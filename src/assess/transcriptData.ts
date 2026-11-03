/**
 * Transcript data (wizard Phase 2): subject extraction from the transcripts
 * (moved here from the assessment step, which now reuses the saved result),
 * plus a per-qualification summary of what the transcript shows — counted
 * duration, credit total, final-year project and engineering share — with
 * assessor overrides.
 *
 * Storage (no schema change): overrides live on FieldSource rows per degree
 * level, fields "transcript.*"; extractedValue = value read from the
 * transcript, finalValue = assessor value (null = use the transcript value).
 * The hash of the transcripts the saved subjects came from is kept on a
 * case-wide FieldSource row "transcript.extraction" (degreeLevel null).
 * GET /cases/:id and the draft save skip "transcript.*" rows.
 */
import { prisma } from "../lib/prisma.js";
import {
  AWARD_LEVEL_FIELD,
  FIELD_OF_STUDY_FIELD,
  awardLabel,
  fieldOfStudyFromTitle,
  parseAwardLevel,
} from "./awardDetails.js";
import { assessConfig } from "./config.js";
import {
  degreeLevelToQualification,
  extractSubjectsDetailed,
  hashAssessmentInput,
  hashSubjectInput,
  type TranscriptSource,
} from "./extractSubjects.js";
import { awardLevelOf, rowsFor } from "./gate1.js";
import {
  lateralEntryView,
  lateralStateOf,
  priorStudyDocumentIds,
  type LateralEntryView,
} from "./lateralEntry.js";
import type { QualificationInfo } from "./qualificationCheck.js";
import {
  applyTextPeriods,
  countDuration,
  creditContextOf,
  decideEngineering,
  isReliableCount,
  parseTerm,
  withTermIndex,
  type DurationCount,
  type TermInfo,
} from "./qualificationEvidence.js";
import {
  isDiplomaLevel,
  type ExtractedSubjectRow,
  type ExtractionPartial,
  type ExtractionReport,
  type Gate1AwardLevel,
  type QualificationType,
  type TermUnit,
} from "./schemas.js";

export const TRANSCRIPT_FIELD_PREFIX = "transcript.";
export const TRANSCRIPT_FIELDS = {
  countedYears: "transcript.countedYears",
  creditTotal: "transcript.creditTotal",
  finalProject: "transcript.finalProject",
  engineeringShare: "transcript.engineeringShare",
} as const;
/** Case-wide row: extractedValue = subject hash of the saved subjects. */
export const TRANSCRIPT_EXTRACTION_FIELD = "transcript.extraction";

export type TranscriptOverrideKey = keyof typeof TRANSCRIPT_FIELDS;

export type TranscriptOverrides = {
  countedYears: number | null;
  creditTotal: number | null;
  finalProject: string | null;
  /** 0–1. */
  engineeringShare: number | null;
};

type FieldSourceLike = {
  field: string;
  degreeLevel: string | null;
  extractedValue: string | null;
  finalValue: string | null;
};

type TranscriptDoc = {
  id: string;
  text: string | null;
  degreeLevel: string | null;
  createdAt: Date;
};

type QualificationRow = {
  degreeLevel: string;
  degreeTitle: string | null;
  country: string | null;
  institution: string | null;
};

// ---------------------------------------------------------------------------
// Helpers moved from assessCase.ts (ordering, DB rows, document levels)
// ---------------------------------------------------------------------------

const LEVEL_RANK: Record<string, number> = { bachelor: 0, master: 1 };

/** Bachelor transcripts first, then Master's, then others; stable by upload time / id. */
export function sortTranscripts<
  T extends { id: string; degreeLevel: string | null; createdAt: Date },
>(docs: T[]): T[] {
  return [...docs].sort((a, b) => {
    const ra = LEVEL_RANK[a.degreeLevel ?? ""] ?? 2;
    const rb = LEVEL_RANK[b.degreeLevel ?? ""] ?? 2;
    if (ra !== rb) return ra - rb;
    const ta = a.createdAt.getTime();
    const tb = b.createdAt.getTime();
    if (ta !== tb) return ta - tb;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

export function rowFromDb(s: {
  name: string;
  code: string | null;
  credits: string | null;
  grade: string | null;
  yearOrSemester: string | null;
  qualification: string;
  sourceSnippet: string | null;
  isRepeat: boolean;
  documentId: string | null;
}): ExtractedSubjectRow {
  return {
    name: s.name,
    code: s.code,
    credits: s.credits,
    grade: s.grade,
    yearOrSemester: s.yearOrSemester,
    qualification: s.qualification as QualificationType,
    sourceSnippet: s.sourceSnippet,
    isRepeat: s.isRepeat,
    documentId: s.documentId,
  };
}

/**
 * Empty-extraction guard: when a fresh extraction returns no subjects but
 * subjects were saved earlier, keep the saved ones instead of wiping them.
 */
export function chooseSubjectsAfterExtraction(
  fresh: ExtractedSubjectRow[],
  saved: ExtractedSubjectRow[],
): { rows: ExtractedSubjectRow[]; keptSaved: boolean } {
  if (!fresh.length && saved.length) return { rows: saved, keptSaved: true };
  return { rows: fresh, keptSaved: false };
}

/**
 * Tag rows with their transcript's level when the row has none yet (or only a
 * diploma-family level the document refines, e.g. diploma → associate degree).
 * Bachelor / Master's rows are never changed.
 */
export function applyDocumentLevels(
  rows: ExtractedSubjectRow[],
  documents: Array<{ id: string; level: QualificationType | "unknown" }>,
): ExtractedSubjectRow[] {
  const byId = new Map(documents.map((d) => [d.id, d.level]));
  const only = documents.length === 1 ? documents[0]!.level : null;
  return rows.map((r) => {
    const level = (r.documentId ? byId.get(r.documentId) : null) ?? only;
    if (!level || level === "unknown" || level === r.qualification) return r;
    if (r.qualification !== "unknown" && !isDiplomaLevel(r.qualification)) return r;
    if (r.qualification !== "unknown" && !isDiplomaLevel(level)) return r;
    return { ...r, qualification: level };
  });
}

export async function persistExtractedSubjects(
  caseId: string,
  rows: ExtractedSubjectRow[],
  transcripts: Array<{ id: string }>,
) {
  await prisma.extractedSubject.deleteMany({ where: { caseId } });
  if (!rows.length) return;
  // Each row keeps the transcript it came from; fall back to the only
  // transcript when there is exactly one (older rows had no documentId).
  const fallbackDocId = transcripts.length === 1 ? transcripts[0]!.id : null;
  await prisma.extractedSubject.createMany({
    data: rows.map((r, i) => ({
      caseId,
      documentId: r.documentId ?? fallbackDocId,
      name: r.name,
      code: r.code ?? null,
      credits: r.credits ?? null,
      grade: r.grade ?? null,
      yearOrSemester: r.yearOrSemester ?? null,
      qualification: r.qualification,
      sourceSnippet: r.sourceSnippet ?? null,
      isRepeat: r.isRepeat ?? false,
      sortOrder: i,
    })),
  });
}

// ---------------------------------------------------------------------------
// Case context shared by the assessment and the transcript-data endpoints
// ---------------------------------------------------------------------------

/** Finished transcripts with text, in deterministic order. */
export function usableTranscripts<T extends TranscriptDoc & { type: string; status: string }>(
  documents: T[],
  /** Prior-study transcripts (lateral entry): never part of the qualification's own subjects. */
  exclude?: ReadonlySet<string>,
): T[] {
  return sortTranscripts(
    documents.filter(
      (d) =>
        d.type === "TRANSCRIPT" &&
        d.status === "DONE" &&
        d.text?.trim() &&
        !exclude?.has(d.id),
    ),
  );
}

/**
 * Lateral-entry view for the bachelor (built over every qualification, as
 * the gate is). Null when the case has no bachelor being assessed.
 */
export function lateralEntryForCase(input: {
  infos: readonly QualificationInfo[];
  rows: readonly ExtractedSubjectRow[];
  fieldSources: readonly FieldSourceLike[];
  documents?: ReadonlyArray<{
    id: string;
    originalName: string;
    format: string;
    status: string;
    error?: string | null;
  }>;
}): LateralEntryView | null {
  const q = input.infos.find((i) => (i.rawLevel ?? i.level) === "bachelor");
  if (!q) return null;
  const summaries = buildQualificationSummaries([q, ...input.infos.filter((i) => i !== q)], input.rows, input.fieldSources);
  return lateralEntryView({
    summaries: summaries.slice(0, 1),
    rows: rowsFor(q, input.rows, input.infos.length === 1),
    texts: q.texts ?? [],
    title: q.title,
    state: lateralStateOf(input.fieldSources),
    documents: input.documents,
  });
}

export function subjectHashOf(transcripts: TranscriptDoc[]): string {
  return hashSubjectInput(
    transcripts.map((t) => ({ id: t.id, text: t.text ?? "", degreeLevel: t.degreeLevel })),
  );
}

/** Qualification level of a transcript (refined by the title on file for its DB level). */
export function documentLevelResolver(qualifications: QualificationRow[]) {
  const titleByLevel = new Map(
    qualifications.map((q) => [String(q.degreeLevel), q.degreeTitle ?? null]),
  );
  return (t: { degreeLevel: string | null }) =>
    degreeLevelToQualification(t.degreeLevel, t.degreeLevel ? titleByLevel.get(t.degreeLevel) : null);
}

function num(value: string | null | undefined): number | null {
  if (value == null || value.trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function fieldValue(
  fieldSources: readonly FieldSourceLike[],
  field: string,
  degreeLevel: string | null,
): FieldSourceLike | undefined {
  return fieldSources.find((f) => f.field === field && (f.degreeLevel ?? null) === degreeLevel);
}

/** Assessor overrides saved for one DB degree level. */
export function overridesFor(
  fieldSources: readonly FieldSourceLike[],
  degreeLevel: string,
): TranscriptOverrides {
  const get = (k: TranscriptOverrideKey) => fieldValue(fieldSources, TRANSCRIPT_FIELDS[k], degreeLevel)?.finalValue ?? null;
  const project = get("finalProject")?.trim();
  return {
    countedYears: num(get("countedYears")),
    creditTotal: num(get("creditTotal")),
    finalProject: project ? project : null,
    engineeringShare: num(get("engineeringShare")),
  };
}

/** Gate / routing input for each qualification, with Phase 1–3 assessor values. */
export function qualificationInfosFor(
  qualifications: QualificationRow[],
  transcripts: TranscriptDoc[],
  fieldSources: readonly FieldSourceLike[],
): QualificationInfo[] {
  return qualifications.map((q) => {
    const raw = String(q.degreeLevel);
    const overrides = overridesFor(fieldSources, raw);
    const fieldOfStudy = fieldValue(fieldSources, FIELD_OF_STUDY_FIELD, raw)?.finalValue?.trim() || null;
    const awardOverride = parseAwardLevel(fieldValue(fieldSources, AWARD_LEVEL_FIELD, raw)?.finalValue);
    return {
      level: degreeLevelToQualification(q.degreeLevel, q.degreeTitle),
      title: q.degreeTitle ?? null,
      rawLevel: raw,
      country: q.country ?? null,
      institution: q.institution ?? null,
      // Transcript text at this level, so routing can spot a qualification code.
      texts: transcripts
        .filter((t) => t.degreeLevel === raw || (!t.degreeLevel && qualifications.length === 1))
        .map((t) => t.text ?? ""),
      ...(fieldOfStudy ? { fieldOfStudy } : {}),
      ...(awardOverride ? { awardOverride } : {}),
      ...(overrides.countedYears != null ? { countedYearsOverride: overrides.countedYears } : {}),
      ...(overrides.creditTotal != null ? { creditTotalOverride: overrides.creditTotal } : {}),
      ...(overrides.engineeringShare != null ? { engineeringShareOverride: overrides.engineeringShare } : {}),
    };
  });
}

/** Assessor values that change the gate (part of the scoring cache key when set). */
export function gateOverridesOf(infos: readonly QualificationInfo[]) {
  const parts = infos
    .map((q) => ({
      level: q.rawLevel ?? q.level,
      // Only a field of study the title does not already name changes the gate.
      fieldOfStudy:
        q.fieldOfStudy && !(q.title ?? "").toLowerCase().includes(q.fieldOfStudy.toLowerCase())
          ? q.fieldOfStudy
          : null,
      awardOverride: q.awardOverride ?? null,
      countedYearsOverride: q.countedYearsOverride ?? null,
      engineeringShareOverride: q.engineeringShareOverride ?? null,
      // A credit total only changes the gate through the credits → years conversion.
      ...(q.creditTotalOverride != null ? { creditTotalOverride: q.creditTotalOverride } : {}),
    }))
    .filter(
      (p) =>
        p.fieldOfStudy != null ||
        p.awardOverride != null ||
        p.countedYearsOverride != null ||
        p.engineeringShareOverride != null ||
        p.creditTotalOverride != null,
    );
  return parts.length ? parts : null;
}

export async function readSavedSubjectHash(caseId: string): Promise<string | null> {
  const row = await prisma.fieldSource.findFirst({
    where: { caseId, field: TRANSCRIPT_EXTRACTION_FIELD, degreeLevel: null },
  });
  return row?.extractedValue ?? null;
}

/**
 * Saved-subject record. A partial read keeps "partial:<hash>" (never current)
 * and the failure details as JSON in finalValue.
 */
async function saveSubjectHash(caseId: string, subjectHash: string, partial?: ExtractionPartial) {
  const finalValue = partial ? JSON.stringify(partial) : subjectHash;
  const existing = await prisma.fieldSource.findFirst({
    where: { caseId, field: TRANSCRIPT_EXTRACTION_FIELD, degreeLevel: null },
  });
  if (existing) {
    await prisma.fieldSource.update({
      where: { id: existing.id },
      data: { extractedValue: subjectHash, finalValue },
    });
  } else {
    await prisma.fieldSource.create({
      data: {
        caseId,
        field: TRANSCRIPT_EXTRACTION_FIELD,
        degreeLevel: null,
        extractedValue: subjectHash,
        finalValue,
      },
    });
  }
}

/** Failure details of the last partial read (null when the last read was complete). */
export async function readSavedExtractionPartial(caseId: string): Promise<ExtractionPartial | null> {
  const row = await prisma.fieldSource.findFirst({
    where: { caseId, field: TRANSCRIPT_EXTRACTION_FIELD, degreeLevel: null },
  });
  return partialFromSaved(row?.extractedValue ?? null, row?.finalValue ?? null);
}

export function partialFromSaved(
  savedHash: string | null,
  finalValue: string | null,
): ExtractionPartial | null {
  if (!savedHash?.startsWith(PARTIAL_HASH_PREFIX)) return null;
  try {
    const v = JSON.parse(finalValue ?? "") as Partial<ExtractionPartial>;
    return {
      failedChunks: typeof v.failedChunks === "number" ? v.failedChunks : 1,
      pages: Array.isArray(v.pages) ? v.pages.filter((n) => typeof n === "number") : [],
      reasons: Array.isArray(v.reasons) ? v.reasons.map(String) : [],
    };
  } catch {
    return { failedChunks: 1, pages: [], reasons: [] };
  }
}

/**
 * True when the saved subjects came from these transcripts: the transcript
 * data record wins, then the last assessment's extraction record, then the
 * legacy v1 hash (old rows without any record).
 */
export function savedSubjectsAreCurrent(input: {
  persistedCount: number;
  subjectHash: string;
  savedHash: string | null;
  previousExtraction?: ExtractionReport;
  legacyHashMatches: boolean;
}): boolean {
  if (!input.persistedCount) return false;
  if (input.savedHash) return input.savedHash === input.subjectHash;
  if (input.previousExtraction) return input.previousExtraction.subjectHash === input.subjectHash;
  return input.legacyHashMatches;
}

/** Saved-hash marker for a partial read: never equals a real subject hash. */
export const PARTIAL_HASH_PREFIX = "partial:";

/** One clean line for the UI when some transcript pages could not be read. */
export const PARTIAL_READ_WARNING = "Some pages couldn't be read.";

export function partialReportOf(
  failed: Array<{ pages: number[]; reason: string }>,
): ExtractionPartial {
  return {
    failedChunks: failed.length,
    pages: [...new Set(failed.flatMap((f) => f.pages))].sort((a, b) => a - b),
    reasons: [...new Set(failed.map((f) => f.reason))],
  };
}

export type ResolvedSubjects = {
  rows: ExtractedSubjectRow[];
  extraction: ExtractionReport;
  /** False when this run produced no usable fresh subjects (do not cache). */
  cacheable: boolean;
};

/**
 * Subjects for the case: reuse the saved subjects when they came from the
 * same transcripts (and no re-read is forced), else extract with the LLM and
 * save them. Null when there are no subjects and none can be extracted.
 * Rows come back tagged with their document level and term index.
 */
export async function resolveSubjects(input: {
  caseId: string;
  transcripts: TranscriptDoc[];
  persistedRows: ExtractedSubjectRow[];
  subjectHash: string;
  savedHash: string | null;
  previousExtraction?: ExtractionReport;
  legacyHashMatches: boolean;
  docLevel: (t: { degreeLevel: string | null }) => QualificationType | "unknown";
  force?: boolean;
  /**
   * Saved subjects only (Assessment step re-run): never extract with the LLM.
   * Saved rows are used even when the transcripts changed since they were
   * read (the result is then not cached); null when nothing is saved.
   */
  savedOnly?: boolean;
  useLlm: boolean;
  deadlineMs: number;
  /** Test hook: replaces the Groq subject read. */
  extract?: typeof extractSubjectsDetailed;
}): Promise<ResolvedSubjects | null> {
  const { caseId, transcripts, persistedRows, subjectHash } = input;
  const current = savedSubjectsAreCurrent({
    persistedCount: persistedRows.length,
    subjectHash,
    savedHash: input.savedHash,
    previousExtraction: input.previousExtraction,
    legacyHashMatches: input.legacyHashMatches,
  });

  let rows: ExtractedSubjectRow[];
  let extraction: ExtractionReport;
  let cacheable = true;
  if ((!input.force || input.savedOnly) && current) {
    rows = persistedRows;
    extraction = { subjectHash, source: "persisted" };
  } else if (input.savedOnly) {
    if (!persistedRows.length) return null;
    rows = persistedRows;
    const savedPartial = input.savedHash?.startsWith(PARTIAL_HASH_PREFIX)
      ? await readSavedExtractionPartial(caseId)
      : null;
    extraction = {
      subjectHash: savedPartial ? "" : (input.savedHash ?? input.previousExtraction?.subjectHash ?? ""),
      source: "persisted",
      ...(savedPartial ? { partial: savedPartial } : {}),
    };
    cacheable = false;
  } else if (input.useLlm && transcripts.length) {
    const sources: TranscriptSource[] = transcripts.map((t) => ({
      documentId: t.id,
      text: t.text!,
      degreeLevelHint: input.docLevel(t),
    }));
    const read = await (input.extract ?? extractSubjectsDetailed)(sources, { deadlineMs: input.deadlineMs });
    const fresh = read.rows;
    const partial = read.partial ? partialReportOf(read.failedChunks) : undefined;
    const choice = chooseSubjectsAfterExtraction(fresh, persistedRows);
    rows = choice.rows;
    if (choice.keptSaved) {
      // Extraction returned nothing — keep the saved subjects (not overwritten)
      // and keep their original transcript hash.
      extraction = {
        subjectHash: input.savedHash ?? input.previousExtraction?.subjectHash ?? "",
        source: "persisted",
        ...(partial ? { partial } : {}),
      };
      cacheable = false;
    } else if (partial) {
      // Some pages could not be read: show what was read, but never mark it
      // current, so the next run reads the transcripts again.
      extraction = { subjectHash: "", source: "llm", partial };
      await persistExtractedSubjects(caseId, rows, transcripts);
      await saveSubjectHash(caseId, `${PARTIAL_HASH_PREFIX}${subjectHash}`, partial);
      cacheable = false;
    } else {
      extraction = { subjectHash, source: "llm" };
      await persistExtractedSubjects(caseId, rows, transcripts);
      if (rows.length) await saveSubjectHash(caseId, subjectHash);
      else cacheable = false;
    }
  } else if (persistedRows.length) {
    rows = persistedRows;
    extraction = { subjectHash, source: "persisted" };
  } else {
    return null;
  }

  // Saved rows from diploma-level transcripts were stored as "unknown" before
  // diploma levels existed: tag them from their document now.
  // Year / semester from the heading each subject is printed under, when the
  // read did not give one (saved rows included, no re-extraction needed).
  rows = applyTextPeriods(
    applyDocumentLevels(
      rows,
      transcripts.map((t) => ({ id: t.id, level: input.docLevel(t) })),
    ),
    transcripts,
  ).map(withTermIndex);
  return { rows, extraction, cacheable };
}

// ---------------------------------------------------------------------------
// Summary (what Phase 2 shows and Phase 3 checks)
// ---------------------------------------------------------------------------

export type DurationCheckStatus =
  /** Entered by the assessor in Transcript data (or Verify details). */
  | "edited"
  /** Counted from the printed years / semesters. */
  | "transcript"
  /** Converted from the credit total (no usable years / semesters). */
  | "credits"
  /** Nothing counted or entered: the case goes to manual review. */
  | "missing";

export type TranscriptFinalProject = {
  title: string;
  term: string | null;
  inFinalYear: boolean | null;
};

export type QualificationTranscriptSummary = {
  degreeLevel: string;
  title: string | null;
  fieldOfStudy: string | null;
  award: Gate1AwardLevel;
  awardLabel: string;
  aqfLevel: number | null;
  /** True when the award level was chosen by the assessor. */
  awardManual: boolean;
  /** Award level read from the title (shown when it differs from the chosen one). */
  detectedAward: Gate1AwardLevel;
  subjectCount: number;
  transcript: {
    countedYears: number | null;
    /** Count of semesters / trimesters / quarters (null for year-based or no count). */
    terms: number | null;
    unit: TermUnit | null;
    confidence: DurationCount["confidence"];
    reliable: boolean;
    method: string;
    rowsWithTerm: number;
    /** First and last period printed, e.g. semester 3 → 8 (null when not counted from periods). */
    periodRange: { unit: "semester" | "trimester" | "quarter" | "year"; first: number; last: number } | null;
    creditTotal: number | null;
    finalProject: TranscriptFinalProject | null;
    engineeringShare: number | null;
  };
  overrides: TranscriptOverrides;
  effective: {
    countedYears: number | null;
    creditTotal: number | null;
    finalProject: TranscriptFinalProject | null;
    engineeringShare: number | null;
  };
  /** Duration the gate uses and where it comes from. */
  basis: "counted" | "manual" | "none";
  basisLabel: string;
  /**
   * Flag text when the counted duration was converted from the credit total
   * (no usable years / semesters), e.g. "Converted from credits (240 credits ÷ 60 per year)".
   */
  creditConversion: string | null;
  showEngineeringShare: boolean;
  durationCheck: {
    status: DurationCheckStatus;
    /** False when no duration is available (the case goes to manual review). */
    ok: boolean;
    message: string;
  };
};

export type TranscriptDataSummary = {
  transcriptCount: number;
  subjectCount: number;
  /** Saved subjects came from the current transcripts. */
  subjectsCurrent: boolean;
  source: ExtractionReport["source"] | null;
  /** Every qualification has a duration (else Gate 1 sends the case to manual review). */
  durationOk: boolean;
  message: string | null;
  /**
   * One line when the last read missed some transcript pages (the subjects
   * are incomplete and will be read again); null otherwise.
   */
  readWarning: string | null;
  qualifications: QualificationTranscriptSummary[];
  /** Lateral-entry check for the bachelor (null when there is no bachelor). */
  lateralEntry: LateralEntryView | null;
};

const PROJECT_RE = /\b(?:project|thesis|capstone|dissertation)\b/i;
const MAJOR_PROJECT_RE = /\b(?:final|major|capstone|thesis|dissertation|honours)\b/i;
const TERMS_PER_YEAR: Partial<Record<TermUnit, number>> = { semester: 2, trimester: 3, quarter: 4 };

function yearOf(t: TermInfo): number | null {
  return t.unit === "calendar" ? t.academicYear : t.yearOfStudy;
}

function sortKey(t: TermInfo): number {
  return t.unit === "calendar" ? (t.academicYear ?? 0) * 10 + (t.termInYear ?? 0) : (t.termIndex ?? 0) / t.termsPerYear;
}

/** Final-year project read from subject names (latest project / thesis row). */
export function findFinalProject(
  rows: readonly ExtractedSubjectRow[],
  finalYear: number | null,
): TranscriptFinalProject | null {
  const candidates = rows
    .filter((r) => !r.isRepeat && PROJECT_RE.test(r.name))
    .map((r, i) => ({ r, i, t: parseTerm(r.yearOrSemester) }));
  if (!candidates.length) return null;
  candidates.sort((a, b) => {
    const ka = a.t ? sortKey(a.t) : -1;
    const kb = b.t ? sortKey(b.t) : -1;
    if (ka !== kb) return kb - ka;
    const ma = MAJOR_PROJECT_RE.test(a.r.name) ? 1 : 0;
    const mb = MAJOR_PROJECT_RE.test(b.r.name) ? 1 : 0;
    if (ma !== mb) return mb - ma;
    return a.i - b.i;
  });
  const pick = candidates[0]!;
  const year = pick.t ? yearOf(pick.t) : null;
  return {
    title: pick.r.name.trim(),
    term: pick.t?.label ?? null,
    inFinalYear: year != null && finalYear != null ? year >= finalYear : null,
  };
}

const fmtYears = (n: number) => `${n} year${n === 1 ? "" : "s"}`;

function durationCheckFor(
  basis: QualificationTranscriptSummary["basis"],
  counted: number | null,
  creditConversion: string | null,
): QualificationTranscriptSummary["durationCheck"] {
  if (counted == null || basis === "none") {
    return {
      status: "missing",
      ok: false,
      message:
        "The duration could not be counted from the transcript. Enter it here or in Transcript data, otherwise the case goes to manual review.",
    };
  }
  if (basis === "manual") {
    return { status: "edited", ok: true, message: `${fmtYears(counted)}, entered by the assessor.` };
  }
  if (creditConversion) {
    return { status: "credits", ok: true, message: creditConversion };
  }
  return { status: "transcript", ok: true, message: `${fmtYears(counted)}, counted from the transcript.` };
}

/** Per-qualification summary (pure; rows must carry document levels). */
export function buildQualificationSummaries(
  infos: readonly QualificationInfo[],
  rows: readonly ExtractedSubjectRow[],
  fieldSources: readonly FieldSourceLike[],
): QualificationTranscriptSummary[] {
  const single = infos.length === 1;
  return infos.map((q) => {
    const raw = q.rawLevel ?? q.level;
    const levelRows = rowsFor(q, rows, single);
    const overrides = overridesFor(fieldSources, raw);
    // Assessor's entry → printed years / semesters → credits (assessor total first).
    const count = countDuration(levelRows, {
      ...creditContextOf(q),
      creditTotalOverride: overrides.creditTotal,
    });
    const reliable = isReliableCount(count);
    const countedAuto = reliable ? count.countedYears : null;
    const tpy = count.unit ? TERMS_PER_YEAR[count.unit] : undefined;
    const project = findFinalProject(levelRows, count.finalYear);
    const share = levelRows.length
      ? decideEngineering({ qualifications: [q], rows: levelRows }).subjectShare
      : null;
    const { award, aqfLevel } = awardLevelOf(q);
    const detected = awardLevelOf({ ...q, awardOverride: null });
    const entered = overrides.countedYears ?? q.countedYearsOverride ?? null;
    const counted = entered ?? countedAuto;
    const manual = entered != null;
    const basis: QualificationTranscriptSummary["basis"] = manual
      ? "manual"
      : countedAuto != null
        ? "counted"
        : "none";
    const creditConversion = basis === "counted" ? count.creditConversion?.label ?? null : null;
    const basisLabel =
      basis === "manual"
        ? "Counted duration entered manually"
        : basis === "counted"
          ? count.creditConversion
            ? count.creditConversion.label
            : `Counted from the transcript (${count.method})`
          : `No duration available: ${count.method}`;
    const finalProject: TranscriptFinalProject | null = overrides.finalProject
      ? { title: overrides.finalProject, term: null, inFinalYear: null }
      : project;
    return {
      degreeLevel: raw,
      title: q.title,
      fieldOfStudy: q.fieldOfStudy ?? fieldOfStudyFromTitle(q.title),
      award,
      awardLabel: awardLabel(award),
      aqfLevel,
      awardManual: Boolean(q.awardOverride),
      detectedAward: detected.award,
      subjectCount: levelRows.filter((r) => !r.isRepeat).length,
      transcript: {
        countedYears: countedAuto,
        terms: countedAuto != null && tpy ? Math.round(countedAuto * tpy) : null,
        unit: count.unit,
        confidence: count.confidence,
        reliable,
        method: count.method,
        rowsWithTerm: count.rowsWithTerm,
        periodRange: reliable && count.source === "terms" ? count.span ?? null : null,
        creditTotal: count.creditTotal,
        finalProject: project,
        engineeringShare: share,
      },
      overrides,
      effective: {
        countedYears: counted,
        creditTotal: overrides.creditTotal ?? count.creditTotal,
        finalProject,
        engineeringShare: overrides.engineeringShare ?? share,
      },
      basis,
      basisLabel,
      creditConversion,
      showEngineeringShare: award !== "certificate",
      durationCheck: durationCheckFor(basis, counted, creditConversion),
    };
  });
}

type CaseForTranscript = NonNullable<Awaited<ReturnType<typeof loadCase>>>;

function loadCase(caseId: string) {
  return prisma.case.findUnique({
    where: { id: caseId },
    include: {
      documents: { orderBy: [{ createdAt: "asc" }, { id: "asc" }] },
      qualifications: { orderBy: [{ degreeLevel: "asc" }, { id: "asc" }] },
      assessment: true,
      extractedSubjects: { orderBy: [{ sortOrder: "asc" }, { id: "asc" }] },
      fieldSources: true,
    },
  });
}

function previousExtractionOf(row: CaseForTranscript): ExtractionReport | undefined {
  const prev = (row.assessment?.resultJson ?? null) as { extraction?: ExtractionReport } | null;
  return prev?.extraction;
}

/**
 * Transcript data for Phase 2 / 3. mode "read" never calls the LLM; mode
 * "extract" extracts when the saved subjects are missing or stale (or force).
 * Subjects themselves are never returned (they are shown in the ANZSCO step).
 */
export async function getTranscriptData(
  caseId: string,
  opts: { mode: "read" | "extract"; force?: boolean; useLlm?: boolean } = { mode: "read" },
): Promise<TranscriptDataSummary | null> {
  let row = await loadCase(caseId);
  if (!row) return null;
  const transcripts = usableTranscripts(row.documents, priorStudyDocumentIds(row.fieldSources));
  const subjectHash = subjectHashOf(transcripts);
  const savedHash = await readSavedSubjectHash(caseId);
  const docLevel = documentLevelResolver(row.qualifications.map(asQualificationRow));
  const persistedRows = applyTextPeriods(row.extractedSubjects.map(rowFromDb), transcripts);
  const previousExtraction = previousExtractionOf(row);
  const legacyHashMatches = assessmentLegacyMatch(row, transcripts);
  let source: ExtractionReport["source"] | null = null;
  let message: string | null = null;
  let rows: ExtractedSubjectRow[] = [];

  if (opts.mode === "extract") {
    if (!transcripts.length && !persistedRows.length) {
      message = "No finished transcript to read. Upload a transcript in Upload & details.";
    } else {
      const resolved = await resolveSubjects({
        caseId,
        transcripts,
        persistedRows,
        subjectHash,
        savedHash,
        previousExtraction,
        legacyHashMatches,
        docLevel,
        force: opts.force,
        useLlm: opts.useLlm !== false,
        deadlineMs: Date.now() + assessConfig.timeoutMs,
      });
      if (!resolved) {
        message = "Could not read subjects from the transcript. Try again, or enter the values manually.";
      } else {
        rows = resolved.rows;
        source = resolved.extraction.source;
        if (!rows.length) message = "No subjects were found in the transcript. Enter the values manually or re-read.";
      }
      row = (await loadCase(caseId)) ?? row;
    }
  } else {
    rows = applyDocumentLevels(
      persistedRows,
      transcripts.map((t) => ({ id: t.id, level: docLevel(t) })),
    ).map(withTermIndex);
    if (persistedRows.length) source = "persisted";
    else if (!transcripts.length) message = "No finished transcript to read. Upload a transcript in Upload & details.";
  }

  const savedNow = await readSavedSubjectHash(caseId);
  const readWarning = savedNow?.startsWith(PARTIAL_HASH_PREFIX) ? PARTIAL_READ_WARNING : null;
  const subjectsCurrent = savedSubjectsAreCurrent({
    persistedCount: row.extractedSubjects.length,
    subjectHash,
    savedHash: savedNow,
    previousExtraction: previousExtractionOf(row),
    legacyHashMatches,
  });
  const infos = qualificationInfosFor(
    row.qualifications.map(asQualificationRow),
    transcripts,
    row.fieldSources,
  );
  // Built over every qualification (as the gate is), shown for the selected levels.
  const selected = new Set<string>(row.selectedDegreeLevels.map(String));
  const qualifications = buildQualificationSummaries(infos, rows, row.fieldSources).filter(
    (q) => !selected.size || selected.has(q.degreeLevel),
  );
  const lateralEntry =
    !selected.size || selected.has("bachelor")
      ? lateralEntryForCase({ infos, rows, fieldSources: row.fieldSources, documents: row.documents })
      : null;
  return {
    transcriptCount: transcripts.length,
    subjectCount: rows.filter((r) => !r.isRepeat).length,
    subjectsCurrent,
    source,
    durationOk: qualifications.every((q) => q.durationCheck.ok),
    message,
    readWarning,
    qualifications,
    lateralEntry,
  };
}

function asQualificationRow(q: CaseForTranscript["qualifications"][number]): QualificationRow {
  return {
    degreeLevel: String(q.degreeLevel),
    degreeTitle: q.degreeTitle ?? null,
    country: q.country ?? null,
    institution: q.institution ?? null,
  };
}

/** Old cases without any extraction record: subjects are current when the v1 hash matched. */
export function assessmentLegacyMatch(
  row: { documents: Array<{ type: string; status: string; text: string | null }>; assessment: { inputHash: string } | null },
  transcripts: TranscriptDoc[],
): boolean {
  if (!row.assessment) return false;
  // Latest finished CV wins (a re-upload replaces the older one).
  const cvDoc = [...row.documents].reverse().find((d) => d.type === "CV" && d.status === "DONE");
  const legacyHash = hashAssessmentInput(
    transcripts.map((t) => ({ id: t.id, text: t.text ?? "" })),
    cvDoc?.text ?? null,
  );
  return row.assessment.inputHash === legacyHash;
}

/** Save assessor values for one degree level (null clears a value). */
export async function saveTranscriptOverrides(
  caseId: string,
  degreeLevel: string,
  patch: Partial<TranscriptOverrides>,
): Promise<void> {
  const current = await getTranscriptData(caseId, { mode: "read" });
  const summary = current?.qualifications.find((q) => q.degreeLevel === degreeLevel);
  const extracted: Record<TranscriptOverrideKey, string | null> = {
    countedYears: summary?.transcript.countedYears != null ? String(summary.transcript.countedYears) : null,
    creditTotal: summary?.transcript.creditTotal != null ? String(summary.transcript.creditTotal) : null,
    finalProject: summary?.transcript.finalProject?.title ?? null,
    engineeringShare: summary?.transcript.engineeringShare != null ? String(summary.transcript.engineeringShare) : null,
  };
  for (const key of Object.keys(patch) as TranscriptOverrideKey[]) {
    if (!(key in TRANSCRIPT_FIELDS)) continue;
    const value = patch[key];
    const finalValue = value == null || value === "" ? null : String(value);
    await prisma.fieldSource.upsert({
      where: {
        caseId_field_degreeLevel: {
          caseId,
          field: TRANSCRIPT_FIELDS[key],
          degreeLevel: degreeLevel as never,
        },
      },
      create: {
        caseId,
        field: TRANSCRIPT_FIELDS[key],
        degreeLevel: degreeLevel as never,
        extractedValue: extracted[key],
        finalValue,
      },
      update: { extractedValue: extracted[key], finalValue },
    });
  }
}
