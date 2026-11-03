import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  chunkCountFor,
  classifyExtractError,
  extractChunkWithRetry,
  extractSubjectsDetailed,
} from "./extractSubjects.js";
import { partialFromSaved, partialReportOf, PARTIAL_HASH_PREFIX } from "./transcriptData.js";

const K1 = { name: "K1", value: "x" };
const K2 = { name: "K2", value: "y" };
const NO_WAIT = { rateLimited: 1, other: 1 };
const far = () => Date.now() + 60_000;

function pagesText(n: number): string {
  return Array.from({ length: n }, (_, i) => `--- page ${i + 1} ---\nSubject P${i + 1}A\nSubject P${i + 1}B`).join("\n");
}

/** Fake Groq read: returns one subject per "Subject …" line in the chunk. */
function reader(failOn: (chunk: string, key: string, attempt: number) => Error | null) {
  const seen = new Map<string, number>();
  const calls: string[] = [];
  const call = async (chunk: string, key: { name: string }) => {
    const n = (seen.get(chunk) ?? 0) + 1;
    seen.set(chunk, n);
    calls.push(key.name);
    const err = failOn(chunk, key.name, n);
    if (err) throw err;
    return { subjects: [...chunk.matchAll(/Subject (\S+)/g)].map((m) => ({ name: `Subject ${m[1]}` })) };
  };
  return { call, calls };
}

describe("transcript chunk retry", () => {
  it("classifies 429, cut-off, empty, invalid JSON and timeouts", () => {
    assert.equal(classifyExtractError(new Error("Groq rate limited on K1: slow down")), "rate_limited");
    assert.equal(classifyExtractError(new Error("Groq response truncated (finish_reason=length) on K1")), "cut_off");
    assert.equal(classifyExtractError(new Error("Empty Groq response on K1")), "empty");
    assert.equal(classifyExtractError(new Error("Invalid JSON from Groq on K1: Unexpected end")), "invalid_json");
    assert.equal(classifyExtractError(new Error("Groq request timed out after 60000ms on K1")), "timeout");
  });

  it("a failed chunk is retried on another key", async () => {
    const r = reader((_c, key) => (key === "K1" ? new Error("Groq rate limited on K1") : null));
    const out = await extractChunkWithRetry("Subject A", K1, [K1, K2], far(), { call: r.call, backoffMs: NO_WAIT });
    assert.equal(out.ok, true);
    assert.deepEqual(r.calls, ["K1", "K2"]);
  });

  it("with one key the chunk is retried on the same key after a backoff", async () => {
    const r = reader((_c, _k, n) => (n === 1 ? new Error("Empty Groq response on K1") : null));
    const out = await extractChunkWithRetry("Subject A", K1, [K1], far(), { call: r.call, backoffMs: NO_WAIT });
    assert.equal(out.ok, true);
    assert.deepEqual(r.calls, ["K1", "K1"]);
    assert.deepEqual(out.attempts, [{ key: "K1", reason: "empty" }]);
  });

  it("a chunk that keeps failing makes the read partial (never silently dropped)", async () => {
    const text = pagesText(4);
    const r = reader((chunk) => (chunk.includes("P3A") ? new Error("Groq response truncated (finish_reason=length) on K") : null));
    const out = await extractSubjectsDetailed([{ documentId: "d1", text }], {
      keys: [K1, K2],
      call: r.call,
      backoffMs: NO_WAIT,
      deadlineMs: far(),
    });
    assert.equal(out.partial, true);
    assert.equal(out.failedChunks.length, 1);
    assert.equal(out.failedChunks[0]!.reason, "cut_off");
    assert.deepEqual(out.failedChunks[0]!.pages, [3, 4]);
    // Pages 1–2 were read.
    assert.deepEqual(out.rows.map((x) => x.name).sort(), ["Subject P1A", "Subject P1B", "Subject P2A", "Subject P2B"]);
  });

  it("a complete read is not partial", async () => {
    const r = reader(() => null);
    const out = await extractSubjectsDetailed([{ documentId: "d1", text: pagesText(3) }], {
      keys: [K1],
      call: r.call,
      deadlineMs: far(),
    });
    assert.equal(out.partial, false);
    assert.equal(out.rows.length, 6);
  });

  it("long documents are split even with a single key", async () => {
    assert.equal(chunkCountFor(40_000, 1, 14_000), 3);
    assert.equal(chunkCountFor(5_000, 1, 14_000), 1);
    assert.equal(chunkCountFor(5_000, 3, 14_000), 3);
    const r = reader(() => null);
    const out = await extractSubjectsDetailed([{ documentId: "d1", text: pagesText(6) }], {
      keys: [K1],
      call: r.call,
      deadlineMs: far(),
      maxChunkChars: 60,
    });
    assert.ok(r.calls.length >= 3, `expected ≥3 requests, got ${r.calls.length}`);
    assert.equal(out.rows.length, 12);
  });
});

describe("partial read record", () => {
  it("collects pages and reasons", () => {
    const p = partialReportOf([
      { pages: [4, 3], reason: "cut_off" },
      { pages: [3], reason: "rate_limited" },
    ]);
    assert.deepEqual(p, { failedChunks: 2, pages: [3, 4], reasons: ["cut_off", "rate_limited"] });
  });

  it("a saved partial hash is read back and never equals a real hash", () => {
    assert.equal(partialFromSaved("abc", "abc"), null);
    const saved = partialFromSaved(`${PARTIAL_HASH_PREFIX}abc`, JSON.stringify({ failedChunks: 1, pages: [2], reasons: ["empty"] }));
    assert.deepEqual(saved, { failedChunks: 1, pages: [2], reasons: ["empty"] });
  });
});
