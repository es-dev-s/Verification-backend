export type DurationResult = {
  years: number | null;
  calculated: boolean;
};

/** Parse stated duration like "3 years", "6 semesters", "4 yrs". */
export function parseStatedDuration(stated: string | null | undefined): DurationResult {
  if (!stated?.trim()) return { years: null, calculated: false };
  const text = stated.toLowerCase().replace(/,/g, " ").trim();

  // SESSION / BATCH YYYY-YYYY inside statedDuration
  const session = extractYearRange(stated);
  if (session) {
    return {
      years: roundHalf(session.endYear - session.startYear),
      calculated: true,
    };
  }

  const yearMatch = text.match(/(\d+(?:\.\d+)?)\s*(?:years?|yrs?|y\b)/);
  if (yearMatch) {
    return { years: roundHalf(Number(yearMatch[1])), calculated: false };
  }

  const semMatch = text.match(/(\d+(?:\.\d+)?)\s*(?:semesters?|terms?)/);
  if (semMatch) {
    return { years: roundHalf(Number(semMatch[1]) / 2), calculated: true };
  }

  const monthMatch = text.match(/(\d+(?:\.\d+)?)\s*(?:months?|mos?)/);
  if (monthMatch) {
    return { years: roundHalf(Number(monthMatch[1]) / 12), calculated: true };
  }

  return { years: null, calculated: false };
}

export function durationFromDates(
  start: string | null | undefined,
  end: string | null | undefined,
): DurationResult {
  // If either field embeds SESSION/BATCH YYYY-YYYY, prefer that range
  const fromStart = extractYearRange(start);
  const fromEnd = extractYearRange(end);
  const range = fromStart ?? fromEnd;
  if (range && !looksLikeAdminDayStamp(start) && !looksLikeAdminDayStamp(end)) {
    // Only use embedded range when the other side isn't a conflicting full date pair
    if (
      (fromStart && !end?.trim()) ||
      (fromEnd && !start?.trim()) ||
      (fromStart && fromEnd && fromStart.startYear === fromEnd.startYear) ||
      (fromStart && parseLooseDate(end)?.year === fromStart.endYear) ||
      (fromEnd && parseLooseDate(start)?.year === fromEnd.startYear)
    ) {
      return {
        years: roundHalf(range.endYear - range.startYear),
        calculated: true,
      };
    }
  }

  // Year-only pair: 2019 + 2023 → 4 years
  const a = parseLooseDate(start);
  const b = parseLooseDate(end, true);
  if (!a || !b) {
    // One field may be "2019-2023" alone
    if (range) {
      return {
        years: roundHalf(range.endYear - range.startYear),
        calculated: true,
      };
    }
    return { years: null, calculated: false };
  }

  // Prefer calendar-year difference when both look year-only (month/day defaulted to 1)
  const startYearOnly = isYearOnly(start);
  const endYearOnly = isYearOnly(end);
  if (startYearOnly && endYearOnly) {
    const years = b.year - a.year;
    if (years < 0) return { years: null, calculated: false };
    return { years: roundHalf(years), calculated: true };
  }

  const months =
    (b.year - a.year) * 12 + (b.month - a.month) + (b.day - a.day) / 30;
  if (months < 0) return { years: null, calculated: false };
  return { years: roundHalf(months / 12), calculated: true };
}

export function computeDuration(input: {
  statedDuration?: string | null;
  start?: string | null;
  end?: string | null;
}): DurationResult {
  const stated = parseStatedDuration(input.statedDuration);
  // Prefer explicit "N years" (not calculated-from-session inside stated) first
  if (stated.years != null && !stated.calculated && stated.years > 0) {
    return stated;
  }
  const fromDates = durationFromDates(input.start, input.end);
  if (fromDates.years != null && fromDates.years > 0) return fromDates;
  if (stated.years != null && stated.years > 0) return stated;
  return { years: null, calculated: false };
}

/** SESSION 2019-2023 / BATCH 2019–2023 / 2019-2023 */
export function extractYearRange(
  raw: string | null | undefined,
): { startYear: number; endYear: number } | null {
  if (!raw?.trim()) return null;
  const text = raw.trim();
  const m = text.match(
    /(?:session|batch)?\s*((?:19|20)\d{2})\s*[-–—/]\s*((?:19|20)\d{2})\b/i,
  );
  if (!m) return null;
  const startYear = Number(m[1]);
  const endYear = Number(m[2]);
  if (!Number.isFinite(startYear) || !Number.isFinite(endYear)) return null;
  if (endYear < startYear || endYear - startYear > 12) return null;
  return { startYear, endYear };
}

function isYearOnly(raw: string | null | undefined): boolean {
  return Boolean(raw?.trim().match(/^(?:session|batch)?\s*((?:19|20)\d{2})$/i));
}

/** Day-month stamps like 16-AUG-23 / 05-Jan-2024 — not enrollment years. */
function looksLikeAdminDayStamp(raw: string | null | undefined): boolean {
  if (!raw?.trim()) return false;
  return /\d{1,2}[-/\s][A-Za-z]{3,9}[-/\s](?:\d{2}|\d{4})\b/.test(raw);
}

function roundHalf(n: number): number {
  return Math.round(n * 2) / 2;
}

function parseLooseDate(
  raw: string | null | undefined,
  allowPresent = false,
): { year: number; month: number; day: number } | null {
  if (!raw?.trim()) return null;
  const text = raw.trim();
  if (allowPresent && /present|current|ongoing|now/i.test(text)) {
    const now = new Date();
    return { year: now.getFullYear(), month: now.getMonth() + 1, day: now.getDate() };
  }

  // Prefer year range start/end when the whole string is a range
  const range = extractYearRange(text);
  if (range && /^(?:session|batch)?\s*(?:19|20)\d{2}\s*[-–—/]\s*(?:19|20)\d{2}$/i.test(text)) {
    // Ambiguous which end — callers should use extractYearRange instead
    return { year: range.startYear, month: 1, day: 1 };
  }

  const iso = text.match(/^(\d{4})-(\d{1,2})(?:-(\d{1,2}))?/);
  if (iso) {
    return {
      year: Number(iso[1]),
      month: Number(iso[2]),
      day: Number(iso[3] ?? 1),
    };
  }

  const yearOnly = text.match(/^(?:session|batch)?\s*((?:19|20)\d{2})$/i);
  if (yearOnly) {
    return { year: Number(yearOnly[1]), month: 1, day: 1 };
  }

  const months: Record<string, number> = {
    jan: 1,
    january: 1,
    feb: 2,
    february: 2,
    mar: 3,
    march: 3,
    apr: 4,
    april: 4,
    may: 5,
    jun: 6,
    june: 6,
    jul: 7,
    july: 7,
    aug: 8,
    august: 8,
    sep: 9,
    sept: 9,
    september: 9,
    oct: 10,
    october: 10,
    nov: 11,
    november: 11,
    dec: 12,
    december: 12,
  };

  const my = text.match(
    /^([A-Za-z]+)\.?\s+(\d{4})$|^(\d{1,2})[\/\-](\d{4})$/,
  );
  if (my) {
    if (my[1] && my[2]) {
      const m = months[my[1].toLowerCase()];
      if (m) return { year: Number(my[2]), month: m, day: 1 };
    }
    if (my[3] && my[4]) {
      return { year: Number(my[4]), month: Number(my[3]), day: 1 };
    }
  }

  // Do not treat 2-digit year stamps (16-AUG-23) as program years
  if (looksLikeAdminDayStamp(text)) {
    return null;
  }

  const yearIn = text.match(/(19|20)\d{2}/);
  if (yearIn) {
    return { year: Number(yearIn[0]), month: 1, day: 1 };
  }
  return null;
}
