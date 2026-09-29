/**
 * Institution string equivalence helpers for merge conflicts.
 */

const FILLER = new Set(["of", "the", "and", "at", "for", "in", "a", "an"]);

/** Lowercase, strip parentheticals, drop filler words, collapse whitespace. */
export function normalizeInstitutionCore(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\([^)]*\)/g, " ")
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter((w) => w && !FILLER.has(w))
    .join(" ");
}

/** Acronym from significant words, e.g. Government College University Faisalabad → GCUF. */
export function institutionAcronym(value: string): string {
  const core = normalizeInstitutionCore(value);
  if (!core) return "";
  return core
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0]!)
    .join("")
    .toUpperCase();
}

/**
 * True when one string is (or contains) an acronym of the other after
 * stripping campus parentheticals / filler words.
 */
export function isLikelyAcronymMatch(a: string, b: string): boolean {
  if (!a?.trim() || !b?.trim()) return false;

  const coreA = normalizeInstitutionCore(a);
  const coreB = normalizeInstitutionCore(b);
  if (!coreA || !coreB) return false;
  if (coreA === coreB) return true;

  const compactA = coreA.replace(/\s+/g, "");
  const compactB = coreB.replace(/\s+/g, "");
  if (compactA === compactB) return true;

  const acronymA = institutionAcronym(a);
  const acronymB = institutionAcronym(b);
  if (!acronymA || !acronymB) return false;

  // Short form equals acronym of the other (GCUF vs Government College University Faisalabad)
  if (compactA === acronymB.toLowerCase() || compactB === acronymA.toLowerCase()) {
    return true;
  }

  // Contained forms: "gcuf" inside acronym or vice versa when lengths differ enough
  const short = compactA.length <= compactB.length ? compactA : compactB;
  const longAcronym =
    compactA.length <= compactB.length ? acronymB.toLowerCase() : acronymA.toLowerCase();
  if (short.length >= 3 && (longAcronym === short || longAcronym.includes(short))) {
    // Avoid over-match: short must look like an acronym (mostly letters, no spaces already)
    if (/^[a-z]{3,8}$/.test(short)) return true;
  }

  return false;
}
