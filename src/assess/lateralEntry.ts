/**
 * Lateral entry check (runs before the ANZSCO gate; see the lateral-entry flow).
 *
 * Step 1  the bachelor's programme duration (+ where it came from) and the
 *         first period on its transcript (consistency check only).
 * Step 2  ≥ 4 years → Route 1 (no question); missing → Route 4 (manual review);
 *         under 4 years → Step 3.
 * Step 3  ask whether the qualification was entered through lateral entry,
 *         credit transfer or advanced standing.
 * Step 4  "No": a later first period or credit / exemption entries is a
 *         contradiction → ask once more. No contradiction (or still "No") →
 *         Route 2 (assessed on its own duration; flagged when it fired).
 * Step 5  "Yes": upload the transcript of the earlier study.
 * Step 6  Route 3: the earlier study's subjects are added to the pool for the
 *         Foundational (Tier 1) subjects only; they never replace a match.
 *
 * Pure module: no DB, no LLM. State is stored in one FieldSource row
 * (`transcript.lateralEntry`, degree level "bachelor"); see lateralEntryStore.ts.
 */
import {
  BRIDGING_TEXT_RE,
  BRIDGING_TITLE_RE,
  CREDIT_GRADE_RE,
  CREDIT_NAME_RE,
  CREDIT_TEXT_RE,
  CREDIT_TITLE_RE,
} from "./gate1.js";
import type { RubricSubject } from "./loadRubric.js";
import { matchSubjectsSync, type MatchOptions } from "./matchSubjects.js";
import { parseTerm } from "./qualificationEvidence.js";
import {
  extractedSubjectSchema,
  type ExtractedSubjectRow,
  type Gate1AwardLevel,
  type SubjectMatch,
} from "./schemas.js";
import { z } from "zod";

/** FieldSource field holding the lateral-entry answers (prefix keeps it out of draft saves). */
export const LATERAL_FIELD = "transcript.lateralEntry";
/** The question is asked for the bachelor being assessed only. */
export const LATERAL_DEGREE_LEVEL = "bachelor";
/** Upload query value marking a prior-study transcript. */
export const PRIOR_STUDY_ROLE = "prior_study";

export const LATERAL_QUESTION =
  "The duration of your qualification is under four years. Did you enter this qualification through lateral entry, credit transfer or advanced standing based on previous study?";
export const LATERAL_RECONFIRM =
  "Your transcript shows information that can indicate entry with credit for previous study (for example, a later starting semester or credit entries). Please confirm again: did you enter this qualification through lateral entry, credit transfer or advanced standing?";
export const PRIOR_STUDY_PROMPT =
  "Please upload the transcript for the study you completed before entering this qualification (for example, a Diploma or Advanced Diploma).";

const FOUR_YEARS = 4;

// ---------------------------------------------------------------------------
// Stored state
// ---------------------------------------------------------------------------

export type LateralAnswerValue = "yes" | "no";

const answerSchema = z.object({ value: z.enum(["yes", "no"]), at: z.string() });

/** Decision snapshot kept for audit (see LateralAuditRecord). */
const auditSchema = z.object({
  at: z.string(),
  trigger: z.enum(["decision", "assessment"]),
  durationYears: z.number().nullable(),
  durationSource: z.string(),
  startPeriod: z.string().nullable(),
  answer: answerSchema.nullable(),
  confirm: answerSchema.nullable(),
  contradiction: z.object({ fired: z.boolean(), reasons: z.array(z.string()) }),
  admissionNote: z.string().nullable(),
  creditEntries: z.object({ rows: z.number(), noted: z.boolean() }),
  primarySubjects: z.array(z.string()),
  priorStudySubjects: z.array(z.string()),
  route: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]).nullable(),
  step: z.enum(["ask", "reconfirm", "upload", "done"]),
  reason: z.string(),
  flagged: z.boolean(),
});

const answersSchema = z.object({
  answer: answerSchema.nullable().optional().default(null),
  confirm: answerSchema.nullable().optional().default(null),
  priorDocumentIds: z.array(z.string()).optional().default([]),
  audit: auditSchema.nullable().optional().default(null),
});

const priorSubjectsSchema = z.object({
  documentIds: z.array(z.string()),
  rows: z.array(extractedSubjectSchema),
  at: z.string(),
});

const eventSchema = z.object({ at: z.string(), event: z.string() });

export type LateralAnswer = z.infer<typeof answerSchema>;
export type PriorSubjects = z.infer<typeof priorSubjectsSchema>;
export type LateralEvent = z.infer<typeof eventSchema>;
/**
 * What the lateral-entry decision was based on, saved when the decision is
 * made (answers, prior-study read, transcript read) and on every assessment:
 * duration + source, first period, answers with their times, whether the
 * contradiction check fired and why, both subject lists and the route.
 */
export type LateralAuditRecord = z.infer<typeof auditSchema>;

export type LateralEntryState = {
  answer: LateralAnswer | null;
  confirm: LateralAnswer | null;
  priorDocumentIds: string[];
  priorSubjects: PriorSubjects | null;
  events: LateralEvent[];
  /** Last saved decision snapshot (null until a decision was recorded). */
  audit?: LateralAuditRecord | null;
};

export const EMPTY_LATERAL_STATE: LateralEntryState = {
  answer: null,
  confirm: null,
  priorDocumentIds: [],
  priorSubjects: null,
  events: [],
  audit: null,
};

type FieldSourceLike = {
  field: string;
  degreeLevel: string | null;
  extractedValue: string | null;
  finalValue: string | null;
  alternatives?: unknown;
};

function parseJson(raw: string | null | undefined): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Lateral-entry state from the case's FieldSource rows (empty when none). */
export function lateralStateOf(fieldSources: readonly FieldSourceLike[]): LateralEntryState {
  const row = fieldSources.find(
    (f) => f.field === LATERAL_FIELD && f.degreeLevel === LATERAL_DEGREE_LEVEL,
  );
  if (!row) return { ...EMPTY_LATERAL_STATE };
  const answers = answersSchema.safeParse(parseJson(row.finalValue) ?? {});
  const prior = priorSubjectsSchema.safeParse(parseJson(row.extractedValue));
  const events = z.array(eventSchema).safeParse(row.alternatives ?? []);
  return {
    answer: answers.success ? answers.data.answer : null,
    confirm: answers.success ? answers.data.confirm : null,
    priorDocumentIds: answers.success ? answers.data.priorDocumentIds : [],
    priorSubjects: prior.success ? prior.data : null,
    events: events.success ? events.data : [],
    audit: answers.success ? answers.data.audit : null,
  };
}

/** Column values for the FieldSource row holding `state`. */
export function lateralStateColumns(state: LateralEntryState): {
  finalValue: string;
  extractedValue: string | null;
  alternatives: LateralEvent[];
} {
  return {
    finalValue: JSON.stringify({
      answer: state.answer,
      confirm: state.confirm,
      priorDocumentIds: state.priorDocumentIds,
      ...(state.audit ? { audit: state.audit } : {}),
    }),
    extractedValue: state.priorSubjects ? JSON.stringify(state.priorSubjects) : null,
    alternatives: state.events,
  };
}

/** Prior-study transcript ids: kept out of the bachelor's own reads and subjects. */
export function priorStudyDocumentIds(fieldSources: readonly FieldSourceLike[]): Set<string> {
  return new Set(lateralStateOf(fieldSources).priorDocumentIds);
}

/** True when the applicant answered Yes (first answer or re-confirmation). */
export function answeredLateralYes(state: Pick<LateralEntryState, "answer" | "confirm">): boolean {
  return state.answer?.value === "yes" || state.confirm?.value === "yes";
}

type PriorDocLike = { id: string; status: string; text?: string | null };

export type PriorStudyReadPlan = {
  /** Uploaded documents whose subjects are already saved (kept as they are). */
  keptIds: string[];
  keptRows: ExtractedSubjectRow[];
  /** Processed documents that still need their subjects read. */
  toRead: string[];
  /** A document without saved subjects is still being processed. */
  pending: boolean;
  /** Every uploaded document has saved subjects. */
  complete: boolean;
};

/**
 * Which prior-study transcripts still need their subjects read. Documents
 * already read keep their rows (never read twice); rows without a document id
 * (older saves) are kept only while every document they came from remains.
 */
export function priorStudyReadPlan(
  state: Pick<LateralEntryState, "priorDocumentIds" | "priorSubjects">,
  docs: readonly PriorDocLike[],
): PriorStudyReadPlan {
  const current = state.priorDocumentIds;
  const prev = state.priorSubjects;
  const keptIds = prev ? prev.documentIds.filter((id) => current.includes(id)) : [];
  const keptRows = !prev
    ? []
    : keptIds.length === prev.documentIds.length
      ? prev.rows
      : prev.rows.filter((r) => r.documentId != null && keptIds.includes(r.documentId));
  const open = docs.filter((d) => current.includes(d.id) && !keptIds.includes(d.id));
  return {
    keptIds,
    keptRows,
    toRead: open.filter((d) => d.status === "DONE" && Boolean(d.text?.trim())).map((d) => d.id),
    pending: open.some((d) => d.status === "QUEUED" || d.status === "EXTRACTING"),
    complete: current.length > 0 && current.every((id) => keptIds.includes(id)),
  };
}

/** State after removing one prior-study transcript (the other documents' subjects stay). */
export function withoutPriorDocument(state: LateralEntryState, documentId: string): LateralEntryState {
  const priorDocumentIds = state.priorDocumentIds.filter((id) => id !== documentId);
  const plan = priorStudyReadPlan({ priorDocumentIds, priorSubjects: state.priorSubjects }, []);
  return {
    ...state,
    priorDocumentIds,
    priorSubjects:
      plan.keptIds.length && plan.keptRows.length && state.priorSubjects
        ? { ...state.priorSubjects, documentIds: plan.keptIds, rows: plan.keptRows }
        : null,
  };
}

/** True when the case has saved lateral-entry answers or uploads (cache key input). */
export function hasLateralState(state: LateralEntryState): boolean {
  return Boolean(state.answer || state.confirm || state.priorDocumentIds.length || state.priorSubjects);
}

/** Apply one answer. A new first answer clears the confirmation (it no longer applies). */
export function withAnswer(
  state: LateralEntryState,
  question: "answer" | "confirm",
  value: LateralAnswerValue,
  at: string = new Date().toISOString(),
): LateralEntryState {
  const label = question === "answer" ? "Lateral entry question" : "Lateral entry re-confirmation";
  const next: LateralEntryState = {
    ...state,
    [question]: { value, at },
    events: [...state.events, { at, event: `${label}: ${value === "yes" ? "Yes" : "No"}` }],
  };
  if (question === "answer" && state.answer?.value !== value) next.confirm = null;
  return next;
}

// ---------------------------------------------------------------------------
// Transcript signals
// ---------------------------------------------------------------------------

/** First period on the transcript (semester / trimester / quarter / year). Null for calendar-only rows. */
export function startPeriodOf(
  rows: readonly ExtractedSubjectRow[],
): { index: number; label: string } | null {
  let best: { index: number; label: string } | null = null;
  for (const r of rows) {
    if (r.isRepeat) continue;
    const t = parseTerm(r.yearOrSemester);
    if (!t || t.unit === "calendar" || t.termIndex == null || t.termIndex < 1) continue;
    if (!best || t.termIndex < best.index) best = { index: t.termIndex, label: t.label };
  }
  return best;
}

/** Credit / exemption entries: graded or named rows, plus credit notes in the transcript text. */
export function creditEntriesOf(
  rows: readonly ExtractedSubjectRow[],
  texts: readonly string[] = [],
  title: string | null = null,
): { rows: number; noted: boolean } {
  const count = rows.filter(
    (r) => !r.isRepeat && (CREDIT_GRADE_RE.test((r.grade ?? "").trim()) || CREDIT_NAME_RE.test(r.name ?? "")),
  ).length;
  const t = title ?? "";
  const noted =
    CREDIT_TITLE_RE.test(t) ||
    BRIDGING_TITLE_RE.test(t) ||
    texts.some((x) => CREDIT_TEXT_RE.test(x) || BRIDGING_TEXT_RE.test(x));
  return { rows: count, noted };
}

/** Admission values that mean the student joined after the first year. */
const LATERAL_ADMISSION_VALUE_RE =
  /^(?:D2D|C2D|DSY|LEET|LE|LAT|lateral(?:\s*entry)?|diploma\s*(?:to|2|-)\s*degree|direct\s*(?:second|2nd|third|3rd)\s*year(?:\s*(?:entry|admission))?)(?![A-Za-z0-9])/i;
/** "ADMISSION TYPE : D2D" (the field's value only, never a legend line explaining codes). */
const ADMISSION_FIELD_RE = /\badmission\s*(?:type|mode|category|basis|route|through|via)?\s*[:\-–]\s*([^\n|]{1,80})/gi;
const ADMITTED_PHRASE_RE =
  /\badmitted\s+(?:through|via|under|by|in|on|to)\s+(?:the\s+|a\s+)?(lateral\s*entry|diploma[\s-]*to[\s-]*degree|direct\s*(?:second|2nd|third|3rd)\s*year)/i;

/**
 * Admission note on the transcript showing entry after the first year
 * ("ADMISSION TYPE : D2D", "admitted through lateral entry"). Evidence for a
 * re-confirmation only: it never asks the lateral-entry question by itself.
 */
export function admissionNoteOf(texts: readonly string[] = []): string | null {
  for (const text of texts) {
    if (!text) continue;
    for (const m of text.matchAll(ADMISSION_FIELD_RE)) {
      // Two-column layouts: the value ends at a wide gap.
      const value = m[1]!.split(/\s{3,}|\t/)[0]!.trim();
      const hit = value.match(LATERAL_ADMISSION_VALUE_RE);
      if (hit) return hit[0].replace(/\s+/g, " ");
    }
    const p = text.match(ADMITTED_PHRASE_RE);
    if (p) return p[1]!.replace(/\s+/g, " ").toLowerCase();
  }
  return null;
}

export function contradictionOf(input: {
  startPeriod: { index: number; label: string } | null;
  credit: { rows: number; noted: boolean };
  /** From admissionNoteOf. */
  admission?: string | null;
}): { fired: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (input.startPeriod && input.startPeriod.index > 1) {
    reasons.push(`the transcript starts at ${input.startPeriod.label}`);
  }
  if (input.admission) {
    reasons.push(`the transcript shows admission type ${input.admission}`);
  }
  if (input.credit.rows > 0) {
    reasons.push(
      input.credit.rows === 1 ? "1 credited or exempt subject" : `${input.credit.rows} credited or exempt subjects`,
    );
  } else if (input.credit.noted && !input.admission) {
    reasons.push("the transcript mentions credit or lateral entry");
  }
  return { fired: reasons.length > 0, reasons };
}

// ---------------------------------------------------------------------------
// Decision
// ---------------------------------------------------------------------------

export type LateralRoute = 1 | 2 | 3 | 4;
export type LateralStep = "ask" | "reconfirm" | "upload" | "done";

export type LateralDecision = {
  route: LateralRoute | null;
  step: LateralStep;
  /** One short line for the assessor. */
  reason: string;
  /** Route 2 kept after the transcript contradicted the "No". */
  flagged: boolean;
  contradiction: { fired: boolean; reasons: string[] };
};

export function decideLateralEntry(input: {
  durationYears: number | null;
  startPeriod: { index: number; label: string } | null;
  credit: { rows: number; noted: boolean };
  admission?: string | null;
  state: Pick<LateralEntryState, "answer" | "confirm">;
  /** Prior-study subjects have been read (Route 3 needs them). */
  priorSubjectsRead: boolean;
}): LateralDecision {
  const contradiction = contradictionOf(input);
  const d = input.durationYears;
  if (d == null || !Number.isFinite(d) || d <= 0) {
    return {
      route: 4,
      step: "done",
      reason:
        "The programme duration could not be counted from the transcript. Enter it in Transcript data, otherwise this case goes to manual review.",
      flagged: false,
      contradiction,
    };
  }
  if (d >= FOUR_YEARS) {
    return {
      route: 1,
      step: "done",
      reason: "Programme is four years or longer, so no lateral-entry question is needed.",
      flagged: false,
      contradiction,
    };
  }
  const yes = (): LateralDecision =>
    input.priorSubjectsRead
      ? {
          route: 3,
          step: "done",
          reason: "Lateral entry: subjects from the earlier study count towards Foundational subjects.",
          flagged: false,
          contradiction,
        }
      : { route: null, step: "upload", reason: PRIOR_STUDY_PROMPT, flagged: false, contradiction };

  const first = input.state.answer?.value;
  if (!first) return { route: null, step: "ask", reason: LATERAL_QUESTION, flagged: false, contradiction };
  if (first === "yes") return yes();
  if (!contradiction.fired) {
    return {
      route: 2,
      step: "done",
      reason: `Standard entry: assessed on the ${formatYears(d)}-year programme.`,
      flagged: false,
      contradiction,
    };
  }
  const again = input.state.confirm?.value;
  if (!again) {
    return { route: null, step: "reconfirm", reason: LATERAL_RECONFIRM, flagged: false, contradiction };
  }
  if (again === "yes") return yes();
  return {
    route: 2,
    step: "done",
    reason: `Standard entry confirmed, but flagged: ${contradiction.reasons.join(" and ")}.`,
    flagged: true,
    contradiction,
  };
}

function formatYears(y: number): string {
  return Number.isInteger(y) ? String(y) : y.toFixed(1).replace(/\.0$/, "");
}

// ---------------------------------------------------------------------------
// Case view (UI + audit)
// ---------------------------------------------------------------------------

export type PriorStudyDocument = {
  id: string;
  name: string;
  format: string;
  status: string;
  error: string | null;
};

export type LateralEntryView = LateralDecision & {
  degreeLevel: typeof LATERAL_DEGREE_LEVEL;
  durationYears: number | null;
  durationSource: string;
  startPeriod: string | null;
  answer: LateralAnswer | null;
  confirm: LateralAnswer | null;
  priorDocuments: PriorStudyDocument[];
  /** Earlier-study subjects that were read (names only). */
  priorSubjects: string[] | null;
  events: LateralEvent[];
  /** Inputs of this decision (saved as the audit record; not shown as such). */
  basis?: LateralDecisionBasis;
  /** Set on an assessment result: when its decision record was saved. */
  audit?: { at: string; trigger: "decision" | "assessment" };
};

/** Decision inputs that are not already on the view. */
export type LateralDecisionBasis = {
  admissionNote: string | null;
  creditEntries: { rows: number; noted: boolean };
  primarySubjects: string[];
  priorStudySubjects: string[];
};

type SummaryLike = {
  degreeLevel: string;
  award: Gate1AwardLevel;
  effective: { countedYears: number | null };
  basis: "counted" | "manual" | "none" | "default";
  basisLabel: string;
};

type DocumentLike = {
  id: string;
  originalName: string;
  format: string;
  status: string;
  error?: string | null;
};

/**
 * Lateral-entry view for the bachelor being assessed; null when the case has
 * no bachelor (or the assessor set its award to something else).
 */
export function lateralEntryView(input: {
  summaries: readonly SummaryLike[];
  /** The bachelor's own subject rows. */
  rows: readonly ExtractedSubjectRow[];
  texts?: readonly string[];
  title?: string | null;
  state: LateralEntryState;
  documents?: readonly DocumentLike[];
}): LateralEntryView | null {
  const q = input.summaries.find((s) => s.degreeLevel === LATERAL_DEGREE_LEVEL);
  if (!q || (q.award !== "bachelor" && q.award !== "honours")) return null;
  const durationYears = q.effective.countedYears ?? null;
  const startPeriod = startPeriodOf(input.rows);
  const credit = creditEntriesOf(input.rows, input.texts ?? [], input.title ?? null);
  const admission = admissionNoteOf(input.texts ?? []);
  const priorSubjectsRead = Boolean(
    input.state.priorSubjects &&
      input.state.priorDocumentIds.length &&
      input.state.priorDocumentIds.every((id) => input.state.priorSubjects!.documentIds.includes(id)),
  );
  const decision = decideLateralEntry({
    durationYears,
    startPeriod,
    credit,
    admission,
    state: input.state,
    priorSubjectsRead,
  });
  const ids = new Set(input.state.priorDocumentIds);
  return {
    ...decision,
    degreeLevel: LATERAL_DEGREE_LEVEL,
    durationYears,
    durationSource: q.basisLabel,
    startPeriod: startPeriod?.label ?? null,
    answer: input.state.answer,
    confirm: input.state.confirm,
    priorDocuments: (input.documents ?? [])
      .filter((d) => ids.has(d.id))
      .map((d) => ({
        id: d.id,
        name: d.originalName,
        format: d.format,
        status: d.status,
        error: d.error ?? null,
      })),
    priorSubjects:
      decision.route === 3 && input.state.priorSubjects
        ? input.state.priorSubjects.rows.filter((r) => !r.isRepeat).map((r) => r.name)
        : null,
    events: input.state.events,
    basis: {
      admissionNote: admission,
      creditEntries: credit,
      primarySubjects: input.rows.filter((r) => !r.isRepeat).map((r) => r.name),
      priorStudySubjects: (input.state.priorSubjects?.rows ?? []).filter((r) => !r.isRepeat).map((r) => r.name),
    },
  };
}

/** Audit record for a lateral-entry view (null when the case has no bachelor view). */
export function lateralAuditOf(
  view: LateralEntryView | null,
  trigger: LateralAuditRecord["trigger"],
  at: string = new Date().toISOString(),
): LateralAuditRecord | null {
  if (!view) return null;
  return {
    at,
    trigger,
    durationYears: view.durationYears,
    durationSource: view.durationSource,
    startPeriod: view.startPeriod,
    answer: view.answer,
    confirm: view.confirm,
    contradiction: view.contradiction,
    admissionNote: view.basis?.admissionNote ?? null,
    creditEntries: view.basis?.creditEntries ?? { rows: 0, noted: false },
    primarySubjects: view.basis?.primarySubjects ?? [],
    priorStudySubjects: view.basis?.priorStudySubjects ?? [],
    route: view.route,
    step: view.step,
    reason: view.reason,
    flagged: view.flagged,
  };
}

/** True when two records describe the same decision (time and trigger ignored). */
export function sameLateralDecision(
  a: LateralAuditRecord | null | undefined,
  b: LateralAuditRecord | null | undefined,
): boolean {
  if (!a || !b) return false;
  const strip = ({ at: _at, trigger: _t, ...rest }: LateralAuditRecord) => rest;
  return JSON.stringify(strip(a)) === JSON.stringify(strip(b));
}

/**
 * State with `record` saved: a new decision also adds an audit event; the
 * same decision only refreshes the record on an assessment (its time).
 * Null when nothing needs saving.
 */
export function withLateralAudit(
  state: LateralEntryState,
  record: LateralAuditRecord,
): LateralEntryState | null {
  const same = sameLateralDecision(state.audit, record);
  if (same && record.trigger !== "assessment") return null;
  const events = same
    ? state.events
    : [
        ...state.events,
        {
          at: record.at,
          event:
            record.route != null
              ? `Lateral entry decision: Route ${record.route}${record.flagged ? " (flagged)" : ""}${
                  record.contradiction.fired ? `; contradiction: ${record.contradiction.reasons.join(" and ")}` : ""
                }`
              : `Lateral entry pending: ${record.step}`,
        },
      ];
  return { ...state, audit: record, events };
}

/** The decision lets Gate 1 skip its bridging / credit-transfer review flags (routes 2 and 3). */
export function lateralEntryDecided(view: LateralEntryView | null): boolean {
  return view?.route === 2 || view?.route === 3;
}

/** Lateral entry confirmed (Route 3): Gate 1 treats a 3-year bachelor as the 4-year gate, and opens a 2 to under 3-year bachelor on the Technologist track. */
export function lateralEntryConfirmed(view: LateralEntryView | null): boolean {
  return view?.route === 3;
}

/** Earlier-study rows to add to the pool (Route 3 only). */
export function priorStudyRowsFor(
  view: LateralEntryView | null,
  state: LateralEntryState,
): ExtractedSubjectRow[] {
  if (view?.route !== 3 || !state.priorSubjects) return [];
  return state.priorSubjects.rows.filter((r) => !r.isRepeat);
}

// ---------------------------------------------------------------------------
// Route 3 matching
// ---------------------------------------------------------------------------

export const PRIOR_STUDY_REASON = "Prior study (lateral entry)";

/**
 * Earlier-study matches to add to a pool's matches: Foundational (Tier 1)
 * rubric subjects only, and only those the primary transcript did not
 * already match (never displaces a primary match).
 */
export function priorStudyMatches(
  primary: readonly SubjectMatch[],
  priorRows: readonly ExtractedSubjectRow[],
  rubricSubjects: readonly RubricSubject[],
  opts?: MatchOptions,
): SubjectMatch[] {
  if (!priorRows.length) return [];
  const tier1 = rubricSubjects.filter((s) => s.tier === "tier1");
  if (!tier1.length) return [];
  const taken = new Set(
    primary.filter((m) => m.rubricSubject && m.tier).map((m) => `${m.tier}|${m.rubricSubject}`),
  );
  const { matches } = matchSubjectsSync([...priorRows], tier1, { ...opts, gateSubject: undefined });
  const out: SubjectMatch[] = [];
  for (const m of matches) {
    if (!m.rubricSubject || m.tier !== "tier1") continue;
    const key = `${m.tier}|${m.rubricSubject}`;
    if (taken.has(key)) continue;
    taken.add(key);
    out.push({ ...m, priorStudy: true, reason: PRIOR_STUDY_REASON });
  }
  return out;
}
