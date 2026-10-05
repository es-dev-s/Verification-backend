import { config as loadDotenv } from "dotenv";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const apiRoot = resolve(__dirname, "..");

loadDotenv({ path: resolve(apiRoot, ".env") });

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

export const config = {
  port: intEnv("PORT", 3001),
  databaseUrl: process.env.DATABASE_URL ?? "",
  redisUrl: process.env.REDIS_URL ?? "redis://127.0.0.1:6379",
  extractorUrl: (process.env.EXTRACTOR_URL ?? "http://localhost:5000").replace(
    /\/$/,
    "",
  ),
  maxUploadBytes: intEnv("MAX_UPLOAD_BYTES", 10 * 1024 * 1024),
  blobTtlSeconds: intEnv("BLOB_TTL_SECONDS", 3600),
  // PaddleOCR on CPU often needs several minutes per scanned transcript page.
  extractTimeoutMs: intEnv("EXTRACT_TIMEOUT_MS", 900_000),
  parseTimeoutMs: intEnv("PARSE_TIMEOUT_MS", 10_000),
  extractAttempts: intEnv("EXTRACT_ATTEMPTS", 3),
  stuckExtractMinutes: intEnv("STUCK_EXTRACT_MINUTES", 20),
  uploadsPerMinute: intEnv("UPLOADS_PER_MINUTE", 20),
  readsPerMinute: intEnv("READS_PER_MINUTE", 30),
  maxInFlightJobsPerCase: intEnv("MAX_IN_FLIGHT_JOBS_PER_CASE", 4),
  parseRpm: intEnv("PARSE_RPM", 60),
  extractConcurrency: intEnv("EXTRACT_CONCURRENCY", 2),
  geminiModels: (
    process.env.GEMINI_MODEL_FALLBACKS ??
    process.env.GEMINI_MODEL ??
    "gemini-3.8-flash,gemini-flash-latest"
  )
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
};

export function blobKey(documentId: string): string {
  return `doc:bytes:${documentId}`;
}
