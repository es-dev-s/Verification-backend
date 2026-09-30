/**
 * Regex/heuristic fallbacks when Gemini is slow or unavailable.
 * Best-effort only — never invent values beyond pattern matches.
 */
import type {
  CvEducationEntry,
  CvEducationExtract,
  DegreeLevelLabel,
  DocumentTypeLabel,
  EducationExtract,
  EducationMultiExtract,
  ExperienceExtract,
  PerSourceEducation,
} from "./schemas.js";
import { sanitizeDegreeTitle } from "./sanitizeExtracted.js";

const COUNTRY_NAMES =
  "Australia|Canada|China|France|Germany|India|Ireland|Japan|Nepal|New Zealand|Philippines|Singapore|South Korea|United Kingdom|United States|United Arab Emirates|USA|UAE|Pakistan|Bangladesh|Sri Lanka|Malaysia|Indonesia|Thailand|Vietnam|Brazil|Mexico|Spain|Italy|Netherlands|Sweden|Norway|Denmark|Finland|Switzerland|Austria|Belgium|Portugal|Poland|Turkey|Egypt|South Africa|Nigeria|Kenya|Ghana|Qatar|Saudi Arabia";

/** Short codes last; filtered when adjacent to ECTS noise. */
const COUNTRY_RE = new RegExp(
  `\\b(${COUNTRY_NAMES}|UK)\\b`,
  "i",
);

const JUNK_DEGREE =
  /\b(?:maximum\s+marks|be\s+availed|be\s+adaptable|be\s+an\s+asset|postive|preparatory|and\s+to\s+be|organization\s+of|mutual\s+growth)\b/i;

const JUNK_INSTITUTION =
  /\b(?:name\s+of\s+the\s+college|seal\s+of\s+the\s+university|preparatory\s+school|high\s+school|state\s+government\s+university|secondary\s+education|board\s+of\s+kenya|given\s+under|livestock\s+research|research\s+institute)\b/i;

const MONTH =
  "(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)";

/** Include common OCR mojibake for en-dash. */
const DASH = "[-–—~]|\\u2013|\\u2014|â€\"|�\\?T|�\"";

function emptyEducation(): EducationExtract {
  return {
    degreeTitle: null,
    institution: null,
    country: null,
    start: null,
    end: null,
    statedDuration: null,
    multipleBachelors: false,
  };
}

function clean(s: string | null | undefined): string | null {
  if (!s) return null;
  const t = s
    .replace(/[\u0000-\u001f]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[\s|,:;\-–—]+|[\s|,:;\-–—]+$/g, "")
    .trim();
  return t || null;
}

function normalizeCountry(raw: string | null): string | null {
  if (!raw) return null;
  const key = raw.trim().toLowerCase();
  const map: Record<string, string> = {
    usa: "United States",
    uk: "United Kingdom",
    uae: "United Arab Emirates",
    india: "India",
    pakistan: "Pakistan",
    australia: "Australia",
    kenya: "Kenya",
    turkey: "Turkey",
    egypt: "Egypt",
  };
  if (map[key]) return map[key];
  return raw
    .split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}

/** Prefer Education / academic blocks on CVs; full text otherwise. */
function educationSearchText(text: string): string {
  const normalized = text
    .replace(/â€"|â€“|â€”|�\?"|�\?T|�"|�–|�—/g, "–")
    .replace(/\uFFFD+/g, "–");
  const edu = normalized.match(
    /(?:^|\n)\s*(?:education|academic\s+information|academic\s+background)\b[:\s]*([\s\S]{20,3500}?)(?=\n\s*(?:experience|work\s+history|employment|relevant\s+experience|professional\s+experience|skills|technical|projects|certifications|other\s+employment|affiliations|languages|references|research\s+publications)\b|$)/i,
  );
  if (edu?.[1] && edu[1].trim().length > 30) {
    return edu[1];
  }
  return normalized.slice(0, Math.min(normalized.length, 2500));
}

function trimDegree(cand: string): string {
  let s = cand
    .replace(/â€"|â€“|â€”|�\?"|�\?T|�"|�–|�—/g, "–")
    .replace(/\s+/g, " ")
    .trim();
  s = s
    .replace(/^degree of /i, "")
    .replace(/^DEGREE PROGRAMME?\s*[:\-_]?\s*/i, "")
    .replace(/\s+DEGREE EXAMINATIONS[\s\S]*$/i, "")
    .replace(/\s+OFFICIAL TRANSCRIPT[\s\S]*$/i, "")
    .replace(/\s+Second Class[\s\S]*$/i, "")
    .replace(/\s+First Class[\s\S]*$/i, "")
    .replace(/\s+with all the rights[\s\S]*$/i, "")
    .replace(/\s+tn recoguition[\s\S]*$/i, "")
    .replace(/\s+in recogni[st]ion[\s\S]*$/i, "")
    .replace(/\s+on (?:[A-Za-z]+ )?\d{1,2}\b[\s\S]*$/i, "")
    .replace(/\s+from [\s\S]*$/i, "")
    .replace(/\s+and postive[\s\S]*$/i, "")
    .replace(/\s+Cankaya University[\s\S]*$/i, "")
    .replace(/\s+GCUF\b[\s\S]*$/i, "")
    .replace(/\s+DAE\b[\s\S]*$/i, "")
    .replace(/\s+Dean Honors[\s\S]*$/i, "")
    .replace(/\s+CGPA\b[\s\S]*$/i, "")
    .replace(/\s+eww\b[\s\S]*$/i, "")
    .replace(/\s+To verify\b[\s\S]*$/i, "")
    .replace(/[.\s]+$/, "")
    .trim();
  // Hard cap: stop at obvious non-degree tokens
  s = s.replace(
    /\s+(?:University|Institute|College|Campus|CGPA|GPA|First|Second|Honours|Honors|Examinations|A\.P\.J\.|APJ)(?:\s|[\s\S])*$/i,
    "",
  );
  return sanitizeDegreeTitle(s) ?? s.trim();
}

function isLikelyBachelorDegree(s: string): boolean {
  if (!s || s.length < 4 || s.length > 120) return false;
  if (JUNK_DEGREE.test(s)) return false;
  if (
    /\b(?:advanced\s+diploma|diploma\b|master|m\.?\s*sc|mba|phd|doctorate)\b/i.test(
      s,
    ) &&
    !/\bbachelor|b\.?\s*(?:sc|tech|eng|e)\b|bsc|btech|beng|\bbs\b/i.test(s)
  ) {
    return false;
  }
  return true;
}

/** Subject/field after B.Sc / Bachelor — space, en-dash, or in/of. */
const FIELD_TAIL =
  "(?:\\s*(?:\\([^)]{0,40}\\))?(?:\\s*[–—\\-]\\s*|\\s+(?:in|of)\\s+|\\s+)[A-Za-z][A-Za-z0-9\\s&\\-(),./]{2,70})?";

function extractDegreeTitle(text: string): string | null {
  const space = educationSearchText(text);
  const patterns: RegExp[] = [
    new RegExp(
      `\\b(Bachelor(?:'?s|\`s)?\\s+of\\s+(?:Science|Engineering|Arts|Technology|Commerce|Business)${FIELD_TAIL})`,
      "i",
    ),
    /\b(Bachelor(?:'?s|`s)?\s+(?:degree\s+)?in\s+[A-Za-z][A-Za-z0-9\s&\-(),./]{2,70})/i,
    /\b(Bachelor\s+of\s+Engineering(?:\s*\([^)]{0,60}\))?(?:\s*,\s*[A-Za-z][A-Za-z0-9\s&\-(),./]{2,50})?(?:\s+in\s+[A-Za-z][A-Za-z0-9\s&\-(),./]{2,60})?)/i,
    /\b(BACHELOR OF (?:TECHNOLOGY|SCIENCE|ENGINEERING|ARTS)(?:\s*\([^)]{0,40}\))?)/i,
    /\b(B\.?\s*ENG\.?\s+IN\s+[A-Z][A-Za-z0-9\s&/]{4,70})/i,
    new RegExp(`\\b(B\\.\\s*Sc\\.?${FIELD_TAIL})`, "i"),
    new RegExp(`\\b(B\\.\\s*Tech\\.?${FIELD_TAIL})`, "i"),
    new RegExp(`\\b(B\\.\\s*Eng\\.?${FIELD_TAIL})`, "i"),
    new RegExp(`\\b(BSc\\.?${FIELD_TAIL})`, "i"),
    new RegExp(`\\b(B\\.S\\.?${FIELD_TAIL})`, "i"),
    /\b(BS\s+(?:in\s+)?[A-Za-z][A-Za-z0-9\s&\-]{3,60})/i,
    /\b(degree\s+of\s+Bachelor\s+of\s+[A-Za-z][A-Za-z0-9\s&\-(),./]{3,70})/i,
    /\b(DEGREE PROGRAMME?\s*[:\-_]?\s*[A-Z][A-Za-z0-9\s.&/]{5,80})/i,
    /\b(B\.S\.)\s*(?=February|January|March|April|May|June|July|August|September|October|November|December|\d)/i,
  ];

  let best: string | null = null;
  for (const re of patterns) {
    const m = space.match(re) ?? text.match(re);
    if (!m?.[1]) continue;
    let cand = clean(trimDegree(m[1]));
    if (!cand || !isLikelyBachelorDegree(cand)) continue;
    // Prefer more specific (longer) titles, but not OCR garbage past ~90 chars
    if (cand.length > 90) cand = cand.slice(0, 90).replace(/\s+\S*$/, "");
    if (!best || scoreDegree(cand) > scoreDegree(best)) best = cand;
  }
  return best;
}

function scoreDegree(s: string): number {
  let score = s.length;
  if (/bachelor/i.test(s)) score += 20;
  if (/engineering|science|technology|arts/i.test(s)) score += 10;
  if (/^B\.?\s*Sc\.?$/i.test(s) || /^B\.S\.?$/i.test(s)) score -= 30;
  return score;
}

function extractInstitution(text: string): string | null {
  const space = educationSearchText(text);
  const patterns: RegExp[] = [
    /\b((?:APJ|A\.P\.J\.)\s+Abdul\s+Kalam\s+Technological\s+University)/i,
    /\b(Middle\s+East\s+Technical\s+University(?:\s*\([^)]+\))?)/i,
    /\b(Visvesvaraya\s+Technological\s+University(?:,?\s*Belagavi)?)/i,
    /\b(Jawaharlal\s+Nehru\s+Technological\s+University(?:\s+Hyderabad)?)/i,
    /\b(Government\s+College\s+University(?:\s+Faisalabad)?)/i,
    /\b(COMSATS\s+University(?:\s+Islamabad)?)/i,
    /\b(Mohammad\s+Ali\s+Jinnah\s+University)/i,
    /\b(Moi\s+University)/i,
    /\b(MOI\s+UNIVERSITY)/,
    /\b(Suez\s+University)/i,
    /\b(Cankaya\s+University)/i,
    /\b(CANKAYA\s+UNIVERSITY)/,
    /\b(BELLA\s+COLLEGE\s+AUSTRALIA)/i,
    /\b(Habib\s+University)/i,
    /\b((?:[A-Z][A-Za-z0-9.&'`\-]+(?:\s+(?:of|and|the|for|in|at))?\s+){0,5}[A-Z][A-Za-z0-9.&'`\-]+\s+(?:University|Institute|College|Polytechnic)(?:\s+(?:of|for)\s+[A-Z][A-Za-z0-9.&'`\-\s]{2,40})?)/,
  ];

  for (const re of patterns) {
    const m = space.match(re);
    const cand = clean(m?.[1] ?? null);
    if (!cand || cand.length < 5 || cand.length > 100) continue;
    if (JUNK_INSTITUTION.test(cand)) continue;
    if (/high\s+school|secondary|livestock|research\s+institute/i.test(cand)) {
      continue;
    }
    // Strip trailing city/country after comma for institution field
    return cand.replace(/,\s*(India|Pakistan|Turkey|Kenya|Egypt|Australia)\b.*$/i, "").trim();
  }

  // Fallback: full-text known universities only (not generic Institute matcher)
  for (const re of patterns.slice(0, -1)) {
    const m = text.match(re);
    const cand = clean(m?.[1] ?? null);
    if (cand && !JUNK_INSTITUTION.test(cand)) {
      return cand.replace(/,\s*(India|Pakistan|Turkey|Kenya|Egypt|Australia)\b.*$/i, "").trim();
    }
  }
  return null;
}

function isFalseCountryHit(text: string, matchIndex: number, matched: string): boolean {
  const window = text.slice(Math.max(0, matchIndex - 12), matchIndex + matched.length + 20);
  // Turkish transcript ECTS column: "T U UK (ECTS)"
  if (/^uk$/i.test(matched) && /\bUK\s*\(ECTS\)|T\s+U\s+UK\b/i.test(window)) {
    return true;
  }
  // Profile marketing: "years in UK consultancy"
  if (/years?\s+in\s+UK\b|UK\s+consultancy/i.test(window)) return true;
  return false;
}

function extractCountry(text: string): string | null {
  const space = educationSearchText(text);

  const trySpace = (chunk: string): string | null => {
    const re = new RegExp(COUNTRY_RE.source, "gi");
    let m: RegExpExecArray | null;
    while ((m = re.exec(chunk))) {
      if (isFalseCountryHit(chunk, m.index, m[1]!)) continue;
      // Prefer full names over UK/USA short codes when both exist
      if (/^(UK|USA|UAE)$/i.test(m[1]!) && /India|Pakistan|Turkey|Kenya|Egypt|Australia/i.test(chunk)) {
        continue;
      }
      return normalizeCountry(m[1]!);
    }
    return null;
  };

  const cityCountry = space.match(
    new RegExp(
      `\\b[A-Z][a-zA-Z]+(?:\\s+[A-Z][a-zA-Z]+)?,\\s*(${COUNTRY_NAMES}|UK)\\b`,
      "i",
    ),
  );
  if (cityCountry?.[1] && !isFalseCountryHit(space, cityCountry.index ?? 0, cityCountry[1])) {
    return normalizeCountry(cityCountry[1]);
  }

  return trySpace(space) ?? trySpace(text.slice(0, 1500));
}

function extractYears(text: string): {
  start: string | null;
  end: string | null;
  statedDuration: string | null;
} {
  let start: string | null = null;
  let end: string | null = null;
  const space = educationSearchText(text);

  // Year of Admission / academic year of entry: take first year only (2013-2014 → start 2013)
  const admissionRange = text.match(
    /\b(?:year\s+of\s+admission|academic\s+year)\s*[:\-.]?\s*((?:19|20)\d{2})\s*[-–—/]\s*((?:19|20)\d{2})/i,
  );
  if (admissionRange) {
    start = admissionRange[1] ?? null;
    // Do not set end from admission academic-year pair
  }

  const session = text.match(
    /\b(?:session|batch)\s*[:\-.]?\s*((?:19|20)\d{2})\s*[-–—/to]+\s*((?:19|20)\d{2})/i,
  );
  if (session) {
    start = start ?? session[1] ?? null;
    end = end ?? session[2] ?? null;
  }

  // Packed METU-style: September 02, 2015B.S.February 08, 2021
  const packed = text.match(
    /(?:DATE OF ENTRY|September|January|February|March|April|May|June|July|August|October|November|December)\s+\d{1,2},?\s*((?:19|20)\d{2})\s*B\.?S\.?\s*(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s*((?:19|20)\d{2})/i,
  );
  if (packed) {
    start = start ?? packed[1] ?? null;
    end = end ?? packed[2] ?? null;
  }

  const entry = text.match(
    /\b(?:date\s+of\s+entry|admitted\s+(?:towards|to|on)|student\s+admitted)[^\n]{0,80}?((?:19|20)\d{2})/i,
  );
  if (entry?.[1]) start = start ?? entry[1];

  const grad = text.match(
    /\b(?:date\s+of\s+graduation|successfully\s+completed[^\n]{0,80}?on|month\s*&\s*year\s+of\s+final\s+exam)\s*[:\-.]?\s*[^\n]{0,40}?((?:19|20)\d{2})/i,
  );
  if (grad?.[1]) end = end ?? grad[1];

  // Final exam: "May,2017"
  const finalExam = text.match(
    /\b(?:month\s*&\s*year\s+of\s+final\s+exam|final\s+exam)\s*[:\-.]?\s*[A-Za-z]+,?\s*((?:19|20)\d{2})/i,
  );
  if (finalExam?.[1]) end = end ?? finalExam[1];

  // CV education date range (year-year or Mon YYYY – Mon YYYY)
  if (!start || !end) {
    const monthYearRange = space.match(
      new RegExp(
        `\\b(?:${MONTH})\\s+((?:19|20)\\d{2})\\s*[-–—to/]+\\s*(?:${MONTH}\\s+)?((?:19|20)\\d{2}|present|current|ongoing)\\b`,
        "i",
      ),
    );
    if (monthYearRange) {
      start = start ?? monthYearRange[1] ?? null;
      const endRaw = monthYearRange[2] ?? null;
      end =
        end ??
        (endRaw
          ? /present|current|ongoing/i.test(endRaw)
            ? "Present"
            : endRaw
          : null);
    }
  }

  if (!start || !end) {
    const range = space.match(
      /\b((?:19|20)\d{2})\s*[-–—to/]+\s*((?:19|20)\d{2}|present|current|ongoing)\b/i,
    );
    if (range) {
      const a = Number(range[1]);
      const bRaw = range[2]!;
      const b = /present|current|ongoing/i.test(bRaw) ? null : Number(bRaw);
      if (b == null || b - a >= 2) {
        start = start ?? range[1] ?? null;
        end = end ?? (b == null ? "Present" : String(b));
      } else if (!start && !admissionRange) {
        start = range[1] ?? null;
      }
    }
  }

  // statedDuration: only near education wording, never "N years experience/consultancy"
  let statedDuration: string | null = null;
  const durContextual = space.match(
    /\b(?:duration|programme\s+is|program\s+is|comprising|of)\s+[^\n]{0,40}?(\d{1,2}\s*(?:years?|yrs?))\b/i,
  );
  const fourYears = text.match(
    /\b((?:four|4|three|3|five|5)\s+years?(?:\s+duration)?)\b/i,
  );
  if (durContextual?.[1] && !/experience|consultanc|employment/i.test(durContextual[0]!)) {
    statedDuration = clean(durContextual[1]);
  } else if (
    fourYears?.[1] &&
    /graduate\s+program|programme\s+is|comprising|duration/i.test(
      text.slice(Math.max(0, (fourYears.index ?? 0) - 80), (fourYears.index ?? 0) + 40),
    )
  ) {
    statedDuration = clean(
      fourYears[1]!
        .replace(/four/i, "4")
        .replace(/three/i, "3")
        .replace(/five/i, "5"),
    );
  }

  return { start, end, statedDuration };
}

export function heuristicsEducationFromText(text: string): EducationExtract {
  const extract = emptyEducation();
  if (!text.trim()) return extract;

  const isDiplomaOnly =
    /\badvanced\s+diploma\b/i.test(text) &&
    !/\bbachelor|b\.?\s*sc|b\.?\s*tech|b\.?\s*eng|\bbs\b/i.test(text);

  if (!isDiplomaOnly) {
    extract.degreeTitle = extractDegreeTitle(text);
  }

  extract.institution = extractInstitution(text);
  extract.country = extractCountry(text);

  const years = extractYears(text);
  extract.start = years.start;
  extract.end = years.end;
  extract.statedDuration = years.statedDuration;

  return extract;
}

function guessDegreeLevel(line: string): DegreeLevelLabel | null {
  if (/\b(ph\.?\s*d|doctorate|doctor\s+of\s+philosophy|dphil|edd)\b/i.test(line)) {
    return "phd";
  }
  if (
    /\b(master|m\.?\s*sc|msc|m\.?\s*eng|mba|mphil|postgraduate)\b/i.test(line)
  ) {
    return "master";
  }
  if (/\badvanced\s+diploma|adv\.?\s*diploma|graduate\s+diploma\b/i.test(line)) {
    return "advanced_diploma";
  }
  if (
    /\b(bachelor|b\.?\s*sc|bsc|b\.?\s*tech|b\.?\s*eng|beng|undergraduate|\bbs\b|\bba\b)\b/i.test(
      line,
    )
  ) {
    return "bachelor";
  }
  if (/\bdiploma\b/i.test(line)) return "diploma";
  return null;
}

/**
 * Best-effort multi-entry CV education parse (heuristics fallback).
 * Returns every detectable award line tagged with a degreeLevel guess.
 */
export function heuristicsCvEducationEntries(text: string): CvEducationExtract {
  const entries: CvEducationEntry[] = [];
  if (!text.trim()) return { entries };

  const eduBlock =
    text.match(
      /(?:^|\n)\s*(?:education|qualifications|academic\s+background|academic\s+information)\b[:\s]*([\s\S]{20,5000}?)(?=\n\s*(?:experience|work\s+history|employment|skills|technical|projects|certifications|languages|references)\b|$)/i,
    )?.[1] ?? text;

  const lines = eduBlock
    .split(/\n+/)
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter((l) => l.length > 4);

  for (const line of lines) {
    const level = guessDegreeLevel(line);
    if (!level) continue;
    const base = heuristicsEducationFromText(line);
    // Prefer title from the line itself when extractDegreeTitle works on the snippet
    if (!base.degreeTitle) {
      base.degreeTitle = sanitizeDegreeTitle(line.slice(0, 120));
    }
    if (!base.degreeTitle && !base.institution) continue;
    entries.push({
      ...base,
      degreeLevel: level,
      multipleBachelors: false,
    });
  }

  // Fallback: single bachelor extract from full text if nothing line-matched
  if (!entries.length) {
    const one = heuristicsEducationFromText(text);
    if (one.degreeTitle || one.institution) {
      entries.push({
        ...one,
        degreeLevel: guessDegreeLevel(text) ?? "bachelor",
      });
    }
  }

  return { entries };
}

export function heuristicsEducationMulti(
  labeled: Array<{
    documentId: string;
    documentType: DocumentTypeLabel;
    text: string;
  }>,
): EducationMultiExtract {
  return {
    sources: labeled.map((d) => ({
      documentId: d.documentId,
      documentType: d.documentType,
      ...heuristicsEducationFromText(d.text),
    })),
  };
}

export function heuristicsPerSource(
  labeled: Array<{
    documentId: string;
    documentType: DocumentTypeLabel;
    text: string;
  }>,
): PerSourceEducation[] {
  return labeled.map((d) => ({
    documentId: d.documentId,
    documentType: d.documentType,
    extract: heuristicsEducationFromText(d.text),
  }));
}

const DATE_RANGE_INLINE = new RegExp(
  `\\b((?:${MONTH}\\s+)?(?:19|20)\\d{2}|\\d{1,2}\\/(?:19|20)\\d{2})\\s*(?:${DASH}|to)+\\s*((?:${MONTH}\\s+)?(?:19|20)\\d{2}|\\d{1,2}\\/(?:19|20)\\d{2}|present|current|ongoing)\\b`,
  "i",
);

const DATE_RANGE_TO = new RegExp(
  `\\b((?:${MONTH}\\s+)?(?:19|20)\\d{2})\\s+TO\\s+((?:${MONTH}\\s+)?(?:19|20)\\d{2}|PRESENT|CURRENT)\\b`,
  "i",
);

function parseDateEnd(endRaw: string | null | undefined): string | null {
  if (!endRaw) return null;
  if (/present|current|ongoing/i.test(endRaw)) return "Present";
  return clean(endRaw);
}

function looksLikeTitle(s: string): boolean {
  return /\b(engineer|developer|manager|analyst|intern|officer|consultant|lead|director|specialist|technician|assembler|professor|associate|coordinator|supervisor|draughtsman|assistant|architect|presales|field\s+engineer|research|scanning|production)\b/i.test(
    s,
  );
}

function looksLikeJunkJobLine(s: string): boolean {
  return /^(key\s+responsibilities|summary|profile|education|skills|projects|references|•|\*)/i.test(
    s,
  );
}

/**
 * Best-effort engineering-related flag from title/employer only.
 * Returns null when the text is too thin to decide (matches prompt: don't guess).
 */
export function guessEngineeringRelated(
  title: string | null | undefined,
  employer?: string | null,
): boolean | null {
  const blob = `${title ?? ""} ${employer ?? ""}`.trim();
  if (!blob) return null;
  if (
    /\b(engineer|engineering|draughtsman|draftsman|site\s+supervisor|site\s+engineer|civil|mechanical|electrical|structural|construction|maintenance\s+engineer|field\s+engineer|geotech|petroleum\s+engineer|software\s+engineer|hardware\s+engineer)\b/i.test(
      blob,
    )
  ) {
    return true;
  }
  // Clear non-engineering titles we can reject without duties text
  if (
    /\b(accountant|teacher|nurse|chef|marketer|sales\s+executive|receptionist|cashier|waiter|barista)\b/i.test(
      blob,
    )
  ) {
    return false;
  }
  return null;
}

export function heuristicsExperienceFromText(text: string): ExperienceExtract {
  const rows: ExperienceExtract["rows"] = [];
  if (!text.trim()) return { rows };

  const normalized = text
    .replace(/â€"|â€“|â€”|�\?"|�\?T|�"|�–|�—/g, "–")
    .replace(/\uFFFD+/g, "–");

  const section =
    normalized.match(
      /(?:work\s+(?:history|experience)|professional\s+experience|relevant\s+experience|employment|experience)\s*[:\n]+([\s\S]{30,12000}?)(?:\n\s*(?:education|academic|skills|technical\s+skills|projects|certifications|core\s+competencies|affiliations|other\s+employment|languages|references|research\s+publications)\b|$)/i,
    )?.[1] ?? normalized;

  const pushRow = (
    employer: string | null,
    title: string | null,
    start: string | null,
    end: string | null,
    statedDurationYears: number | null = null,
  ) => {
    let e = clean(employer);
    let t = clean(title);
    if (!e && !t) return;
    if (e && looksLikeJunkJobLine(e)) return;
    if (t && looksLikeJunkJobLine(t)) return;
    // Skip education rows mixed into experience (Ahmad CV lists degrees under same date style)
    if (
      t &&
      /\b(bachelor|b\.?\s*sc|b\.?\s*tech|bs\b|be\b|master|m\.?\s*sc|ms\b|mba|phd|diploma)\b/i.test(
        t,
      )
    ) {
      return;
    }
    if (e && e.length > 80) e = e.slice(0, 80);
    // Employer shouldn't be a lone country
    if (e && /^(UK|USA|India|Pakistan|Turkey|Egypt|Australia|Kenya)$/i.test(e)) {
      e = null;
    }
    if (
      rows.some(
        (r) =>
          r.employer === e &&
          r.title === t &&
          r.start === clean(start) &&
          r.end === parseDateEnd(end) &&
          (r.statedDurationYears ?? null) === (statedDurationYears ?? null),
      )
    ) {
      return;
    }
    // Dedupe same title+dates even if employer varies slightly
    if (
      t &&
      rows.some(
        (r) =>
          r.title === t &&
          r.start === clean(start) &&
          r.end === parseDateEnd(end) &&
          (clean(start) != null || parseDateEnd(end) != null),
      )
    ) {
      return;
    }
    rows.push({
      employer: e,
      title: t,
      start: clean(start),
      end: parseDateEnd(end),
      statedDurationYears: statedDurationYears ?? null,
      domainMatch: guessEngineeringRelated(t, e),
    });
  };

  const lines = section
    .split(/\n+/)
    .map((l) => l.replace(/\t+/g, "  ").trim())
    .filter(Boolean);

  for (let i = 0; i < lines.length && rows.length < 12; i++) {
    const line = lines[i]!;
    if (looksLikeJunkJobLine(line)) continue;

    // Pattern A: Title | Employer | dates  (require a date on the SAME line)
    // Use dash separators only — word "TO" is handled by empTo below.
    const pipe = line.match(
      new RegExp(
        `^(.{2,70}?)\\s*\\|\\s*(.{2,70}?)\\s*\\|?\\s*((?:${MONTH}|\\d{1,2}/)[^|]*?(?:19|20)\\d{2})\\s*(?:${DASH})+\\s*((?:${MONTH}\\s+)?(?:19|20)\\d{2}|\\d{1,2}/(?:19|20)\\d{2}|[Pp]resent|[Cc]urrent|[A-Za-z]{3,9}\\s+(?:19|20)\\d{2})`,
        "i",
      ),
    );
    if (pipe) {
      pushRow(pipe[2], pipe[1], pipe[3], pipe[4]);
      continue;
    }

    // Title | Employer   dates without third pipe
    const pipe2 = line.match(
      new RegExp(
        `^(.{2,70}?)\\s*\\|\\s*(.{2,70}?)\\s+((?:${MONTH}|\\d{1,2}/)[^|]*?(?:19|20)\\d{2})\\s*(?:${DASH})+\\s*((?:${MONTH}\\s+)?(?:19|20)\\d{2}|\\d{1,2}/(?:19|20)\\d{2}|[Pp]resent|[Cc]urrent|[A-Za-z]{3,9}\\s+(?:19|20)\\d{2})`,
        "i",
      ),
    );
    if (pipe2) {
      pushRow(pipe2[2], pipe2[1], pipe2[3], pipe2[4]);
      continue;
    }

    // Title + dates on same line (spaced): "Enterprise Presales Engineer  April 2024 – Present"
    const titleDates = line.match(
      new RegExp(
        `^(.{5,80}?)\\s{2,}(${MONTH}\\s+(?:19|20)\\d{2})\\s*(?:${DASH})+\\s*((?:${MONTH}\\s+)?(?:19|20)\\d{2}|[Pp]resent|[Cc]urrent)\\s*$`,
        "i",
      ),
    );
    if (titleDates) {
      const next = lines[i + 1] ?? null;
      let employer: string | null = null;
      if (
        next &&
        !DATE_RANGE_INLINE.test(next) &&
        !looksLikeJunkJobLine(next)
      ) {
        employer = next
          .replace(/\s+Key Responsibilities.*$/i, "")
          .trim();
        if (!employer || /key\s+responsibilities/i.test(employer)) {
          employer = null;
        }
      }
      pushRow(employer, titleDates[1], titleDates[2], titleDates[3]);
      continue;
    }

    // Employer  MON YYYY TO PRESENT  then title next line (Ahmad)
    const empTo = line.match(
      new RegExp(
        `^(.{3,80}?)\\s+(${MONTH}\\s+(?:19|20)\\d{2}|(?:19|20)\\d{2})\\s+TO\\s+((?:${MONTH}\\s+)?(?:19|20)\\d{2}|PRESENT|CURRENT)\\s*$`,
        "i",
      ),
    );
    if (empTo) {
      const next = lines[i + 1] ?? null;
      const title =
        next && !DATE_RANGE_TO.test(next) && !DATE_RANGE_INLINE.test(next)
          ? next
          : null;
      // "IBEX | Global Pakistan" → employer IBEX / Global Pakistan
      let employer = empTo[1]!;
      if (employer.includes("|")) {
        employer = employer.split("|").map((p) => p.trim()).filter(Boolean).join(" ");
      }
      pushRow(employer, title, empTo[2], empTo[3]);
      continue;
    }

    // Dates alone; previous line is "Title – … – Company"
    const dateOnly = line.match(DATE_RANGE_INLINE) || line.match(DATE_RANGE_TO);
    if (dateOnly && line.length < 45) {
      const prev = lines[i - 1] ?? null;
      if (!prev) continue;
      const dash = prev.match(
        /^(.{3,80}?)\s+[–—-]\s+(.{3,80}?)(?:\s+[–—-]\s+(.+))?$/,
      );
      if (dash) {
        const left = clean(dash[1]);
        const mid = clean(dash[2]);
        const right = clean(dash[3] ?? null);
        if (right) {
          const employer = right.split(",")[0]?.trim() ?? right;
          pushRow(employer, left, dateOnly[1], dateOnly[2]);
        } else {
          pushRow(mid, left, dateOnly[1], dateOnly[2]);
        }
      } else if (prev.includes("|")) {
        const parts = prev.split("|").map((p) => p.trim()).filter(Boolean);
        if (parts.length >= 2) {
          pushRow(parts[1]!, parts[0]!, dateOnly[1], dateOnly[2]);
        }
      } else {
        const prev2 = lines[i - 2] ?? null;
        if (prev2 && looksLikeTitle(prev2)) {
          pushRow(prev, prev2, dateOnly[1], dateOnly[2]);
        } else if (looksLikeTitle(prev)) {
          pushRow(prev2, prev, dateOnly[1], dateOnly[2]);
        }
      }
    }
  }

  // Duration-only lines (no calendar dates), e.g.
  // "3 Years experience as a Site Supervisor in UCC Pvt. Ltd"
  const durationOnlyRe =
    /(\d{1,2})\s*(?:years?|yrs?)\s+(?:of\s+)?experience\s+as\s+(?:an?\s+)?([^,\n]+?)\s+(?:in|at|with|for)\s+([^\n]+?)(?=\s*(?:\n|$))/gi;
  const durationSearch = `${section}\n${normalized}`;
  let dm: RegExpExecArray | null;
  durationOnlyRe.lastIndex = 0;
  while ((dm = durationOnlyRe.exec(durationSearch)) && rows.length < 12) {
    const years = Number(dm[1]);
    const title = clean(dm[2]);
    const employer = clean(dm[3]?.replace(/[.,;]+$/g, "") ?? null);
    if (!Number.isFinite(years) || years <= 0) continue;
    pushRow(employer, title, null, null, years);
  }

  return { rows: rows.slice(0, 12) };
}
