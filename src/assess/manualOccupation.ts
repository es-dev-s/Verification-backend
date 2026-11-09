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
import { EM_ANZSCO, EM_OCCUPATION_ID } from "./engineeringManager.js";
import { trackOccupations } from "./gate1.js";
import { listAcademicOccupations, listVocationalOccupations } from "./loadRubric.js";
import { TELECOM_ANZSCO, TELECOM_ANZSCO_CODES } from "./telecomGroup.js";

export const MANUAL_ANZSCO_FIELD = "manualAnzsco";

export type ManualOccupationOption = {
  /** Rubric occupation id (null when there is no rubric for the code). */
  occupationId: string | null;
  anzscoCode: string;
  title: string;
  flow: "academic" | "vocational_units" | "telecom_group" | "engineering_manager" | null;
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

function isTelecomGroupCode(code: string): boolean {
  return (TELECOM_ANZSCO_CODES as readonly string[]).includes(code);
}

/** Picker id for a telecom group code (313213 keeps its rubric id). */
function telecomOccupationId(code: string): string {
  return code === TELECOM_ANZSCO.planner ? "telecommunications-network-planner" : code;
}

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
  const vocational = listVocationalOccupations();
  for (const o of vocational) {
    // Telecom group codes are listed once below (telecom group matching).
    if (isTelecomGroupCode(o.anzsco)) continue;
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
  // Telecommunications group (313212 / 313213 / 313214): matched with the
  // telecom group units (telecomGroup.ts), not a rubric. Needs ICT60220.
  const eaTitles = new Map(
    trackOccupations("engineering_associate").map((o) => [o.anzscoCode, o.occupation] as const),
  );
  for (const code of TELECOM_ANZSCO_CODES) {
    out.push({
      occupationId: telecomOccupationId(code),
      anzscoCode: code,
      title: eaTitles.get(code) ?? vocational.find((o) => o.anzsco === code)?.title ?? code,
      flow: "telecom_group",
      available: true,
      unavailableReason: null,
    });
  }
  // Engineering Manager (133211): never suggested; picked here for its own
  // eligibility check (Check an ANZSCO only, never saved as the manual choice).
  out.push({
    occupationId: EM_OCCUPATION_ID,
    anzscoCode: EM_ANZSCO,
    title:
      trackOccupations("professional_engineer").find((o) => o.anzscoCode === EM_ANZSCO)?.occupation ??
      "Engineering Manager",
    flow: "engineering_manager",
    available: true,
    unavailableReason: null,
  });
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

/** True for the Engineering Manager pick (its own check, not subject matching). */
export function isEngineeringManager(occupationId: string): boolean {
  return occupationId === EM_OCCUPATION_ID;
}

/** Shown when Engineering Manager is sent to subject matching. */
export const EM_CHECK_ONLY = "Engineering Manager has its own eligibility check. Open it from Check an ANZSCO.";

type FieldSourceLike = { field: string; degreeLevel?: unknown; finalValue?: string | null };

/** The saved assessor choice (null when none, or when it no longer resolves). */
export function manualSelectionFrom(fieldSources: readonly FieldSourceLike[]): ManualSelection | null {
  const row = fieldSources.find((f) => f.field === MANUAL_ANZSCO_FIELD && (f.degreeLevel ?? null) === null);
  const value = row?.finalValue?.trim();
  if (!value) return null;
  const r = resolveManualOccupation(value);
  // Engineering Manager has its own check; it is never a manual-review choice.
  return r.ok && !isEngineeringManager(r.selection.occupationId) ? r.selection : null;
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

/** Shown when a telecom group occupation is picked on a case without ICT60220. */
export const TELECOM_NEEDS_ICT60220 =
  "Telecom group matching needs ICT60220. It was not found on this case's qualification or transcripts.";

/** Raised by a single-occupation run for a telecom group code when the case has no ICT60220. */
export class TelecomNeedsIct60220Error extends Error {
  constructor() {
    super(TELECOM_NEEDS_ICT60220);
    this.name = "TelecomNeedsIct60220Error";
  }
}
