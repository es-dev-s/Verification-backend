import type { DegreeLevelLabel, DocumentTypeLabel } from "./schemas.js";

/** Doc shape used when deciding whether a document belongs to an education read. */
export type DegreeScopedDoc = {
  type: DocumentTypeLabel | string;
  degreeLevel: DegreeLevelLabel | string | null;
};

/**
 * CV always participates. Transcript/certificate match their stored degreeLevel.
 * Legacy academic docs with null degreeLevel count as bachelor only.
 */
export function documentMatchesDegreeLevel(
  doc: DegreeScopedDoc,
  degreeLevel: DegreeLevelLabel | string,
): boolean {
  if (doc.type === "CV") return true;
  if (doc.type !== "TRANSCRIPT" && doc.type !== "CERTIFICATE") return false;
  if (doc.degreeLevel === degreeLevel) return true;
  return degreeLevel === "bachelor" && doc.degreeLevel == null;
}
