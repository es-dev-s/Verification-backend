/**
 * Post-extract cleanup for Gemini/heuristic education (and similar) string fields.
 * Strips OCR/JSON junk without inventing missing words.
 */

/** Remove braces and collapse whitespace. */
function stripJunkChars(value: string): string {
  return value
    .replace(/[{}⟦⟧‹›«»]/g, "")
    .replace(/[\u0000-\u001f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Drop an unfinished trailing parenthetical, e.g.
 * "Bachelor of Science in Electrical (Pow" → "Bachelor of Science in Electrical"
 * Balanced parens like "(Hons.)" or "(Power)" are kept.
 */
function stripUnbalancedParens(value: string): string {
  let s = value;
  const open = (s.match(/\(/g) ?? []).length;
  const close = (s.match(/\)/g) ?? []).length;
  if (open > close) {
    const idx = s.lastIndexOf("(");
    if (idx >= 0) {
      s = s.slice(0, idx).trim();
    }
  }
  // Dangling closers with no open
  if ((s.match(/\)/g) ?? []).length > (s.match(/\(/g) ?? []).length) {
    s = s.replace(/\)+$/g, "").trim();
  }
  return s;
}

/** Drop trailing cut-off fragments like "Pow" / "Eng" after cleanup left a short stub. */
function stripTrailingCutoffStub(value: string): string {
  // "… Electrical Pow" (no paren) when last token is suspiciously short & capitalized
  return value
    .replace(/\s+[A-Z][a-z]{0,2}$/g, "")
    .replace(/[,\s;:\-–—|/]+$/g, "")
    .trim();
}

/**
 * Sanitize a degree title (or similar education string) from model/OCR output.
 */
export function sanitizeDegreeTitle(
  value: string | null | undefined,
): string | null {
  if (value == null) return null;
  let s = stripJunkChars(String(value));
  if (!s) return null;

  // Australian VET national / training package code prefix (e.g. ICT60220, BSB50420)
  s = s.replace(/^[A-Z]{2,4}\d{5}\s+/i, "").trim();

  s = stripUnbalancedParens(s);
  s = stripTrailingCutoffStub(s);

  // Common OCR/model leftovers
  s = s
    .replace(/\s+on\s+(?:[A-Za-z]+\s+)?\d{1,2}\b[\s\S]*$/i, "")
    .replace(/\s+DEGREE\s+EXAMINATIONS[\s\S]*$/i, "")
    .replace(/\s+OFFICIAL\s+TRANSCRIPT[\s\S]*$/i, "")
    .trim();

  if (s.length < 3) return null;
  return s;
}

/** Lighter cleanup for institution / country / job strings. */
export function sanitizeExtractedLabel(
  value: string | null | undefined,
): string | null {
  if (value == null) return null;
  let s = stripJunkChars(String(value));
  if (!s) return null;
  s = stripUnbalancedParens(s);
  s = s.replace(/[,\s;:\-–—|/]+$/g, "").trim();
  if (s.length < 2) return null;
  return s;
}

export function sanitizeEducationExtract<
  T extends {
    degreeTitle?: string | null;
    institution?: string | null;
    country?: string | null;
  },
>(extract: T): T {
  return {
    ...extract,
    degreeTitle: sanitizeDegreeTitle(extract.degreeTitle ?? null),
    institution: sanitizeExtractedLabel(extract.institution ?? null),
    country: sanitizeExtractedLabel(extract.country ?? null),
  };
}
