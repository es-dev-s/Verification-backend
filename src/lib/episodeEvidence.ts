/**
 * Evidence checkboxes on a career episode (Step 1). Ticked manually by the user;
 * stored only, not used by any other step yet.
 */
export const EPISODE_EVIDENCE_FIELDS = [
  "hasCalculations",
  "hasDrawingsCad",
  "hasDataTables",
  "hasSiteProductImages",
  "hasStandardsReferenced",
  "hasQuantifiableOutcomes",
] as const;

export type EpisodeEvidenceField = (typeof EPISODE_EVIDENCE_FIELDS)[number];
export type EpisodeEvidence = Record<EpisodeEvidenceField, boolean>;

const TRUE_VALUES = new Set(["true", "1", "on", "yes"]);
const FALSE_VALUES = new Set(["false", "0", "off", "no"]);

/**
 * Multipart / query string flag: "true" / "1" / "on" / "yes" → true,
 * "false" / "0" / "off" / "no" / "" → false, anything else → undefined (invalid).
 */
export function parseEvidenceFlag(raw: string): boolean | undefined {
  const value = raw.trim().toLowerCase();
  if (!value) return false;
  if (TRUE_VALUES.has(value)) return true;
  if (FALSE_VALUES.has(value)) return false;
  return undefined;
}

/** Parse all six flags; returns the first invalid field name instead when one is bad. */
export function parseEvidenceFlags(
  read: (field: EpisodeEvidenceField) => string,
): { ok: true; evidence: EpisodeEvidence } | { ok: false; field: EpisodeEvidenceField } {
  const evidence = {} as EpisodeEvidence;
  for (const field of EPISODE_EVIDENCE_FIELDS) {
    const parsed = parseEvidenceFlag(read(field));
    if (parsed === undefined) return { ok: false, field };
    evidence[field] = parsed;
  }
  return { ok: true, evidence };
}
