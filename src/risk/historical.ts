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
