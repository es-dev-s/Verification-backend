import type { QualificationInfo } from "./qualificationCheck.js";
import { normalizeUnitCode, UNIT_CODE_RE, type ExtractedSubjectRow } from "./schemas.js";

/**
 * Qualification origin for the draftsperson occupations (312211 / 312311):
 * an Australian VET qualification is scored on unit codes, an overseas one on
 * subject headings, and an unknown one on both (best kept, flagged).
 *
 * - australian: a qualification country is Australia, OR an Australian
 *   qualification code (e.g. UEE62122, MEM50212) is in a title or text, OR
 *   Australian unit codes (e.g. UEECD0019) are on the transcript.
 * - overseas: a non-Australian country is on file and there is no Australian signal.
 * - unknown: everything else (no country, no codes).
 */
export type QualificationOrigin = "australian" | "overseas" | "unknown";

export type OriginDecision = { origin: QualificationOrigin; reason: string };

/**
 * Training-package prefixes of Australian qualification / unit codes. A code
 * only counts as Australian with one of these prefixes, so overseas course
 * codes that happen to fit the unit-code shape (e.g. "CIVENG3101") do not.
 */
const AU_PACKAGE_PREFIXES = new Set([
  "AUR", "AVI", "BSB", "CPC", "CPP", "CUA", "FNS", "HLT", "ICT", "MAR", "MEA", "MEM",
  "MSA", "MSF", "MSL", "MSM", "MSS", "MST", "NWP", "PMA", "PMB", "PMC", "PSP", "RII",
  "SIT", "TAE", "TLI", "UEE", "UEG", "UEP", "UET", "UTP",
]);

/** Australian qualification code: training package + 5 digits (UEE62122, RII60520). */
const AU_QUAL_CODE_RE = /\b([A-Z]{3})(\d{5})\b/g;

const AUSTRALIA_RE = /^(australia|commonwealth of australia|au|aus)$/i;

function isAustralia(country: string): boolean {
  const c = country.trim().replace(/\.$/, "");
  return AUSTRALIA_RE.test(c) || /\baustralia\b/i.test(c);
}

function auQualificationCode(text: string | null | undefined): string | null {
  if (!text) return null;
  for (const m of text.matchAll(AU_QUAL_CODE_RE)) {
    if (AU_PACKAGE_PREFIXES.has(m[1]!)) return m[0];
  }
  return null;
}

const UNIT_CODE_GLOBAL = new RegExp(UNIT_CODE_RE.source, "g");

function auUnitCodeIn(text: string | null | undefined): string | null {
  if (!text) return null;
  for (const m of text.toUpperCase().matchAll(UNIT_CODE_GLOBAL)) {
    if (AU_PACKAGE_PREFIXES.has(m[0].slice(0, 3))) return m[0];
  }
  return null;
}

/** First Australian unit code on the transcript rows or texts, or null. */
export function firstAuUnitCode(
  rows: readonly ExtractedSubjectRow[] = [],
  texts: readonly string[] = [],
): string | null {
  for (const r of rows) {
    const c = normalizeUnitCode(r.code);
    const hit = (c && auUnitCodeIn(c)) || auUnitCodeIn(r.name);
    if (hit) return hit;
  }
  for (const t of texts) {
    const hit = auUnitCodeIn(t);
    if (hit) return hit;
  }
  return null;
}

/** Decide the qualification origin (see the module comment). */
export function qualificationOrigin(input: {
  qualifications?: readonly QualificationInfo[];
  rows?: readonly ExtractedSubjectRow[];
  texts?: readonly string[];
}): OriginDecision {
  const quals = input.qualifications ?? [];
  const countries = quals.map((q) => q.country?.trim() ?? "").filter((c) => c.length > 0);

  const au = countries.find(isAustralia);
  if (au) return { origin: "australian", reason: `Qualification country is ${au}.` };

  for (const q of quals) {
    const code = auQualificationCode(q.title) ?? auQualificationCode(q.fieldOfStudy);
    if (code) return { origin: "australian", reason: `Australian qualification code ${code} in the qualification title.` };
  }
  const texts = [...(input.texts ?? []), ...quals.flatMap((q) => q.texts ?? [])];
  for (const t of texts) {
    const code = auQualificationCode(t);
    if (code) return { origin: "australian", reason: `Australian qualification code ${code} on the transcript.` };
  }
  const unit = firstAuUnitCode(input.rows ?? [], texts);
  if (unit) return { origin: "australian", reason: `Australian unit code ${unit} on the transcript.` };

  const overseas = countries.find((c) => !isAustralia(c));
  if (overseas) {
    return { origin: "overseas", reason: `Qualification country is ${overseas}; no Australian qualification or unit codes found.` };
  }
  return { origin: "unknown", reason: "No qualification country on file and no Australian qualification or unit codes found." };
}
