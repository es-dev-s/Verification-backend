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
import { evidenceConfig } from "./evidenceConfig.js";
import {
  degreeLevelToQualification,
  extractSubjectsFromTranscripts,
  hashAssessmentInput,
  hashSubjectInput,
  type TranscriptSource,
} from "./extractSubjects.js";
import { awardLevelOf, rowsFor } from "./gate1.js";
import type { QualificationInfo } from "./qualificationCheck.js";
import {
  countDuration,
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
  durationYears: number | null;
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
): T[] {
  return sortTranscripts(
    documents.filter((d) => d.type === "TRANSCRIPT" && d.status === "DONE" && d.text?.trim()),
  );
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
      durationYears: q.durationYears ?? null,
      country: q.country ?? null,
      institution: q.institution ?? null,
      // Transcript text at this level, so routing can spot a qualification code.
      texts: transcripts
        .filter((t) => t.degreeLevel === raw || (!t.degreeLevel && qualifications.length === 1))
        .map((t) => t.text ?? ""),
      ...(fieldOfStudy ? { fieldOfStudy } : {}),
      ...(awardOverride ? { awardOverride } : {}),
      ...(overrides.countedYears != null ? { countedYearsOverride: overrides.countedYears } : {}),
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
    }))
    .filter(
      (p) =>
        p.fieldOfStudy != null ||
        p.awardOverride != null ||
        p.countedYearsOverride != null ||
        p.engineeringShareOverride != null,
    );
  return parts.length ? parts : null;
}

export async function readSavedSubjectHash(caseId: string): Promise<string | null> {
  const row = await prisma.fieldSource.findFirst({
    where: { caseId, field: TRANSCRIPT_EXTRACTION_FIELD, degreeLevel: null },
  });
  return row?.extractedValue ?? null;
}

async function saveSubjectHash(caseId: string, subjectHash: string) {
  const existing = await prisma.fieldSource.findFirst({
    where: { caseId, field: TRANSCRIPT_EXTRACTION_FIELD, degreeLevel: null },
  });
  if (existing) {
    await prisma.fieldSource.update({
      where: { id: existing.id },
      data: { extractedValue: subjectHash, finalValue: subjectHash },
    });
  } else {
    await prisma.fieldSource.create({
      data: {
        caseId,
        field: TRANSCRIPT_EXTRACTION_FIELD,
        degreeLevel: null,
        extractedValue: subjectHash,
        finalValue: subjectHash,
      },
    });
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
  useLlm: boolean;
  deadlineMs: number;
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
  if (!input.force && current) {
    rows = persistedRows;
    extraction = { subjectHash, source: "persisted" };
  } else if (input.useLlm && transcripts.length) {
    const sources: TranscriptSource[] = transcripts.map((t) => ({
      documentId: t.id,
      text: t.text!,
      degreeLevelHint: input.docLevel(t),
    }));
    const fresh = await extractSubjectsFromTranscripts(sources, { deadlineMs: input.deadlineMs });
    const choice = chooseSubjectsAfterExtraction(fresh, persistedRows);
    rows = choice.rows;
    if (choice.keptSaved) {
      // Extraction returned nothing — keep the saved subjects (not overwritten)
      // and keep their original transcript hash.
      extraction = {
        subjectHash: input.savedHash ?? input.previousExtraction?.subjectHash ?? "",
        source: "persisted",
      };
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
  rows = applyDocumentLevels(
    rows,
    transcripts.map((t) => ({ id: t.id, level: input.docLevel(t) })),
  ).map(withTermIndex);
  return { rows, extraction, cacheable };
}

// ---------------------------------------------------------------------------
// Summary (what Phase 2 shows and Phase 3 checks)
// ---------------------------------------------------------------------------

export type DurationCheckStatus =
  /** Counted and stated agree within the tolerance. */
  | "match"
  /** Counted and stated differ by more than the tolerance: manual review. */
  | "mismatch"
  /** No reliable count: the stated duration is used (flagged). */
  | "fallback"
  /** Counted only: no stated duration on file. */
  | "no_stated"
  /** Neither stated nor counted. */
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
  statedYears: number | null;
  transcript: {
    countedYears: number | null;
    /** Count of semesters / trimesters / quarters (null for year-based or no count). */
    terms: number | null;
    unit: TermUnit | null;
    confidence: DurationCount["confidence"];
    reliable: boolean;
    method: string;
    rowsWithTerm: number;
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
  basis: "counted" | "manual" | "stated" | "none";
  basisLabel: string;
  /** True when the stated duration is used because the transcript could not be counted. */
  fallback: boolean;
  showEngineeringShare: boolean;
  durationCheck: {
    status: DurationCheckStatus;
    toleranceYears: number;
    differenceYears: number | null;
    /** True when this qualification may go on to the ANZSCO step. */
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
  toleranceYears: number;
  /** Every qualification passes the duration check. */
  durationOk: boolean;
  message: string | null;
  qualifications: QualificationTranscriptSummary[];
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

const EPS = 1e-9;
const fmtYears = (n: number) => `${n} year${n === 1 ? "" : "s"}`;

function durationCheckFor(
  stated: number | null,
  counted: number | null,
  manual: boolean,
  tol: number,
): QualificationTranscriptSummary["durationCheck"] {
  const base = { toleranceYears: tol };
  if (counted == null && stated == null) {
    return {
      ...base,
      status: "missing",
      differenceYears: null,
      ok: false,
      message: "No stated duration and the transcript could not be counted. Enter the stated or counted duration.",
    };
  }
  if (counted == null) {
    return {
      ...base,
      status: "fallback",
      differenceYears: null,
      ok: true,
      message: `The transcript could not be counted reliably; the stated duration (${fmtYears(stated!)}) will be used.`,
    };
  }
  if (stated == null) {
    return {
      ...base,
      status: "no_stated",
      differenceYears: null,
      ok: true,
      message: `No stated duration on file; the counted duration (${fmtYears(counted)}) will be used.`,
    };
  }
  const diff = Math.round(Math.abs(counted - stated) * 100) / 100;
  if (diff > tol + EPS) {
    return {
      ...base,
      status: "mismatch",
      differenceYears: diff,
      ok: false,
      message: `Stated (${fmtYears(stated)}) and counted (${fmtYears(counted)}${manual ? ", entered manually" : ""}) durations differ by ${fmtYears(diff)}, more than the ${fmtYears(tol)} tolerance.`,
    };
  }
  return {
    ...base,
    status: "match",
    differenceYears: diff,
    ok: true,
    message: `Stated and counted durations agree (within ${fmtYears(tol)}).`,
  };
}

/** Per-qualification summary (pure; rows must carry document levels). */
export function buildQualificationSummaries(
  infos: readonly QualificationInfo[],
  rows: readonly ExtractedSubjectRow[],
  fieldSources: readonly FieldSourceLike[],
): QualificationTranscriptSummary[] {
  const tol = evidenceConfig.duration.toleranceYears;
  const single = infos.length === 1;
  return infos.map((q) => {
    const raw = q.rawLevel ?? q.level;
    const levelRows = rowsFor(q, rows, single);
    const count = countDuration(levelRows);
    const reliable = isReliableCount(count);
    const countedAuto = reliable ? count.countedYears : null;
    const tpy = count.unit ? TERMS_PER_YEAR[count.unit] : undefined;
    const project = findFinalProject(levelRows, count.finalYear);
    const share = levelRows.length
      ? decideEngineering({ qualifications: [q], rows: levelRows }).subjectShare
      : null;
    const overrides = overridesFor(fieldSources, raw);
    const { award, aqfLevel } = awardLevelOf(q);
    const detected = awardLevelOf({ ...q, awardOverride: null });
    const counted = overrides.countedYears ?? countedAuto;
    const stated = q.durationYears ?? null;
    const manual = overrides.countedYears != null;
    const basis: QualificationTranscriptSummary["basis"] = manual
      ? "manual"
      : countedAuto != null
        ? "counted"
        : stated != null
          ? "stated"
          : "none";
    const basisLabel =
      basis === "manual"
        ? "Counted duration entered manually"
        : basis === "counted"
          ? `Counted from the transcript (${count.method})`
          : basis === "stated"
            ? `Stated duration used: ${count.method}`
            : "No duration available";
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
      statedYears: stated,
      transcript: {
        countedYears: countedAuto,
        terms: countedAuto != null && tpy ? Math.round(countedAuto * tpy) : null,
        unit: count.unit,
        confidence: count.confidence,
        reliable,
        method: count.method,
        rowsWithTerm: count.rowsWithTerm,
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
      fallback: basis === "stated",
      showEngineeringShare: award !== "certificate",
      durationCheck: durationCheckFor(stated, counted, manual, tol),
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
  const transcripts = usableTranscripts(row.documents);
  const subjectHash = subjectHashOf(transcripts);
  const savedHash = await readSavedSubjectHash(caseId);
  const docLevel = documentLevelResolver(row.qualifications.map(asQualificationRow));
  const persistedRows = row.extractedSubjects.map(rowFromDb);
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
  return {
    transcriptCount: transcripts.length,
    subjectCount: rows.filter((r) => !r.isRepeat).length,
    subjectsCurrent,
    source,
    toleranceYears: evidenceConfig.duration.toleranceYears,
    durationOk: qualifications.every((q) => q.durationCheck.ok),
    message,
    qualifications,
  };
}

function asQualificationRow(q: CaseForTranscript["qualifications"][number]): QualificationRow {
  return {
    degreeLevel: String(q.degreeLevel),
    degreeTitle: q.degreeTitle ?? null,
    durationYears: q.durationYears ?? null,
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
