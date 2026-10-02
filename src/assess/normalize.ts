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
