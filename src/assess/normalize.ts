/** Normalize subject names for exact / fuzzy comparison. */
export function normalizeSubjectName(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/&/g, " and ")
    .replace(/\bchem\.?\s*eng(?:g|ineering)?\b/g, "chemical engineering")
    .replace(/\bche\b/g, "chemical engineering")
    .replace(/\bengg\b/g, "engineering")
    .replace(/\blab(?:oratory)?\.?\b/g, "lab")
    .replace(/\b(i{1,3}|iv|v|vi{0,3}|ix|x)\b/gi, (m) =>
      String(romanToInt(m.toLowerCase()) ?? m),
    )
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function romanToInt(r: string): number | null {
  const map: Record<string, number> = {
    i: 1,
    ii: 2,
    iii: 3,
    iv: 4,
    v: 5,
    vi: 6,
    vii: 7,
    viii: 8,
    ix: 9,
    x: 10,
  };
  return map[r] ?? null;
}

/**
 * Expand slash / comma variant patterns into alternate strings.
 * e.g. "Calculus 1 / 2 / 3" → ["Calculus 1", "Calculus 2", "Calculus 3"]
 *      "Applied Chemistry I, II" → ["Applied Chemistry I", "Applied Chemistry II"]
 */
export function expandVariantPatterns(variant: string): string[] {
  const trimmed = variant.trim();
  if (!trimmed) return [];
  const out = new Set<string>([trimmed]);

  const slash = trimmed.match(/^(.+?)\s+(\d+(?:\s*\/\s*\d+)+)\s*$/);
  if (slash) {
    const base = slash[1]!.trim();
    for (const n of slash[2]!.split(/\s*\/\s*/)) {
      out.add(`${base} ${n.trim()}`);
    }
  }

  const romanSlash = trimmed.match(
    /^(.+?)\s+((?:I|II|III|IV|V|VI|VII|VIII|IX|X)(?:\s*\/\s*(?:I|II|III|IV|V|VI|VII|VIII|IX|X))+)\s*$/i,
  );
  if (romanSlash) {
    const base = romanSlash[1]!.trim();
    for (const n of romanSlash[2]!.split(/\s*\/\s*/)) {
      out.add(`${base} ${n.trim()}`);
    }
  }

  const comma = trimmed.match(
    /^(.+?)\s+((?:I|II|III|IV|V|\d+)(?:\s*,\s*(?:I|II|III|IV|V|\d+))+)\s*$/i,
  );
  if (comma) {
    const base = comma[1]!.trim();
    for (const n of comma[2]!.split(/\s*,\s*/)) {
      out.add(`${base} ${n.trim()}`);
    }
  }

  // "A / B" combined titles — keep whole and each side when short
  if (trimmed.includes(" / ") && !slash && !romanSlash) {
    for (const part of trimmed.split(/\s*\/\s*/)) {
      if (part.trim().length >= 4) out.add(part.trim());
    }
  }

  return [...out];
}

export function tokens(value: string): string[] {
  const n = normalizeSubjectName(value);
  return n ? n.split(" ").filter(Boolean) : [];
}

/** Dice coefficient on word tokens. */
export function tokenSimilarity(a: string, b: string): number {
  const ta = tokens(a);
  const tb = tokens(b);
  if (!ta.length || !tb.length) return 0;
  const setB = new Set(tb);
  let inter = 0;
  for (const t of ta) if (setB.has(t)) inter++;
  return (2 * inter) / (ta.length + tb.length);
}

/** Simple Levenshtein ratio on normalized strings (for short names). */
export function editSimilarity(a: string, b: string): number {
  const s = normalizeSubjectName(a);
  const t = normalizeSubjectName(b);
  if (!s || !t) return 0;
  if (s === t) return 1;
  const m = s.length;
  const n = t.length;
  const dp = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i]![0] = i;
  for (let j = 0; j <= n; j++) dp[0]![j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      dp[i]![j] = Math.min(
        dp[i - 1]![j]! + 1,
        dp[i]![j - 1]! + 1,
        dp[i - 1]![j - 1]! + cost,
      );
    }
  }
  const dist = dp[m]![n]!;
  return 1 - dist / Math.max(m, n);
}

export function bestSimilarity(a: string, b: string): number {
  const token = tokenSimilarity(a, b);
  const edit = editSimilarity(a, b);
  // Prefer token overlap; blend a little edit for typos
  return Math.max(token, 0.6 * token + 0.4 * edit);
}

// ---------------------------------------------------------------------------
// Canonical forms for rule-based matching (abbreviations, plurals, levels).
// ---------------------------------------------------------------------------

/** Token-level abbreviations seen on transcripts → full word. */
export const SUBJECT_ABBREVIATIONS: Record<string, string> = {
  engg: "engineering",
  engr: "engineering",
  engin: "engineering",
  mech: "mechanical",
  mechl: "mechanical",
  elec: "electrical",
  elect: "electrical",
  electl: "electrical",
  maths: "mathematics",
  math: "mathematics",
  thermo: "thermodynamics",
  mgmt: "management",
  mgt: "management",
  mngt: "management",
  comm: "communication",
  comms: "communication",
  prog: "programming",
  intro: "introduction",
  struct: "structural",
  env: "environmental",
  environ: "environmental",
  chem: "chemistry",
  phys: "physics",
  mfg: "manufacturing",
  sys: "systems",
  dsgn: "design",
  eqns: "equations",
  eqn: "equation",
  tech: "technology",
  fund: "fundamentals",
  fundas: "fundamentals",
};

/**
 * Words that carry no subject identity on their own. Dropped when deciding
 * "core" equality / containment so e.g. "Basic Electrical Engineering" and
 * "Electrical Engineering" share the core {electrical}.
 */
export const SUBJECT_STOPWORDS = new Set([
  "engineering",
  "engineer",
  "introduction",
  "basic",
  "basics",
  "fundamental",
  "elementary",
  "element",
  "principle",
  "applied",
  "general",
  "system",
  "theory",
  "course",
  "concept",
  "of",
  "and",
  "the",
  "in",
  "for",
  "to",
  "with",
  "an",
  "a",
  "on",
]);

/**
 * Single words strong enough to anchor a containment match on their own
 * (e.g. rubric "Engineering Mathematics" ⊂ transcript "Discrete Mathematics").
 * Kept deliberately small: generic words like "mechanics", "design",
 * "communication", "control" are NOT anchors (too many false positives).
 */
export const SINGLE_WORD_ANCHORS = new Set([
  "mathematic",
  "physic",
  "chemistry",
  "thermodynamic",
  "calculus",
]);

/**
 * "Weak" words describe the course format, not its subject (lab, project,
 * seminar …). They are ignored when counting / comparing containment words.
 */
export const WEAK_SUBJECT_WORDS = new Set([
  "lab",
  "project",
  "practice",
  "practical",
  "workshop",
  "seminar",
  "advanced",
  "special",
  "selected",
  "topic",
  "modern",
]);

/**
 * Words too generic to carry a core-equality match on their own
 * ("Design & Engineering" must not equal "Engineering Design" → Machine Design).
 */
export const GENERIC_SUBJECT_WORDS = new Set([
  ...WEAK_SUBJECT_WORDS,
  "design",
  "technology",
  "process",
  "energy",
  "analysis",
  "science",
  "management",
  "study",
  "industrial",
]);

/** Minimum share of the longer side's core words the shorter side must cover. */
const MIN_CONTAINMENT_RATIO = 0.6;

/** Naive singularisation, applied symmetrically to both sides. */
export function singularize(token: string): string {
  if (token.length <= 3) return token;
  if (/(ss|us|is)$/.test(token)) return token;
  if (token.endsWith("ies") && token.length > 4) return `${token.slice(0, -3)}y`;
  if (/(ches|shes|xes|sses)$/.test(token)) return token.slice(0, -2);
  if (token.endsWith("s")) return token.slice(0, -1);
  return token;
}

/** Strip trailing course-level markers: "II", "2", "Part A", "(B)". */
function stripLevelSuffix(tokens: string[]): string[] {
  const out = [...tokens];
  while (out.length > 1) {
    const last = out[out.length - 1]!;
    if (/^\d+$/.test(last) || /^[ab]$/.test(last)) {
      out.pop();
      if (out.length > 1 && out[out.length - 1] === "part") out.pop();
      continue;
    }
    if (last === "part") {
      out.pop();
      continue;
    }
    break;
  }
  return out;
}

/**
 * Canonical token list: normalized, abbreviations expanded, singularised,
 * trailing level markers removed. "Engg. Maths II" → ["engineering","mathematic"].
 */
export function canonicalTokens(value: string): string[] {
  const base = normalizeSubjectName(value);
  if (!base) return [];
  const expanded = base
    .split(" ")
    .flatMap((t) => (SUBJECT_ABBREVIATIONS[t] ?? t).split(" "))
    .filter(Boolean)
    .map(singularize);
  // Drop course codes like "ch214" / "mt201" so they never block a match.
  return stripLevelSuffix(expanded.filter((t) => !/^[a-z]{1,5}\d{2,4}[a-z]?$/.test(t)));
}

export function canonicalSubjectName(value: string): string {
  return canonicalTokens(value).join(" ");
}

/** Canonical tokens minus stopwords (deduped, order kept). */
export function coreTokens(value: string): string[] {
  return coreFromCanonical(canonicalTokens(value));
}

export function coreFromCanonical(tokens: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of tokens) {
    if (SUBJECT_STOPWORDS.has(t) || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

export type RuleMatchKind = "canonical" | "core_equal" | "containment";

/**
 * Rule-based match between a transcript subject and a rubric variant using
 * precomputed canonical/core tokens. Returns the rule that fired or null.
 *
 * - canonical: identical after abbreviation / plural / level stripping
 * - core_equal: identical after also dropping stopwords (needs ≥1 core token)
 * - containment: every core token of the shorter side appears in the longer
 *   side, and the shorter side either has ≥2 non-weak words (lab/project/…
 *   ignored) covering ≥60% of the longer side's non-weak words, or its only
 *   non-weak word is an anchor
 *   (mathematics, physics, chemistry, thermodynamics, calculus).
 */
export function ruleMatch(
  a: { canonical: string; core: string[] },
  b: { canonical: string; core: string[] },
): RuleMatchKind | null {
  if (!a.canonical || !b.canonical) return null;
  if (a.canonical === b.canonical) return "canonical";
  if (!a.core.length || !b.core.length) return null;
  const sa = new Set(a.core);
  const sb = new Set(b.core);
  if (sa.size === sb.size && [...sa].every((t) => sb.has(t))) {
    if (sa.size === 1 && GENERIC_SUBJECT_WORDS.has([...sa][0]!)) return null;
    return "core_equal";
  }
  const [small, large] = sa.size <= sb.size ? [sa, sb] : [sb, sa];
  if (![...small].every((t) => large.has(t))) return null;
  const smallWords = [...small].filter((t) => !WEAK_SUBJECT_WORDS.has(t));
  const largeWords = [...large].filter((t) => !WEAK_SUBJECT_WORDS.has(t));
  if (smallWords.length === 1 && SINGLE_WORD_ANCHORS.has(smallWords[0]!)) {
    return "containment";
  }
  if (smallWords.length < 2) return null;
  if (smallWords.every((t) => GENERIC_SUBJECT_WORDS.has(t))) return null;
  return smallWords.length / Math.max(1, largeWords.length) >= MIN_CONTAINMENT_RATIO
    ? "containment"
    : null;
}

/**
 * "Differential Equations and Linear Algebra" → the two halves, so each can
 * match its own rubric subject. Only parts with ≥2 words are returned.
 */
export function compoundParts(name: string): string[] {
  const parts = name
    .split(/\s+(?:and|&)\s+|\s*[,;]\s*/i)
    .map((p) => p.trim())
    .filter((p) => p.split(/\s+/).length >= 2);
  return parts.length >= 2 ? parts : [];
}
