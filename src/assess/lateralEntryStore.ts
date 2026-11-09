/**
 * Lateral-entry answers and the prior-study transcript (DB side). Everything
 * lives in one FieldSource row (`transcript.lateralEntry`, level "bachelor"):
 * finalValue = answers + prior-study document ids, extractedValue = the
 * earlier study's subjects, alternatives = timestamped audit events. No new
 * tables or columns; ExtractedSubject (the bachelor's own subjects) is untouched.
 */
import { prisma } from "../lib/prisma.js";
import { assessConfig } from "./config.js";
import { extractSubjectsDetailed } from "./extractSubjects.js";
import {
  answeredLateralYes,
  lateralAuditOf,
  LATERAL_DEGREE_LEVEL,
  LATERAL_FIELD,
  lateralStateColumns,
  lateralStateOf,
  priorStudyReadPlan,
  withAnswer,
  withLateralAudit,
  withoutPriorDocument,
  type LateralAnswerValue,
  type LateralAuditRecord,
  type LateralEntryState,
  type LateralEntryView,
} from "./lateralEntry.js";

export async function loadLateralState(caseId: string): Promise<LateralEntryState> {
  const rows = await prisma.fieldSource.findMany({
    where: { caseId, field: LATERAL_FIELD },
  });
  return lateralStateOf(rows);
}

async function saveLateralState(
  caseId: string,
  state: LateralEntryState,
): Promise<void> {
  const cols = lateralStateColumns(state);
  const sourceDocumentId = state.priorDocumentIds.at(-1) ?? null;
  await prisma.fieldSource.upsert({
    where: {
      caseId_field_degreeLevel: {
        caseId,
        field: LATERAL_FIELD,
        degreeLevel: LATERAL_DEGREE_LEVEL as never,
      },
    },
    create: {
      caseId,
      field: LATERAL_FIELD,
      degreeLevel: LATERAL_DEGREE_LEVEL as never,
      sourceDocumentId,
      extractedValue: cols.extractedValue,
      finalValue: cols.finalValue,
      alternatives: cols.alternatives,
    },
    update: {
      sourceDocumentId,
      extractedValue: cols.extractedValue,
      finalValue: cols.finalValue,
      alternatives: cols.alternatives,
    },
  });
}

/** Save one answer (first question or the re-confirmation). */
export async function answerLateralEntry(
  caseId: string,
  question: "answer" | "confirm",
  value: LateralAnswerValue,
): Promise<void> {
  const state = await loadLateralState(caseId);
  await saveLateralState(caseId, withAnswer(state, question, value));
}

/**
 * Save the decision record (duration + source, first period, answers with
 * times, contradiction and why, both subject lists, route + reason) on the
 * lateral-entry row. Called when a decision is made and on every assessment;
 * never throws (an audit write must not fail the request).
 */
export async function recordLateralDecision(
  caseId: string,
  view: LateralEntryView | null,
  trigger: LateralAuditRecord["trigger"],
): Promise<LateralAuditRecord | null> {
  const record = lateralAuditOf(view, trigger);
  if (!record) return null;
  try {
    await withCaseLock(caseId, async () => {
      const state = await loadLateralState(caseId);
      const next = withLateralAudit(state, record);
      if (next) await saveLateralState(caseId, next);
    });
  } catch (err) {
    console.error("[lateral] audit save failed:", err instanceof Error ? err.message : err);
  }
  return record;
}

/** True when the document is a prior-study transcript of this case. */
export async function isPriorStudyDocument(caseId: string, documentId: string): Promise<boolean> {
  const state = await loadLateralState(caseId);
  return state.priorDocumentIds.includes(documentId);
}

export async function addPriorStudyDocument(caseId: string, documentId: string): Promise<void> {
  const state = await loadLateralState(caseId);
  if (state.priorDocumentIds.includes(documentId)) return;
  const at = new Date().toISOString();
  await saveLateralState(caseId, {
    ...state,
    priorDocumentIds: [...state.priorDocumentIds, documentId],
    events: [...state.events, { at, event: "Earlier-study transcript uploaded" }],
  });
}

/** Drop a removed prior-study transcript and its subjects (the other files' subjects stay). */
export async function removePriorStudyDocument(caseId: string, documentId: string): Promise<void> {
  await withCaseLock(caseId, async () => {
    const state = await loadLateralState(caseId);
    if (!state.priorDocumentIds.includes(documentId)) return;
    const at = new Date().toISOString();
    const next = withoutPriorDocument(state, documentId);
    await saveLateralState(caseId, {
      ...next,
      events: [...state.events, { at, event: "Earlier-study transcript removed" }],
    });
  });
}

// One prior-study read per case at a time (upload watcher, Verify details and
// the Assessment step can ask together); a queued call then finds nothing to read.
const caseLocks = new Map<string, Promise<unknown>>();

function withCaseLock<T>(caseId: string, fn: () => Promise<T>): Promise<T> {
  const prev = caseLocks.get(caseId) ?? Promise.resolve();
  const run = prev.catch(() => undefined).then(fn);
  const tail = run.catch(() => undefined);
  caseLocks.set(caseId, tail);
  void tail.then(() => {
    if (caseLocks.get(caseId) === tail) caseLocks.delete(caseId);
  });
  return run;
}

export class PriorStudyNotReadyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PriorStudyNotReadyError";
  }
}

/**
 * Read the subjects of the earlier study's transcript(s) that have none saved
 * yet (same AI extraction as the bachelor's transcripts) and save them on the
 * lateral-entry row. Files already read are never read again, and the
 * bachelor's own subjects are not touched. Throws PriorStudyNotReadyError
 * while a file is still being processed or nothing could be read.
 */
export function readPriorStudySubjects(caseId: string): Promise<number> {
  return withCaseLock(caseId, () => readMissingPriorSubjects(caseId));
}

async function readMissingPriorSubjects(caseId: string): Promise<number> {
  const state = await loadLateralState(caseId);
  if (!state.priorDocumentIds.length) {
    throw new PriorStudyNotReadyError("Upload the earlier study's transcript first.");
  }
  const docs = await prisma.document.findMany({
    where: { caseId, id: { in: state.priorDocumentIds } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  const plan = priorStudyReadPlan(state, docs);
  if (!plan.toRead.length) {
    if (plan.complete) return plan.keptRows.length;
    if (plan.pending) throw new PriorStudyNotReadyError("The transcript is still being processed.");
    throw new PriorStudyNotReadyError("The transcript could not be read. Remove it and upload a clearer copy.");
  }
  const read = docs.filter((d) => plan.toRead.includes(d.id));
  const result = await extractSubjectsDetailed(
    read.map((d) => ({ documentId: d.id, text: d.text ?? "", degreeLevelHint: "diploma" as const })),
    { deadlineMs: Date.now() + assessConfig.timeoutMs },
  );
  // A partial read is not saved: the earlier-study subjects would be incomplete.
  if (result.partial) {
    throw new PriorStudyNotReadyError("Some pages couldn't be read. Try again.");
  }
  const rows = result.rows;
  if (!rows.length) {
    throw new PriorStudyNotReadyError("No subjects were found in the transcript. Try again or upload a clearer copy.");
  }
  // Re-load: answers may have changed during the read; only the subjects are written here.
  const fresh = await loadLateralState(caseId);
  const keep = (id: string) => fresh.priorDocumentIds.includes(id);
  const documentIds = [...plan.keptIds, ...plan.toRead].filter(keep);
  const at = new Date().toISOString();
  await saveLateralState(caseId, {
    ...fresh,
    // Ids whose document no longer exists are dropped (files uploaded during the read stay).
    priorDocumentIds: fresh.priorDocumentIds.filter(
      (id) => docs.some((d) => d.id === id) || !state.priorDocumentIds.includes(id),
    ),
    priorSubjects: {
      documentIds,
      rows: [...plan.keptRows, ...rows].filter((r) => r.documentId == null || keep(r.documentId)),
      at,
    },
    events: [
      ...fresh.events,
      { at, event: `Earlier-study subjects read: ${rows.filter((r) => !r.isRepeat).length}` },
    ],
  });
  return rows.length;
}

/**
 * Read any prior-study transcript that has no subjects yet; never throws.
 * Used after an upload finishes and when the Assessment step runs. Does
 * nothing without a lateral-entry Yes or when every file is already read.
 */
export async function ensurePriorStudySubjects(caseId: string): Promise<void> {
  try {
    const state = await loadLateralState(caseId);
    if (!state.priorDocumentIds.length || !answeredLateralYes(state)) return;
    if (priorStudyReadPlan(state, []).complete) return;
    await readPriorStudySubjects(caseId);
  } catch (err) {
    if (err instanceof PriorStudyNotReadyError) return;
    console.error("[lateral] prior-study subject read failed:", err instanceof Error ? err.message : err);
  }
}

const WATCH_EVERY_MS = 2_000;
const WATCH_FOR_MS = 5 * 60_000;

/**
 * After a prior-study upload: wait (in the background) until the extract
 * worker has processed the file, then read its subjects.
 */
export function watchPriorStudyDocument(caseId: string, documentId: string): void {
  const until = Date.now() + WATCH_FOR_MS;
  const tick = async (): Promise<void> => {
    const doc = await prisma.document.findUnique({
      where: { id: documentId },
      select: { status: true },
    });
    if (!doc || doc.status === "FAILED") return;
    if (doc.status === "DONE") return ensurePriorStudySubjects(caseId);
    if (Date.now() >= until) return;
    await new Promise((r) => setTimeout(r, WATCH_EVERY_MS));
    return tick();
  };
  void tick().catch((err) =>
    console.error("[lateral] prior-study watch failed:", err instanceof Error ? err.message : err),
  );
}
