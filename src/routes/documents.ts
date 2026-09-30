import type { FastifyPluginAsync } from "fastify";
import { DegreeLevel, DocumentType } from "@prisma/client";
import { config } from "../config.js";
import { deleteBlob, sha256, storeBlob } from "../lib/blob.js";
import { detectFormatFromBytes } from "../lib/formats.js";
import { prisma } from "../lib/prisma.js";
import { getExtractQueue } from "../lib/queues.js";
import { checkRateLimit } from "../lib/rateLimit.js";
import { markReadsStale } from "../workers/extract.js";

const DEGREE_LEVELS = new Set<string>(Object.values(DegreeLevel));

function fieldValue(
  fields: Record<string, { value?: string } | Array<{ value?: string }> | undefined>,
  ...keys: string[]
): string {
  for (const key of keys) {
    const t = fields[key];
    if (!t) continue;
    if (Array.isArray(t)) return String(t[0]?.value ?? "");
    return String(t.value ?? "");
  }
  return "";
}

function parseDegreeLevel(raw: string): DegreeLevel | null {
  const normalized = raw.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (!normalized) return null;
  // Accept UI labels: "Advanced Diploma" → advanced_diploma
  if (DEGREE_LEVELS.has(normalized)) return normalized as DegreeLevel;
  return null;
}

export const documentRoutes: FastifyPluginAsync = async (app) => {
  app.post("/cases/:id/documents", async (req, reply) => {
    const { id: caseId } = req.params as { id: string };
    const caseRow = await prisma.case.findFirst({
      where: { id: caseId, clientId: req.clientId },
    });
    if (!caseRow) return reply.code(404).send({ error: "Case not found" });

    const rl = await checkRateLimit(
      `upload:${req.clientId}`,
      config.uploadsPerMinute,
    );
    if (!rl.ok) {
      return reply.code(429).send({ error: "Upload rate limit exceeded" });
    }

    const inFlight = await prisma.document.count({
      where: {
        caseId,
        status: { in: ["QUEUED", "EXTRACTING"] },
      },
    });
    if (inFlight >= config.maxInFlightJobsPerCase) {
      return reply
        .code(429)
        .send({ error: "Too many jobs in flight for this case" });
    }

    const query = req.query as { type?: string; degreeLevel?: string };
    const queryType = String(query.type ?? "").toUpperCase();
    const queryDegreeLevel = String(query.degreeLevel ?? "");

    const file = await req.file();
    if (!file) {
      return reply.code(400).send({ error: "No file uploaded" });
    }

    const fields = file.fields as Record<
      string,
      { value?: string } | Array<{ value?: string }> | undefined
    >;
    const typeRaw = (
      queryType || fieldValue(fields, "type", "documentType", "docType")
    ).toUpperCase();
    if (!["CV", "TRANSCRIPT", "CERTIFICATE"].includes(typeRaw)) {
      return reply
        .code(400)
        .send({ error: "type must be CV, Transcript, or Certificate" });
    }
    const type = typeRaw as DocumentType;

    const degreeLevelRaw =
      queryDegreeLevel || fieldValue(fields, "degreeLevel", "degree_level");
    let degreeLevel: DegreeLevel | null = parseDegreeLevel(degreeLevelRaw);

    if (type === "CV") {
      if (degreeLevelRaw.trim()) {
        return reply.code(400).send({
          error: "degreeLevel must be omitted for CV uploads",
        });
      }
      degreeLevel = null;
    } else {
      // TRANSCRIPT / CERTIFICATE require a selected degree level
      if (!degreeLevel) {
        return reply.code(400).send({
          error:
            "degreeLevel is required for Transcript and Certificate (diploma | advanced_diploma | bachelor | master | phd)",
        });
      }
      const selected = caseRow.selectedDegreeLevels ?? [];
      if (!selected.includes(degreeLevel)) {
        return reply.code(400).send({
          error: `degreeLevel "${degreeLevel}" is not in this case's selectedDegreeLevels`,
          selectedDegreeLevels: selected,
        });
      }
    }

    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of file.file) {
      total += chunk.length;
      if (total > config.maxUploadBytes) {
        return reply
          .code(400)
          .send({ error: "File exceeds the 10 MB size limit" });
      }
      chunks.push(Buffer.from(chunk));
    }
    const bytes = Buffer.concat(chunks);
    if (!bytes.length) {
      return reply.code(400).send({ error: "Empty file" });
    }

    const format = detectFormatFromBytes(bytes);
    if (!format) {
      return reply.code(400).send({
        error:
          "Unrecognized file content. Accepted formats: PDF, PNG, JPG, DOCX (validated by magic bytes, not extension)",
      });
    }

    const hash = sha256(bytes);

    // CV stays singular — replace prior CV(s). Transcript/certificate keep
    // multiple ordered files per degree level (multi-page photos).
    if (type === "CV") {
      const previous = await prisma.document.findMany({
        where: { caseId, type: "CV" },
        select: { id: true },
      });
      if (previous.length) {
        const ids = previous.map((d) => d.id);
        await prisma.document.deleteMany({ where: { id: { in: ids } } });
        await Promise.all(ids.map((id) => deleteBlob(id).catch(() => undefined)));
      }
    }

    const doc = await prisma.document.create({
      data: {
        caseId,
        type,
        degreeLevel,
        originalName: file.filename || `upload.${format.toLowerCase()}`,
        format,
        sha256: hash,
        status: "QUEUED",
      },
    });

    await storeBlob(doc.id, bytes);
    await markReadsStale(caseId);
    await getExtractQueue().add(
      "extract",
      { documentId: doc.id },
      { jobId: doc.id },
    );

    return reply.code(201).send({ documentId: doc.id, document: doc });
  });

  app.delete("/cases/:id/documents/:docId", async (req, reply) => {
    const { id: caseId, docId } = req.params as {
      id: string;
      docId: string;
    };
    const caseRow = await prisma.case.findFirst({
      where: { id: caseId, clientId: req.clientId },
    });
    if (!caseRow) return reply.code(404).send({ error: "Case not found" });

    const doc = await prisma.document.findFirst({
      where: { id: docId, caseId },
    });
    if (!doc) return reply.code(404).send({ error: "Document not found" });

    await prisma.document.delete({ where: { id: docId } });
    await markReadsStale(caseId);
    return { ok: true };
  });
};
