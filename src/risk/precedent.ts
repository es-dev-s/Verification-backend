import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isLikelyAcronymMatch } from "../parse/institutionMatch.js";
import type {
  PrecedentCaseRow,
  PrecedentCheck,
  PrecedentRiskLevel,
} from "./schemas.js";

type QualBlock = {
  title?: string | null;
  university?: string | null;
  college?: string | null;
  country?: string | null;
};

type DatasheetCase = {
  no?: number;
  occupation?: { name?: string | null; anzscoCode?: string | null };
  qualifications?: {
    diploma?: QualBlock | null;
    bachelor?: QualBlock | null;
    master?: QualBlock | null;
  };
  verified?: { month?: string | null; year?: number | null };
  /** Historical risk tier from the datasheet: No Risk / Slight Risk / High Risk. */
  outcomePossibility?: string | null;
  /** Historical final result: Positive / Negative / Banned. */
  outcome?: string | null;
};

type DatasheetFile = {
  cases?: DatasheetCase[];
};

export type ApplicantProfile = {
  anzscoCode: string;
  occupationTitle: string;
  degreeTitle: string | null;
  university: string | null;
  country: string | null;
};

let casesCache: DatasheetCase[] | null = null;

function datasheetPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "../lib/verification_datasheet.json");
}

function normalizeCode(code: string): string {
  return code.replace(/\s+/g, "").replace(/PE$/i, "").trim();
}

function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function loadCases(): DatasheetCase[] {
  if (casesCache) return casesCache;
  const raw = JSON.parse(
    readFileSync(datasheetPath(), "utf8"),
  ) as DatasheetFile;
  casesCache = raw.cases ?? [];
  return casesCache;
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const prev = new Array<number>(b.length + 1);
  const cur = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(
        prev[j]! + 1,
        cur[j - 1]! + 1,
        prev[j - 1]! + cost,
      );
    }
    for (let j = 0; j <= b.length; j++) prev[j] = cur[j]!;
  }
  return prev[b.length]!;
}

/** Loose text match: exact normalized, containment, or shared significant tokens. */
export function textFieldsMatch(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  if (!a?.trim() || !b?.trim()) return false;
  const na = normalizeText(a);
  const nb = normalizeText(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  if (na.includes(nb) || nb.includes(na)) return true;
  if (Math.abs(na.length - nb.length) <= 2 && levenshtein(na, nb) <= 2) {
    return true;
  }

  const tokensA = na.split(" ").filter((t) => t.length > 2);
  const tokensB = nb.split(" ").filter((t) => t.length > 2);
  if (!tokensA.length || !tokensB.length) return false;

  let overlap = 0;
  const used = new Set<number>();
  for (const ta of tokensA) {
    const idx = tokensB.findIndex((tb, i) => {
      if (used.has(i)) return false;
      return tb === ta || levenshtein(ta, tb) <= 1;
    });
    if (idx >= 0) {
      used.add(idx);
      overlap += 1;
    }
  }
  const minSize = Math.min(tokensA.length, tokensB.length);
  return overlap >= Math.max(2, Math.ceil(minSize * 0.6));
}

export function countryFieldsMatch(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  if (!a?.trim() || !b?.trim()) return false;
  const na = normalizeText(a);
  const nb = normalizeText(b);
  if (na === nb) return true;
  return na.includes(nb) || nb.includes(na);
}

export function universityFieldsMatch(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  if (!a?.trim() || !b?.trim()) return false;
  if (textFieldsMatch(a, b)) return true;
  return isLikelyAcronymMatch(a, b);
}

function pickPastQualification(row: DatasheetCase): {
  degree: string | null;
  university: string | null;
  country: string | null;
} {
  const quals = row.qualifications;
  const order: Array<QualBlock | null | undefined> = [
    quals?.bachelor,
    quals?.master,
    quals?.diploma,
  ];
  for (const q of order) {
    if (!q) continue;
    const degree = q.title?.trim() || null;
    const university =
      q.university?.trim() || q.college?.trim() || null;
    const country = q.country?.trim() || null;
    if (degree || university || country) {
      return { degree, university, country };
    }
  }
  return { degree: null, university: null, country: null };
}

/**
 * Map datasheet `outcomePossibility` to precedent risk.
 * Values are reused as stored — not recalculated.
 */
export function parseOutcomePossibility(
  value: string | null | undefined,
): PrecedentRiskLevel | null {
  const v = (value ?? "").trim().toLowerCase();
  if (!v) return null;
  if (v === "no risk" || v === "no_risk") return "no_risk";
  if (v === "slight risk" || v === "slight_risk") return "slight_risk";
  if (v === "high risk" || v === "high_risk") return "high_risk";
  return null;
}

function formatVerifiedDate(
  verified: DatasheetCase["verified"],
): string | null {
  if (!verified) return null;
  const month = verified.month?.trim() || null;
  const year = verified.year ?? null;
  if (month && year) return `${month} ${year}`;
  if (year) return String(year);
  if (month) return month;
  return null;
}

function mostCommonRisk(
  counts: Record<PrecedentRiskLevel, number>,
): PrecedentRiskLevel | null {
  const total =
    counts.no_risk + counts.slight_risk + counts.high_risk;
  if (total === 0) return null;

  // Prefer more severe on ties so overall risk is conservative.
  const order: PrecedentRiskLevel[] = [
    "high_risk",
    "slight_risk",
    "no_risk",
  ];
  let best: PrecedentRiskLevel = "no_risk";
  let bestCount = -1;
  for (const level of order) {
    if (counts[level] > bestCount) {
      best = level;
      bestCount = counts[level];
    }
  }
  return best;
}

/**
 * Precedent check: past datasheet cases with the same ANZSCO occupation.
 * Risk (`outcomePossibility`) and outcome are reused from historical data.
 */
export function buildPrecedentCheck(
  applicant: ApplicantProfile,
): PrecedentCheck {
  const code = normalizeCode(applicant.anzscoCode);
  const matched: PrecedentCaseRow[] = [];
  const riskCounts: Record<PrecedentRiskLevel, number> = {
    no_risk: 0,
    slight_risk: 0,
    high_risk: 0,
  };
  let positive = 0;

  for (const row of loadCases()) {
    const pastCode = row.occupation?.anzscoCode;
    if (!pastCode || normalizeCode(pastCode) !== code) continue;

    const past = pickPastQualification(row);
    const matchRisk = parseOutcomePossibility(row.outcomePossibility);
    if (matchRisk) riskCounts[matchRisk] += 1;

    const outcome = (row.outcome ?? "").trim() || null;
    if (outcome?.toLowerCase() === "positive") positive += 1;

    matched.push({
      id: String(row.no ?? matched.length + 1),
      occupation: row.occupation?.name?.trim() || applicant.occupationTitle,
      degree: past.degree,
      university: past.university,
      country: past.country,
      // Fall back to slight when datasheet risk is missing so the row stays usable.
      matchRisk: matchRisk ?? "slight_risk",
      outcome,
      verifiedDate: formatVerifiedDate(row.verified),
    });
  }

  const riskOrder: Record<PrecedentRiskLevel, number> = {
    no_risk: 0,
    slight_risk: 1,
    high_risk: 2,
  };
  matched.sort(
    (a, b) => riskOrder[a.matchRisk] - riskOrder[b.matchRisk],
  );

  const matchingCases = matched.length;
  const positiveOutcomeRate =
    matchingCases > 0
      ? Math.round((positive / matchingCases) * 1000) / 10
      : 0;

  return {
    matchingCases,
    positiveOutcomeRate,
    overallRisk: mostCommonRisk(riskCounts),
    riskCounts,
    cases: matched,
  };
}

export function emptyPrecedentCheck(): PrecedentCheck {
  return {
    matchingCases: 0,
    positiveOutcomeRate: 0,
    overallRisk: null,
    riskCounts: { no_risk: 0, slight_risk: 0, high_risk: 0 },
    cases: [],
  };
}
