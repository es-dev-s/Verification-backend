import { getRedis } from "./redis.js";

/** Sliding 60s window counter. Returns true if under limit. */
export async function checkRateLimit(
  key: string,
  limit: number,
  windowSeconds = 60,
): Promise<{ ok: boolean; remaining: number }> {
  const redis = getRedis();
  const fullKey = `rl:${key}`;
  const count = await redis.incr(fullKey);
  if (count === 1) {
    await redis.expire(fullKey, windowSeconds);
  }
  return { ok: count <= limit, remaining: Math.max(0, limit - count) };
}

/** Soft global parse spacing via Redis. High RPM ≈ almost no wait. */
export async function acquireParseSlot(rpm: number): Promise<void> {
  if (rpm <= 0) return;
  const redis = getRedis();
  const key = "parse:rpm";
  const windowMs = 60_000;
  const minGap = Math.ceil(windowMs / Math.max(rpm, 1));
  // Skip waiting when gap is under 200ms (effectively uncapped for autofill)
  if (minGap <= 200) {
    await redis.set(key, String(Date.now()), "PX", windowMs);
    return;
  }

  for (let attempt = 0; attempt < 10; attempt++) {
    const now = Date.now();
    const lastRaw = await redis.get(key);
    const last = lastRaw ? Number(lastRaw) : 0;
    const wait = last + minGap - now;
    if (wait <= 0) {
      await redis.set(key, String(now), "PX", windowMs);
      return;
    }
    await new Promise((r) => setTimeout(r, Math.min(wait, 1000)));
  }
  // Don't fail the Read — proceed anyway
  await redis.set(key, String(Date.now()), "PX", windowMs);
}
