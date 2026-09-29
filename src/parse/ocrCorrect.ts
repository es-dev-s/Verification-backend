/**
 * Conservative OCR typo fixes for institution/education tokens before Gemini.
 */
export type OcrCorrection = {
  original: string;
  corrected: string;
  index: number;
};

/** Known OCR garble → correct spelling (lowercase keys). */
export const INSTITUTION_OCR_CORRECTIONS: Record<string, string> = {
  aniversity: "university",
  univercity: "university",
  universtiy: "university",
  universiy: "university",
  univcrsity: "university",
  collge: "college",
  colllege: "college",
  colledge: "college",
  instiute: "institute",
  instituite: "institute",
  institue: "institute",
  technolgy: "technology",
  engneering: "engineering",
  engieering: "engineering",
};

function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const prev = new Array(b.length + 1);
  const cur = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= b.length; j++) prev[j] = cur[j];
  }
  return prev[b.length]!;
}

function lookupCorrection(tokenLower: string): string | null {
  if (INSTITUTION_OCR_CORRECTIONS[tokenLower]) {
    return INSTITUTION_OCR_CORRECTIONS[tokenLower]!;
  }
  // Allow close misspellings of known keys (edit distance 1–2)
  let best: { key: string; dist: number } | null = null;
  for (const key of Object.keys(INSTITUTION_OCR_CORRECTIONS)) {
    const maxDist = key.length <= 6 ? 1 : 2;
    const d = editDistance(tokenLower, key);
    if (d > 0 && d <= maxDist && (!best || d < best.dist)) {
      best = { key, dist: d };
    }
  }
  return best ? INSTITUTION_OCR_CORRECTIONS[best.key]! : null;
}

function preserveCase(original: string, replacement: string): string {
  if (original === original.toUpperCase()) return replacement.toUpperCase();
  if (original[0] && original[0] === original[0].toUpperCase()) {
    return replacement.charAt(0).toUpperCase() + replacement.slice(1);
  }
  return replacement;
}

/**
 * Apply whole-word OCR corrections. Returns corrected text + loggable edits.
 */
export function correctOcrEducationText(
  text: string,
  documentId?: string,
): { text: string; corrections: OcrCorrection[] } {
  if (!text) return { text: "", corrections: [] };

  const corrections: OcrCorrection[] = [];
  const out = text.replace(/\b([A-Za-z]{4,})\b/g, (match, _word, offset: number) => {
    const lower = match.toLowerCase();
    const fixed = lookupCorrection(lower);
    if (!fixed || fixed === lower) return match;
    const replaced = preserveCase(match, fixed);
    if (replaced === match) return match;
    corrections.push({ original: match, corrected: replaced, index: offset });
    return replaced;
  });

  if (corrections.length && documentId) {
    for (const c of corrections) {
      console.log(
        `[ocr-correct] doc=${documentId} "${c.original}" → "${c.corrected}" @${c.index}`,
      );
    }
  } else if (corrections.length) {
    for (const c of corrections) {
      console.log(`[ocr-correct] "${c.original}" → "${c.corrected}" @${c.index}`);
    }
  }

  return { text: out, corrections };
}
