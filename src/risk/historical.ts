import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { HistoricalStats } from "./schemas.js";

type DatasheetCase = {
  occupation?: { anzscoCode?: string | null };
  recommendedAnzsco?: Array<{ anzscoCode?: string | null }>;
  outcome?: string | null;
};

type DatasheetFile = {
  cases?: DatasheetCase[];
};

type IndexedStats = {
  total: number;
  positive: number;
  negative: number;
  banned: number;
};

let cache: Map<string, IndexedStats> | null = null;

function datasheetPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "../lib/verification_datasheet.json");
}

function normalizeCode(code: string): string {
  return code.replace(/\s+/g, "").replace(/PE$/i, "").trim();
}

function loadIndex(): Map<string, IndexedStats> {
  if (cache) return cache;

  const raw = JSON.parse(
    readFileSync(datasheetPath(), "utf8"),
  ) as DatasheetFile;
  const map = new Map<string, IndexedStats>();

  for (const row of raw.cases ?? []) {
    const primary = row.occupation?.anzscoCode;
    if (!primary) continue;
    const code = normalizeCode(primary);
    const outcome = (row.outcome ?? "").trim().toLowerCase();
    const cur = map.get(code) ?? {
      total: 0,
      positive: 0,
      negative: 0,
      banned: 0,
    };
    cur.total += 1;
    if (outcome === "positive") cur.positive += 1;
    else if (outcome === "negative") cur.negative += 1;
    else if (outcome === "banned") cur.banned += 1;
    map.set(code, cur);
  }

  cache = map;
  return map;
}

/**
 * Historical alignment score from positive outcomes for an ANZSCO.
 * Neutral 50 when no comparable cases exist.
 */
export function historicalStatsForAnzsco(anzscoCode: string): HistoricalStats {
  const idx = loadIndex().get(normalizeCode(anzscoCode));
  if (!idx || idx.total === 0) {
    return {
      totalCases: 0,
      positive: 0,
      negative: 0,
      banned: 0,
      positivePct: 50,
    };
  }

  const positivePct = Math.round((idx.positive / idx.total) * 1000) / 10;
  return {
    totalCases: idx.total,
    positive: idx.positive,
    negative: idx.negative,
    banned: idx.banned,
    positivePct,
  };
}

/** Past-case count at which the historical score is used as-is. */
export const HISTORICAL_FULL_WEIGHT_CASES = 5;
/** Score a thin history is blended toward. */
export const HISTORICAL_NEUTRAL_PCT = 50;

/**
 * Fewer than 5 past cases: blend the historical score toward 50% in proportion
 * to the case count. One case at 100% becomes 60, not 100. Five or more are
 * unchanged. No cases stay at 50.
 */
export function blendSparseHistory(pct: number, totalCases: number): number {
  const n = Number.isFinite(totalCases) ? Math.max(0, totalCases) : 0;
  if (n >= HISTORICAL_FULL_WEIGHT_CASES) return pct;
  const weight = n / HISTORICAL_FULL_WEIGHT_CASES;
  return Math.round((weight * pct + (1 - weight) * HISTORICAL_NEUTRAL_PCT) * 10) / 10;
}
