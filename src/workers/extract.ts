import { config } from "../config.js";
import { deleteBlob, loadBlob } from "../lib/blob.js";
import { formatToExt, formatToMime } from "../lib/formats.js";
import { prisma } from "../lib/prisma.js";
import { correctOcrEducationText } from "../parse/ocrCorrect.js";
import type { DocumentFormat } from "@prisma/client";

export type ExtractorResult = {
  ok: boolean;
  raw_text?: string;
  method?: string;
  ocr_confidence?: number | null;
  warnings?: string[];
  error?: string;
};

export async function processExtractJob(documentId: string): Promise<void> {
  const doc = await prisma.document.findUnique({ where: { id: documentId } });
  if (!doc) return;

  await prisma.document.update({
    where: { id: documentId },
    data: { status: "EXTRACTING", error: null },
  });

  let bytes: Buffer | null = null;
  try {
    bytes = await loadBlob(documentId);
    if (!bytes) {
      await prisma.document.update({
        where: { id: documentId },
        data: {
          status: "FAILED",
          error: "please re-upload",
        },
      });
      return;
    }

    const result = await callExtractor(bytes, doc.format, doc.originalName);
    if (!result.ok || !(result.raw_text ?? "").trim()) {
      await prisma.document.update({
        where: { id: documentId },
        data: {
          status: "FAILED",
          error: result.error ?? "Extraction produced no text",
          text: result.raw_text ?? null,
          extractionMethod: result.method ?? null,
          ocrConfidence:
            result.ocr_confidence != null ? result.ocr_confidence : null,
        },
      });
      return;
    }

    const { text: cleaned } = correctOcrEducationText(
      result.raw_text ?? "",
      documentId,
    );

    await prisma.document.update({
      where: { id: documentId },
      data: {
        status: "DONE",
        text: cleaned,
        extractionMethod: result.method ?? "unknown",
        ocrConfidence:
          result.ocr_confidence != null ? result.ocr_confidence : null,
        error: null,
      },
    });

    await markReadsStale(doc.caseId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await prisma.document.update({
      where: { id: documentId },
      data: { status: "FAILED", error: message },
    });
    throw err;
  } finally {
    await deleteBlob(documentId).catch(() => undefined);
  }
}

async function callExtractor(
  bytes: Buffer,
  format: DocumentFormat,
  originalName: string,
): Promise<ExtractorResult> {
  const form = new FormData();
  const blob = new Blob([new Uint8Array(bytes)], {
    type: formatToMime(format),
  });
  const filename = originalName.includes(".")
    ? originalName
    : `${originalName}${formatToExt(format)}`;
  form.append("file", blob, filename);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.extractTimeoutMs);
  try {
    const res = await fetch(`${config.extractorUrl}/extract-text`, {
      method: "POST",
      body: form,
      signal: controller.signal,
    });
    const json = (await res.json()) as ExtractorResult & { error?: string };
    if (!res.ok) {
      return {
        ok: false,
        error: json.error ?? `Extractor HTTP ${res.status}`,
      };
    }
    return json;
  } catch (err) {
    const message =
      err instanceof Error && err.name === "AbortError"
        ? "Extraction timed out"
        : err instanceof Error
          ? err.message
          : String(err);
    return { ok: false, error: message };
  } finally {
    clearTimeout(timer);
  }
}

export async function markReadsStale(caseId: string): Promise<void> {
  await prisma.readJob.updateMany({
    where: { caseId, stale: false },
    data: { stale: true },
  });
}
