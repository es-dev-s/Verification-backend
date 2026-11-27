/**
 * Engineering Technologist (233914) selection plus degree-title field matching
 * (ET Plus Degree Logic, 20 Nov 2026).
 *
 * 1. ET is offered only at Bachelor / Master / PhD (never diploma / adv dip /
 *    associate). Gate 1 already closes the ET track for associate-level awards;
 *    this module is the extra level check and the PE occupation filter.
 * 2. Field of study is the first keyword hit in the bachelor title (specific
 *    terms before general). "Computer Engineering" is not a listed term.
 * 3. When a field is identified, only PE occupations whose keywords match that
 *    field stay. When none is identified, a PE occupation stays only if its
 *    keywords appear in the degree title. ET is never removed here.
 * 4. When the field maps to a PE ANZSCO, remaining occupations except that
 *    match and ET lose FIELD_MATCH_PENALTY_PP.
 */
import { assessConfig } from "./config.js";
import type { QualificationInfo } from "./qualificationCheck.js";

const ET_CODE = "233914";

function normalizeCode(code: string | null | undefined): string {
  return String(code ?? "").replace(/\D+/g, "");
}

/** Percentage points removed from unmatched PE occupations (doc section 5). */
export const FIELD_MATCH_PENALTY_PP = assessConfig.fieldMatchPenaltyPp;

export type DegreeFieldId =
  | "geotechnical"
  | "structural"
  | "aeronautical"
  | "biomedical"
  | "agricultural"
  | "environmental"
  | "petroleum"
  | "chemical"
  | "materials"
  | "mining"
  | "telecommunication"
  | "electronic"
  | "electrical"
  | "mechanical"
  | "automation"
  | "industrial"
  | "civil"
  | "computer_science"
  | "information_technology";

export type DegreeFieldDef = {
  id: DegreeFieldId;
  label: string;
  /** First listed keyword in the degree title wins (order of FIELD_DEFS). */
  keywords: readonly string[];
  /** PE ANZSCO this field corresponds to; null = no 15% penalty. */
  matchedAnzsco: string | null;
  matchedTitle: string | null;
};

/**
 * Specific before general, as in the doc table. "Computer" / "Computer
 * Engineering" is intentionally absent.
 */
export const FIELD_DEFS: readonly DegreeFieldDef[] = [
  { id: "geotechnical", label: "Geotechnical", keywords: ["geotechnical"], matchedAnzsco: "233212", matchedTitle: "Geotechnical Engineer" },
  { id: "structural", label: "Structural", keywords: ["structural"], matchedAnzsco: "233214", matchedTitle: "Structural Engineer" },
  { id: "aeronautical", label: "Aeronautical", keywords: ["aeronautical", "aerospace"], matchedAnzsco: "233911", matchedTitle: "Aeronautical Engineer" },
  { id: "biomedical", label: "Biomedical", keywords: ["biomedical"], matchedAnzsco: "233913", matchedTitle: "Biomedical Engineer" },
  { id: "agricultural", label: "Agricultural", keywords: ["agricultural"], matchedAnzsco: "233912", matchedTitle: "Agricultural Engineer" },
  { id: "environmental", label: "Environmental", keywords: ["environmental"], matchedAnzsco: "233915", matchedTitle: "Environmental Engineer" },
  { id: "petroleum", label: "Petroleum", keywords: ["petroleum"], matchedAnzsco: "233612", matchedTitle: "Petroleum Engineer" },
  { id: "chemical", label: "Chemical", keywords: ["chemical"], matchedAnzsco: "233111", matchedTitle: "Chemical Engineer" },
  { id: "materials", label: "Materials", keywords: ["materials", "metallurgy"], matchedAnzsco: "233112", matchedTitle: "Materials Engineer" },
  { id: "mining", label: "Mining", keywords: ["mining"], matchedAnzsco: "233611", matchedTitle: "Mining Engineer" },
  { id: "telecommunication", label: "Telecommunication", keywords: ["telecommunication", "telecommunications", "telecom"], matchedAnzsco: "263311", matchedTitle: "Telecommunications Engineer" },
  { id: "electronic", label: "Electronic", keywords: ["electronics", "electronic"], matchedAnzsco: "233411", matchedTitle: "Electronics Engineer" },
  { id: "electrical", label: "Electrical", keywords: ["electrical"], matchedAnzsco: "233311", matchedTitle: "Electrical Engineer" },
  { id: "mechanical", label: "Mechanical", keywords: ["mechanical", "mechatronic", "mechatronics"], matchedAnzsco: "233512", matchedTitle: "Mechanical Engineer" },
  { id: "automation", label: "Automation", keywords: ["automation"], matchedAnzsco: null, matchedTitle: null },
  { id: "industrial", label: "Industrial", keywords: ["industrial", "manufacturing"], matchedAnzsco: "233511", matchedTitle: "Industrial Engineer" },
  { id: "civil", label: "Civil", keywords: ["civil"], matchedAnzsco: "233211", matchedTitle: "Civil Engineer" },
  { id: "computer_science", label: "Computer science", keywords: ["computer science", "software"], matchedAnzsco: null, matchedTitle: null },
  { id: "information_technology", label: "Information technology", keywords: ["information technology", "information-technology"], matchedAnzsco: null, matchedTitle: null },
];

/** Extra occupation keywords that are not in the ANZSCO title itself. */
const OCCUPATION_EXTRA_KEYWORDS: Record<string, readonly string[]> = {
  "233911": ["aerospace"],
  "233411": ["electronic"],
  "233311": ["electrical"],
  "233512": ["mechatronic", "mechatronics"],
  "233112": ["metallurgy"],
  "233511": ["manufacturing", "automation"],
  "233513": ["plant", "automation"],
  "263311": ["telecommunication", "telecom"],
  "263312": ["telecommunication", "telecommunications", "telecom"],
};

export type DegreeFieldSelection = {
  fieldId: DegreeFieldId | null;
  label: string | null;
  sourceTitle: string;
  matchedAnzsco: string | null;
  matchedTitle: string | null;
  /** True when section 5's extra 15% applies. */
  penaltyApplies: boolean;
};

const GENERIC_OCC_WORDS = new Set([
  "engineer",
  "engineering",
  "professional",
  "architect",
  "network",
  "and",
  "the",
  "or",
  "of",
  "nec",
]);

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Whole-keyword match; "IT" is its own token so it does not hit "circuit". */
export function titleHasKeyword(haystack: string, keyword: string): boolean {
  const h = haystack.trim();
  if (!h || !keyword) return false;
  if (keyword.toLowerCase() === "it") {
    return /(^|[^a-z])it([^a-z]|$)/i.test(h);
  }
  const re = new RegExp(`\\b${escapeRe(keyword)}\\b`, "i");
  return re.test(h);
}

/** First table row whose keyword appears in the title. */
export function identifyDegreeField(title: string | null | undefined): DegreeFieldDef | null {
  const t = (title ?? "").replace(/\s+/g, " ").trim();
  if (!t) return null;
  for (const def of FIELD_DEFS) {
    if (def.keywords.some((k) => titleHasKeyword(t, k))) return def;
  }
  if (titleHasKeyword(t, "IT")) {
    return FIELD_DEFS.find((d) => d.id === "information_technology") ?? null;
  }
  return null;
}

function isBachelorLike(q: QualificationInfo): boolean {
  const raw = (q.rawLevel ?? "").toLowerCase();
  if (raw === "bachelor") return true;
  return q.level === "bachelor";
}

/**
 * Title used for field detection: bachelor when both bachelor and master are
 * on file, else the first titled qualification.
 */
export function bachelorTitleForField(quals: readonly QualificationInfo[]): string {
  const titled = quals.filter((q) => (q.title ?? "").trim() || (q.fieldOfStudy ?? "").trim());
  const bachelor = titled.find(isBachelorLike) ?? titled[0];
  if (!bachelor) return "";
  return [(bachelor.title ?? "").trim(), (bachelor.fieldOfStudy ?? "").trim()]
    .filter(Boolean)
    .join(" ");
}

export function selectDegreeField(quals: readonly QualificationInfo[]): DegreeFieldSelection {
  const sourceTitle = bachelorTitleForField(quals);
  const def = identifyDegreeField(sourceTitle);
  return {
    fieldId: def?.id ?? null,
    label: def?.label ?? null,
    sourceTitle,
    matchedAnzsco: def?.matchedAnzsco ?? null,
    matchedTitle: def?.matchedTitle ?? null,
    penaltyApplies: Boolean(def?.matchedAnzsco),
  };
}

/** Bachelor / Master / PhD (including a PhD stored as rawLevel). Diploma-level never. */
function isSubBachelor(q: QualificationInfo): boolean {
  const v = (q.rawLevel || q.level || "").toLowerCase();
  return v === "diploma" || v === "advanced_diploma" || v === "associate_degree";
}

export function etOfferedForQualifications(quals: readonly QualificationInfo[]): boolean {
  if (!quals.length) return false;
  if (quals.every(isSubBachelor)) return false;
  return quals.some((q) => {
    const raw = (q.rawLevel ?? "").toLowerCase();
    if (raw === "bachelor" || raw === "master" || raw === "phd") return true;
    if (q.level === "bachelor" || q.level === "master") return true;
    return /\b(ph\.?d|doctorate|doctor of)\b/i.test(q.title ?? "");
  });
}

function occupationKeywords(anzscoCode: string, title: string): string[] {
  const extras = OCCUPATION_EXTRA_KEYWORDS[normalizeCode(anzscoCode)] ?? [];
  const fromTitle = title
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2 && !GENERIC_OCC_WORDS.has(w));
  return [...new Set([...fromTitle, ...extras])];
}

function occupationMatchesField(anzscoCode: string, title: string, field: DegreeFieldDef): boolean {
  const occKeys = occupationKeywords(anzscoCode, title);
  const occBlob = `${title} ${occKeys.join(" ")}`;
  return field.keywords.some((k) => titleHasKeyword(occBlob, k) || occKeys.includes(k.toLowerCase()));
}

/** Building and Engineering Technicians nec stays available on every diploma field. */
export const ASSOCIATE_NEC_CODE = "312999";

/**
 * Associate keep-filter. When a diploma-level qualification has an identified
 * field, only occupations whose title contains that field word stay, plus
 * 312999. No field identified: every Associate occupation stays. The 15-point
 * Professional Engineer penalty is not applied on this track.
 */
export function keepAssociateOccupation(
  anzscoCode: string,
  occupationTitle: string,
  selection: DegreeFieldSelection | null,
): boolean {
  if (normalizeCode(anzscoCode) === ASSOCIATE_NEC_CODE) return true;
  if (!selection?.fieldId) return true;
  const def = FIELD_DEFS.find((d) => d.id === selection.fieldId) ?? null;
  if (!def) return true;
  return occupationMatchesField(anzscoCode, occupationTitle, def);
}

/** Field of a diploma / advanced diploma / associate degree, when one is named. */
export function selectDiplomaField(quals: readonly QualificationInfo[]): DegreeFieldSelection | null {
  const diplomas = quals.filter(isSubBachelor);
  if (!diplomas.length) return null;
  const selection = selectDegreeField(diplomas);
  return selection.fieldId ? selection : null;
}

/**
 * Whether a Professional Engineer occupation stays in the scored list.
 * ET is not filtered here (callers skip this for the technologist track).
 */
export function keepProfessionalEngineer(
  anzscoCode: string,
  occupationTitle: string,
  selection: DegreeFieldSelection,
): boolean {
  if (normalizeCode(anzscoCode) === ET_CODE) return true;
  const def = selection.fieldId
    ? FIELD_DEFS.find((d) => d.id === selection.fieldId) ?? null
    : null;
  if (def) return occupationMatchesField(anzscoCode, occupationTitle, def);
  return occupationKeywords(anzscoCode, occupationTitle).some((k) =>
    titleHasKeyword(selection.sourceTitle, k),
  );
}

export function fieldPenaltyAppliesTo(
  anzscoCode: string,
  selection: DegreeFieldSelection,
): boolean {
  if (!selection.penaltyApplies || !selection.matchedAnzsco) return false;
  const code = normalizeCode(anzscoCode);
  if (code === ET_CODE) return false;
  if (code === normalizeCode(selection.matchedAnzsco)) return false;
  return true;
}

export function applyFieldMatchPenalty<T extends { confidenceScore: number }>(
  scored: T,
  anzscoCode: string,
  selection: DegreeFieldSelection,
): T {
  if (!fieldPenaltyAppliesTo(anzscoCode, selection)) return scored;
  const next = Math.max(0, Math.round((scored.confidenceScore - FIELD_MATCH_PENALTY_PP) * 10) / 10);
  return { ...scored, confidenceScore: next };
}
