import { assessConfig } from "./config.js";
import type { QualificationInfo } from "./qualificationCheck.js";

export const QUALIFICATION_YEAR_MISSING_NOTE = "Qualification year not found";

const YEAR_RE = /\b((?:19|20)\d{2})\b/g;

function clampYear(n: number): number | null {
  if (!Number.isFinite(n)) return null;
  const y = Math.trunc(n);
  if (y < 1950 || y > 2100) return null;
  return y;
}

/**
 * Completion year from printed graduation / session-end text (last year in a
 * range). Returns null when nothing readable is present.
 */
export function parseCompletionYear(
  ...chunks: Array<string | number | null | undefined>
): number | null {
  for (const chunk of chunks) {
    if (chunk == null || chunk === "") continue;
    if (typeof chunk === "number") {
      const y = clampYear(chunk);
      if (y) return y;
      continue;
    }
    const text = String(chunk);
    const grad = text.match(
      /\b(?:date\s+of\s+graduation|successfully\s+completed[^\n]{0,80}?on|month\s*&\s*year\s+of\s+final\s+exam|graduated)\s*[:\-.]?\s*[^\n]{0,40}?((?:19|20)\d{2})/i,
    );
    if (grad?.[1]) {
      const y = clampYear(Number(grad[1]));
      if (y) return y;
    }
    const session = text.match(
      /\b(?:session|batch)\s*[:\-.]?\s*(?:19|20)\d{2}\s*[-–—/to]+\s*((?:19|20)\d{2})/i,
    );
    if (session?.[1]) {
      const y = clampYear(Number(session[1]));
      if (y) return y;
    }
    const years = [...text.matchAll(YEAR_RE)].map((m) => Number(m[1]));
    if (years.length === 1) {
      const y = clampYear(years[0]!);
      if (y) return y;
    }
    if (years.length >= 2) {
      const y = clampYear(years[years.length - 1]!);
      if (y) return y;
    }
  }
  return null;
}

function isBachelorLike(q: QualificationInfo): boolean {
  const raw = (q.rawLevel ?? "").toLowerCase();
  if (raw === "bachelor") return true;
  return q.level === "bachelor";
}

/** Same preference as field-of-study: bachelor when both bachelor and master are on file. */
export function scoringQualification(
  quals: readonly QualificationInfo[],
): QualificationInfo | null {
  if (!quals.length) return null;
  const titled = quals.filter(
    (q) => (q.title ?? "").trim() || (q.fieldOfStudy ?? "").trim() || q.completionYear != null,
  );
  const pool = titled.length ? titled : [...quals];
  return pool.find(isBachelorLike) ?? pool[0] ?? null;
}

export type QualificationYearInfo = {
  year: number | null;
  missing: boolean;
  sourceTitle: string | null;
};

export function completionYearOf(
  quals: readonly QualificationInfo[],
): QualificationYearInfo {
  const q = scoringQualification(quals);
  if (!q) return { year: null, missing: true, sourceTitle: null };
  const year =
    clampYear(q.completionYear as number) ??
    parseCompletionYear(q.completionYear, ...(q.texts ?? []));
  return {
    year,
    missing: year == null,
    sourceTitle: (q.title ?? "").trim() || null,
  };
}

export type YearMultiplierBand = "pre2000" | "2000_2010" | "current" | "missing";

export function yearMultiplier(year: number | null | undefined): {
  factor: number;
  band: YearMultiplierBand;
} {
  const cfg = assessConfig.academicAlignment;
  if (year == null) return { factor: 1, band: "missing" };
  if (year < cfg.yearCutPre2000) {
    return { factor: cfg.yearMultiplierPre2000, band: "pre2000" };
  }
  if (year <= cfg.yearCutThrough2010) {
    return { factor: cfg.yearMultiplier2000To2010, band: "2000_2010" };
  }
  return { factor: 1, band: "current" };
}
