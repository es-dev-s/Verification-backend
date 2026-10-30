/**
 * Assessor-selected occupation (Gate 1 = manual review).
 *
 * When Gate 1 asks for manual review, the assessor can pick one ANZSCO
 * occupation in the Assessment step and run the normal scoring for that
 * occupation only. The choice is stored as one FieldSource row
 * (field "manualAnzsco", no degree level): finalValue = occupation id,
 * extractedValue = ANZSCO code. No schema change.
 */
import { prisma } from "../lib/prisma.js";
import { trackOccupations } from "./gate1.js";
import { listAcademicOccupations, listVocationalOccupations } from "./loadRubric.js";

export const MANUAL_ANZSCO_FIELD = "manualAnzsco";

export type ManualOccupationOption = {
  /** Rubric occupation id (null when there is no rubric for the code). */
  occupationId: string | null;
  anzscoCode: string;
  title: string;
  flow: "academic" | "vocational_units" | null;
  /** True when this occupation can be scored. */
  available: boolean;
  /** Why it cannot be scored (null when available). */
  unavailableReason: string | null;
};

export type ManualSelection = {
  occupationId: string;
  anzscoCode: string;
  title: string;
};

const TRACKS = ["professional_engineer", "engineering_technologist", "engineering_associate"] as const;

/**
 * Occupations the assessor can pick: every academic rubric, every vocational
 * rubric (scorable only with real unit codes), plus the Engineers Australia
 * codes from anzsco_skill_levels.json that have no rubric (listed, not scorable).
 */
export function listManualOccupationOptions(): ManualOccupationOption[] {
  const out: ManualOccupationOption[] = [];
  for (const o of listAcademicOccupations()) {
    out.push({
      occupationId: o.id,
      anzscoCode: String(o.anzsco),
      title: o.title,
      flow: "academic",
      available: true,
      unavailableReason: null,
    });
  }
  for (const o of listVocationalOccupations()) {
    out.push({
      occupationId: o.id,
      anzscoCode: o.anzsco,
      title: o.title,
      flow: "vocational_units",
      available: o.scoringEnabled,
      unavailableReason: o.scoringEnabled
        ? null
        : `Matching is not available for this occupation yet (${o.disabledReason ?? "rubric incomplete"}).`,
    });
  }
  const withRubric = new Set(out.map((o) => o.anzscoCode));
  for (const track of TRACKS) {
    for (const o of trackOccupations(track)) {
      if (withRubric.has(o.anzscoCode)) continue;
      withRubric.add(o.anzscoCode);
      out.push({
        occupationId: null,
        anzscoCode: o.anzscoCode,
        title: o.occupation,
        flow: null,
        available: false,
        unavailableReason: "No rubric for this ANZSCO code. Matching is not available.",
      });
    }
  }
  return out.sort((a, b) => a.anzscoCode.localeCompare(b.anzscoCode) || a.title.localeCompare(b.title));
}

export type ManualResolve =
  | { ok: true; selection: ManualSelection }
  | { ok: false; error: string };

/** Resolve an occupation id or 6-digit ANZSCO code to a scorable occupation. */
export function resolveManualOccupation(
  input: string,
  options: ManualOccupationOption[] = listManualOccupationOptions(),
): ManualResolve {
  const key = input.trim();
  if (!key) return { ok: false, error: "Enter an ANZSCO code or pick an occupation." };
  const byId = options.find((o) => o.occupationId === key);
  const code = key.replace(/\s+/g, "");
  const hits = byId ? [byId] : options.filter((o) => o.anzscoCode === code);
  if (!hits.length) {
    return { ok: false, error: `No rubric for ANZSCO ${code}. Matching is not available for this code.` };
  }
  const usable = hits.filter((o) => o.available && o.occupationId);
  if (!usable.length) {
    const h = hits[0]!;
    return { ok: false, error: `ANZSCO ${h.anzscoCode} (${h.title}): ${h.unavailableReason ?? "no rubric."}` };
  }
  if (usable.length > 1) {
    return {
      ok: false,
      error: `ANZSCO ${code} has more than one rubric (${usable.map((o) => o.title).join(", ")}). Pick the occupation from the list.`,
    };
  }
  const o = usable[0]!;
  return { ok: true, selection: { occupationId: o.occupationId!, anzscoCode: o.anzscoCode, title: o.title } };
}

type FieldSourceLike = { field: string; degreeLevel?: unknown; finalValue?: string | null };

/** The saved assessor choice (null when none, or when it no longer resolves). */
export function manualSelectionFrom(fieldSources: readonly FieldSourceLike[]): ManualSelection | null {
  const row = fieldSources.find((f) => f.field === MANUAL_ANZSCO_FIELD && (f.degreeLevel ?? null) === null);
  const value = row?.finalValue?.trim();
  if (!value) return null;
  const r = resolveManualOccupation(value);
  return r.ok ? r.selection : null;
}

/** Save (or clear with null) the assessor choice for a case. */
export async function saveManualSelection(caseId: string, selection: ManualSelection | null): Promise<void> {
  const existing = await prisma.fieldSource.findFirst({
    where: { caseId, field: MANUAL_ANZSCO_FIELD, degreeLevel: null },
  });
  if (!selection) {
    if (existing) await prisma.fieldSource.delete({ where: { id: existing.id } });
    return;
  }
  const data = { extractedValue: selection.anzscoCode, finalValue: selection.occupationId };
  if (existing) {
    await prisma.fieldSource.update({ where: { id: existing.id }, data });
  } else {
    await prisma.fieldSource.create({
      data: { caseId, field: MANUAL_ANZSCO_FIELD, degreeLevel: null, ...data },
    });
  }
}

/** Raised by a saved-subjects-only run when the case has no saved subjects. */
export class NoSavedSubjectsError extends Error {
  constructor() {
    super("No saved subjects for this case. Open Step 2 (Transcript data) and read the transcripts first.");
    this.name = "NoSavedSubjectsError";
  }
}
