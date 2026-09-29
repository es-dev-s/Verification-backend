import { createHash } from "node:crypto";
import { getRedis } from "./redis.js";
import { blobKey, config } from "../config.js";

export function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

export function hashText(...parts: string[]): string {
  return createHash("sha256").update(parts.join("|")).digest("hex");
}

export async function storeBlob(
  documentId: string,
  bytes: Buffer,
): Promise<void> {
  const redis = getRedis();
  await redis.set(
    blobKey(documentId),
    bytes.toString("base64"),
    "EX",
    config.blobTtlSeconds,
  );
}

export async function loadBlob(documentId: string): Promise<Buffer | null> {
  const redis = getRedis();
  const raw = await redis.get(blobKey(documentId));
  if (!raw) return null;
  return Buffer.from(raw, "base64");
}

export async function deleteBlob(documentId: string): Promise<void> {
  const redis = getRedis();
  await redis.del(blobKey(documentId));
}
